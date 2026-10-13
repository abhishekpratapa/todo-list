// A stand-in for the Mac, for testing the app's own behaviour: it keeps a list of
// tasks and answers the requests the app makes, with the same rules that matter
// here (revisions, conflicts, a token that can be revoked, being unreachable).
// The real server is tested against in TodosKit's integration tests.

import Foundation
@testable import TodosKit

final class FakeMac: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [TodoTask] = []
    private var listVersion = 1
    private var nextID = 1
    private var sent: [URLRequest] = []
    private var unreachable = false
    private var revoked = false
    private var revision = 5

    // Habits, kept just well enough for the app's own behaviour: which slots are checked in,
    // by which check-ins, and a streak that counts today once it is complete. The real
    // rules are the Mac's, and are tested against the real server in TodosKit.
    private var habits: [Habit] = []
    private var streaksBefore: [Int: Int] = [:]
    private var habitVersion = 1
    private var zone = TimeZone.current.identifier
    private var nextCheckin = 1
    /// Check-ins the Mac has recorded: the key each was sent with, if any, and where it went.
    private var checkins: [(id: Int, key: String?, habit: Int, slot: String?, day: Day)] = []
    private var refusal: String?

    // MARK: What a test does to the Mac

    @discardableResult
    func add(_ title: String, _ change: (inout TodoTask) -> Void = { _ in }) -> TodoTask {
        lock.withLock {
            var task = TodoTask(id: nextID, title: title, activity: [])
            nextID += 1
            change(&task)
            tasks.append(task)
            listVersion += 1
            return task
        }
    }

    /// A change made on the Mac itself, by the user or a Claude session.
    func edit(_ id: Int, by: String = "Claude Code · repo", _ change: (inout TodoTask) -> Void) {
        lock.withLock {
            guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
            change(&tasks[index])
            tasks[index].rev += 1
            tasks[index].activity?.append(ActivityEntry(at: Date(), by: by, kind: .event, text: "changed it"))
            listVersion += 1
        }
    }

    func delete(_ id: Int) {
        lock.withLock {
            tasks.removeAll { $0.id == id }
            listVersion += 1
        }
    }

    // MARK: Habits on the Mac

    /// A habit with these slots (none, for one counted in weeks), on a streak of `streak` before today.
    @discardableResult
    func addHabit(_ name: String, slots: [String] = ["morning", "evening"], weekly target: Int? = nil, streak: Int = 0) -> Habit {
        lock.withLock {
            let today = HabitClock.day(of: Date(), zone: .current, dayStart: .defaultDayStart)
            let schedule: HabitSchedule = target.map { .weekly(target: $0, remind: nil) } ?? .daily(slots: slots.map { HabitSlot(id: $0, name: $0.capitalized, remind: ClockTime("09:00")) })
            let day = { (day: Day) in target == nil ? HabitDay(day: day, state: .open, slots: slots.map { HabitDay.Slot(id: $0) }) : HabitDay(day: day, state: .open, isSession: true) }
            var yesterday = day(today.adding(days: -1))
            yesterday.state = streak > 0 ? .done : .open
            for index in yesterday.slots.indices where streak > 0 { yesterday.slots[index].done = true }
            let habit = Habit(id: nextID, name: name, schedule: schedule, today: day(today), yesterday: yesterday,
                              week: target.map { HabitWeek(start: today.weekStart, state: .open, count: 0, target: $0, days: []) },
                              streak: HabitStreak(current: streak, best: streak, unit: target == nil ? .days : .weeks), skipsLeft: 2)
            nextID += 1
            habits.append(habit)
            streaksBefore[habit.id] = streak
            // A streak means yesterday was done: by check-ins like any other day's.
            if streak > 0 {
                for slot in yesterday.slots {
                    checkins.append((nextCheckin, nil, habit.id, slot.id, yesterday.day))
                    nextCheckin += 1
                }
                settle(habits.count - 1)
            }
            habitVersion += 1
            return habits[habits.count - 1]
        }
    }

    /// A check-in made on the Mac itself, or by another device.
    func checkIn(_ id: Int, slot: String?) {
        lock.withLock {
            guard let index = habits.firstIndex(where: { $0.id == id }) else { return }
            record(nil, habit: index, slot: slot, day: habits[index].today.day)
        }
    }

    func habit(_ id: Int) -> Habit? { lock.withLock { habits.first { $0.id == id } } }
    var allHabits: [Habit] { lock.withLock { habits } }
    var habitsVersion: Int { lock.withLock { habitVersion } }
    /// How many check-ins the Mac has for today, across every habit.
    var recordedCheckins: Int { lock.withLock { checkins.filter { entry in habits.contains { $0.id == entry.habit && $0.today.day == entry.day } }.count } }

    /// The time zone the Mac is telling "today" by.
    var habitZone: String {
        get { lock.withLock { zone } }
        set { lock.withLock { zone = newValue } }
    }

    /// When set, check-ins are refused with this message, as the Mac refuses one that is too late.
    var refusesCheckIns: String? {
        get { lock.withLock { refusal } }
        set { lock.withLock { refusal = newValue } }
    }

    private func record(_ key: String?, habit index: Int, slot: String?, day: Day) {
        checkins.append((nextCheckin, key, habits[index].id, slot, day))
        nextCheckin += 1
        settle(index)
    }

    /// Works out again how a habit's two days stand from the check-ins recorded.
    private func settle(_ index: Int) {
        let id = habits[index].id
        func settled(_ day: HabitDay) -> HabitDay {
            var day = day
            let its = checkins.filter { $0.habit == id && $0.day == day.day }
            if day.isSession {
                day.checkins = its.map(\.id)
                day.state = its.isEmpty ? .open : .done
            } else {
                for slot in day.slots.indices {
                    let ids = its.filter { $0.slot == day.slots[slot].id }.map(\.id)
                    day.slots[slot] = HabitDay.Slot(id: day.slots[slot].id, done: !ids.isEmpty, at: ids.isEmpty ? nil : Date(timeIntervalSince1970: 1_800_000_000), by: ids.isEmpty ? nil : "me", checkins: ids)
                }
                if day.state != .skipped || day.slots.allSatisfy(\.done) { day.state = day.slots.allSatisfy(\.done) ? .done : .open }
            }
            return day
        }
        let wasDoneYesterday = habits[index].yesterday.state == .done
        habits[index].today = settled(habits[index].today)
        habits[index].yesterday = settled(habits[index].yesterday)
        if var week = habits[index].week {
            week.days = Set(checkins.filter { $0.habit == id }.map(\.day)).sorted()
            week.count = week.days.count
            week.state = week.count >= week.target ? .met : .open
            habits[index].week = week
            habits[index].streak.current = (streaksBefore[id] ?? 0) + (week.state == .met ? 1 : 0)
        } else {
            let yesterday = habits[index].yesterday.state == .done
            // The streak before today counted yesterday if it was done when the habit was made.
            let base = (streaksBefore[id] ?? 0) + (yesterday && !wasDoneYesterday ? 1 : 0) - (!yesterday && wasDoneYesterday ? 1 : 0)
            streaksBefore[id] = base
            habits[index].streak.current = base + (habits[index].today.state == .done ? 1 : 0)
        }
        habits[index].streak.best = max(habits[index].streak.best, habits[index].streak.current)
        habitVersion += 1
    }

    private struct HabitAnswer: Encodable {
        var habit: Habit
    }

    /// The habit routes. Nil when the request is not for a habit.
    private func respondAboutHabits(_ request: URLRequest, _ method: String, _ parts: [String], _ body: [String: Any]) -> (Int, Data)? {
        guard parts.first == "habits" else { return nil }
        guard revision >= 5 else { return error(404, "not_found", "No such endpoint.") } // a Todos from before habits
        if parts.count == 1, method == "GET" {
            struct List: Encodable {
                var habits: [Habit]
                var zone: String
                var version: Int
            }
            return answer(200, List(habits: habits.filter { !$0.archived }, zone: zone, version: habitVersion))
        }
        if parts.count == 1, method == "POST" {
            guard let draft = try? HubJSON.decoder().decode(HabitDraft.self, from: request.httpBody ?? Data()) else { return error(400, "invalid", "A habit needs a name") }
            let today = HabitClock.day(of: Date(), zone: .current, dayStart: draft.dayStart)
            var schedule = draft.schedule
            if case .daily(let slots) = schedule { schedule = .daily(slots: slots.map { var slot = $0; slot.id = slot.name.lowercased(); return slot }) }
            let day = { (day: Day) in schedule.isWeekly ? HabitDay(day: day, state: .open, isSession: true) : HabitDay(day: day, state: .open, slots: schedule.slots.map { HabitDay.Slot(id: $0.id) }) }
            let habit = Habit(id: nextID, name: draft.name, icon: draft.icon.isEmpty ? nil : draft.icon, color: draft.color, dayStart: draft.dayStart, schedule: schedule,
                              today: day(today), yesterday: HabitDay(day: today.adding(days: -1), state: .off), skipsLeft: 2)
            nextID += 1
            habits.append(habit)
            habitVersion += 1
            return answer(201, HabitAnswer(habit: habit))
        }
        if parts == ["habits", "zone"], method == "POST" {
            zone = body["zone"] as? String ?? zone
            habitVersion += 1
            return (200, Data(#"{"zone":"\#(zone)"}"#.utf8))
        }
        guard parts.count >= 2, let id = Int(parts[1]), let index = habits.firstIndex(where: { $0.id == id }) else { return error(404, "not_found", "No habit with id #\(parts.count > 1 ? parts[1] : "")") }
        let key = request.value(forHTTPHeaderField: "Idempotency-Key")
        let day = (body["day"] as? String).flatMap(Day.init) ?? habits[index].today.day

        switch (method, parts.count > 2 ? parts[2] : "") {
        case ("GET", ""):
            return answer(200, HabitAnswer(habit: habits[index]))
        case ("PATCH", ""):
            let basedOn = request.value(forHTTPHeaderField: "If-Match") ?? ""
            if basedOn != "*", basedOn != "\"\(habits[index].rev)\"" {
                return (409, Data(#"{"error":{"code":"conflict","message":"changed","current":\#(String(decoding: try! HubJSON.encoder().encode(habits[index]), as: UTF8.self))}}"#.utf8))
            }
            if let name = body["name"] as? String { habits[index].name = name }
            if let paused = body["paused"] as? Bool { habits[index].paused = paused }
            if let archived = body["archived"] as? Bool { habits[index].archived = archived }
            habits[index].rev += 1
            habitVersion += 1
            return answer(200, HabitAnswer(habit: habits[index]))
        case ("DELETE", ""):
            habits.remove(at: index)
            habitVersion += 1
            return (204, Data())
        case ("POST", "checkins"):
            if let refusal { return error(400, "too_late", refusal) }
            if let key, checkins.contains(where: { $0.key == key }) { return answer(200, HabitAnswer(habit: habits[index])) } // sent twice: recorded once
            record(key, habit: index, slot: body["slot"] as? String, day: day)
            return answer(201, HabitAnswer(habit: habits[index]))
        case ("POST", "undo"):
            if body["skip"] as? Bool == true {
                if habits[index].today.day == day { habits[index].today.state = .open }
            } else {
                let ids = body["checkins"] as? [Int] ?? []
                let keys = body["keys"] as? [String] ?? []
                checkins.removeAll { $0.habit == id && (ids.contains($0.id) || ($0.key.map(keys.contains) ?? false)) }
            }
            settle(index)
            return answer(200, HabitAnswer(habit: habits[index]))
        case ("POST", "skips"):
            if habits[index].today.day == day, habits[index].today.state == .open { habits[index].today.state = .skipped }
            habitVersion += 1
            return answer(201, HabitAnswer(habit: habits[index]))
        default:
            return error(404, "not_found", "No such endpoint.")
        }
    }

    func task(_ id: Int) -> TodoTask? { lock.withLock { tasks.first { $0.id == id } } }
    var all: [TodoTask] { lock.withLock { tasks } }
    var version: Int { lock.withLock { listVersion } }
    var requests: [URLRequest] { lock.withLock { sent } }
    /// Requests that change something.
    var writes: [URLRequest] { requests.filter { $0.httpMethod != "GET" && $0.url?.path.hasSuffix("/preview") == false } }

    var isUnreachable: Bool {
        get { lock.withLock { unreachable } }
        set { lock.withLock { unreachable = newValue } }
    }

    var tokenRevoked: Bool {
        get { lock.withLock { revoked } }
        set { lock.withLock { revoked = newValue } }
    }

    var apiRevision: Int {
        get { lock.withLock { revision } }
        set { lock.withLock { revision = newValue } }
    }

    func client(_ credentials: HubCredentials) -> HubClient {
        HubClient(credentials: credentials, session: .shared) { [self] request in
            let (status, body) = try lock.withLock { try respond(request) }
            return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }

    // MARK: Answering

    private func error(_ status: Int, _ code: String, _ message: String) -> (Int, Data) {
        (status, Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8))
    }

    private func answer(_ status: Int, _ value: some Encodable) -> (Int, Data) {
        (status, try! HubJSON.encoder().encode(value))
    }

    private struct TaskAnswer: Encodable {
        var task: TodoTask
        var next: TodoTask?
    }

    private func respond(_ request: URLRequest) throws -> (Int, Data) {
        sent.append(request)
        if unreachable { throw URLError(.timedOut) }
        if revoked { return error(401, "unauthorized", "That access token is not valid.") }
        let method = request.httpMethod ?? "GET"
        let parts = request.url!.path.replacingOccurrences(of: "/api/v1/", with: "").split(separator: "/").map(String.init)
        let body = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]

        switch (method, parts.first, parts.count) {
        case ("GET", "meta", 1):
            return (200, Data(#"{"api":{"version":1,"revision":\#(revision)},"app":{"name":"Todos","version":"1.6.0"}}"#.utf8))

        case ("GET", "tasks", 1):
            struct List: Encodable {
                var tasks: [TodoTask]
                var total: Int
                var summary: Counts
                var version: Int
            }
            let brief = tasks.inListOrder().map { task in
                var brief = task
                brief.comments = task.commentCount
                brief.activity = nil
                return brief
            }
            return answer(200, List(tasks: brief, total: brief.count, summary: tasks.counts(today: .today()), version: listVersion))

        case ("POST", "capture", 1):
            let line = body["text"] as? String ?? ""
            let key = request.value(forHTTPHeaderField: "Idempotency-Key")
            if let key, let existing = tasks.first(where: { $0.createdBy == key }) { // sent twice: answered once
                return (201, Data(#"{"task":\#(String(decoding: try! HubJSON.encoder().encode(existing), as: UTF8.self)),"parsed":{"title":"\#(line)","fields":{}}}"#.utf8))
            }
            var task = TodoTask(id: nextID, title: line, createdBy: key ?? "me", activity: [])
            task.activity = [ActivityEntry(at: Date(), by: "me", kind: .event, text: "created this task", via: "iPhone")]
            nextID += 1
            tasks.append(task)
            listVersion += 1
            return (201, Data(#"{"task":\#(String(decoding: try! HubJSON.encoder().encode(task), as: UTF8.self)),"parsed":{"title":"\#(line)","fields":{}}}"#.utf8))

        case ("POST", "capture", 2):
            return (200, Data(#"{"title":"\#(body["text"] as? String ?? "")","fields":{}}"#.utf8))

        case ("POST", "tasks", 1): // putting a deleted task back
            var task = TodoTask(id: nextID, title: body["title"] as? String ?? "", notes: body["notes"] as? String ?? "", activity: [])
            task.priority = (body["priority"] as? String).flatMap { TaskPriority(rawValue: $0) } ?? .medium
            task.subtasks = (body["subtasks"] as? [String] ?? []).enumerated().map { Subtask(id: $0.offset + 1, title: $0.element, done: false) }
            nextID += 1
            tasks.append(task)
            listVersion += 1
            return answer(201, TaskAnswer(task: task))

        default:
            break
        }

        if let aboutHabits = respondAboutHabits(request, method, parts, body) { return aboutHabits }
        guard parts.first == "tasks", parts.count >= 2, let id = Int(parts[1]) else { return error(404, "not_found", "No such endpoint.") }
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return error(404, "not_found", "No todo with id #\(id)") }
        let basedOn = request.value(forHTTPHeaderField: "If-Match").flatMap { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "\""))) }
        func conflict() -> (Int, Data) {
            (409, Data(#"{"error":{"code":"conflict","message":"changed","current":\#(String(decoding: try! HubJSON.encoder().encode(tasks[index]), as: UTF8.self))}}"#.utf8))
        }
        func changed(_ text: String, comment: Bool = false) {
            tasks[index].rev += 1
            tasks[index].activity?.append(ActivityEntry(at: Date(), by: "me", kind: comment ? .comment : .event, text: text, via: "iPhone"))
            listVersion += 1
        }

        switch (method, parts.count, parts.count > 2 ? parts[2] : "") {
        case ("GET", 2, _):
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("PATCH", 2, _):
            guard basedOn == tasks[index].rev else { return conflict() }
            let patch = try HubJSON.decoder().decode(TaskPatch.self, from: request.httpBody ?? Data())
            tasks[index] = patch.applied(to: tasks[index])
            changed("edited it")
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("DELETE", 2, _):
            guard basedOn == tasks[index].rev else { return conflict() }
            tasks.remove(at: index)
            listVersion += 1
            return (204, Data())
        case ("POST", 3, "complete"):
            tasks[index].status = .done
            changed("moved To do → Done")
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("POST", 3, "comments"):
            changed(body["text"] as? String ?? "", comment: true)
            return answer(201, TaskAnswer(task: tasks[index]))
        case ("POST", 3, "subtasks"):
            let next = (tasks[index].subtasks.map(\.id).max() ?? 0) + 1
            tasks[index].subtasks.append(Subtask(id: next, title: body["title"] as? String ?? "", done: false))
            changed("added a subtask")
            return answer(201, TaskAnswer(task: tasks[index]))
        case ("PATCH", 4, "subtasks"):
            guard let subtask = tasks[index].subtasks.firstIndex(where: { $0.id == Int(parts[3]) }) else { return error(404, "not_found", "Task #\(id) has no subtask \(parts[3])") }
            if let done = body["done"] as? Bool { tasks[index].subtasks[subtask].done = done }
            changed("changed a subtask")
            return answer(200, TaskAnswer(task: tasks[index]))
        default:
            return error(404, "not_found", "No such endpoint.")
        }
    }
}
