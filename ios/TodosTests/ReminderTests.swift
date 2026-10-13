// Reminders on the phone: keeping what is waiting in line with the plan, within
// what iOS will keep, and the Done and Snooze buttons on a habit's reminder.
// The notification centre is a stand-in that counts; the plan itself is tested in TodosKit.

import Foundation
import Testing
@testable import Todos
@testable import TodosKit

/// A notification centre that remembers what it was asked to do.
final class FakeCentre: NotificationCentre, @unchecked Sendable {
    private let lock = NSLock()
    private var state = NotificationPermission.allowed
    private var answer = true
    private var _asked = 0
    private var _pending: [String: WaitingNotification] = [:]
    private var _planned: [String: PlannedNotification] = [:]
    private var _snoozes: [String: TimeInterval] = [:]
    private var _shown: Set<String> = []
    private var _said: [String] = []
    private var _cancelled: [String] = []
    private var _most = 0

    var asked: Int { lock.withLock { _asked } }
    var pending: [String: WaitingNotification] { lock.withLock { _pending } }
    var planned: [String: PlannedNotification] { lock.withLock { _planned } }
    var snoozes: [String: TimeInterval] { lock.withLock { _snoozes } }
    var shown: Set<String> { lock.withLock { _shown } }
    var said: [String] { lock.withLock { _said } }
    var cancelled: [String] { lock.withLock { _cancelled } }
    /// The most that were ever waiting at once.
    var most: Int { lock.withLock { _most } }

    func set(_ state: NotificationPermission, answer: Bool = true) {
        lock.withLock {
            self.state = state
            self.answer = answer
        }
    }

    /// A notification fires: it leaves the waiting ones and is on screen.
    func fire(_ id: String) {
        lock.withLock {
            _pending[id] = nil
            _shown.insert(id)
        }
    }

    func permission() async -> NotificationPermission { lock.withLock { state } }

    func askPermission() async -> Bool {
        lock.withLock {
            _asked += 1
            state = answer ? .allowed : .refused
            return answer
        }
    }

    func waiting() async -> [WaitingNotification] { Array(pending.values) }
    func delivered() async -> [String] { Array(shown) }

    func schedule(_ notification: PlannedNotification) async {
        lock.withLock {
            _pending[notification.id] = WaitingNotification(id: notification.id, title: notification.title, body: notification.body, stamp: notification.stamp)
            _planned[notification.id] = notification
            _most = max(_most, _pending.count)
        }
    }

    func snooze(id: String, habit: Int, title: String, body: String, after seconds: TimeInterval) async {
        lock.withLock {
            _pending[id] = WaitingNotification(id: id, title: title, body: body, stamp: "")
            _snoozes[id] = seconds
            _most = max(_most, _pending.count)
        }
    }

    func say(id: String, title: String, body: String) async { lock.withLock { _said.append(title) } }

    func cancel(_ ids: [String]) async {
        lock.withLock {
            _cancelled += ids
            for id in ids {
                _pending[id] = nil
                _shown.remove(id)
            }
        }
    }
}

@MainActor
@Suite("Reminders on the phone")
struct ReminderTests {
    let centre = FakeCentre()
    let defaults = UserDefaults(suiteName: "todos.tests.\(UUID().uuidString)")!
    let zone = TimeZone.current
    var reminders: Reminders { Reminders(centre: centre, defaults: defaults) }

    /// A moment today that is well inside a habit day whatever time the tests run at: 6 AM.
    let morning: Date = {
        let today = HabitClock.day(of: Date(), zone: .current, dayStart: .defaultDayStart)
        return Calendar.current.date(from: DateComponents(year: today.year, month: today.month, day: today.day, hour: 6))!
    }()

    /// A habit done twice a day, reminded at 7:30 and 21:30 with a nudge at 22:30, nothing done yet.
    func habit(_ id: Int, streak: Int = 0) -> Habit {
        let today = HabitClock.day(of: morning, zone: zone, dayStart: .defaultDayStart)
        let slots = [HabitSlot(id: "morning", name: "Morning", remind: ClockTime("07:30")), HabitSlot(id: "evening", name: "Evening", remind: ClockTime("21:30"), nudge: ClockTime("22:30"))]
        return Habit(id: id, name: "Habit \(id)", schedule: .daily(slots: slots), today: HabitDay(day: today, state: .open, slots: slots.map { .init(id: $0.id) }),
                     yesterday: HabitDay(day: today.adding(days: -1), state: .off), streak: HabitStreak(current: streak, best: streak, unit: .days))
    }

    func task(_ id: Int, inHours hours: Double) -> TodoTask {
        var task = TodoTask(id: id, title: "Task \(id)")
        task.remindAt = morning.addingTimeInterval(hours * 3600)
        return task
    }

    func id(_ habit: Habit, _ slot: String, nudge: Bool = false, daysAhead: Int = 0) -> String {
        PlannedNotification.identifier(habit: habit.id, slot: slot, day: habit.today.day.adding(days: daysAhead), isNudge: nudge)
    }

    @Test("habit reminders are on unless turned off, task reminders off until turned on, and neither without iOS's leave")
    func settings() async {
        let reminders = reminders
        let (brush, tasks) = (habit(1), [task(1, inHours: 5)])
        #expect(reminders.habitsEnabled && !reminders.isEnabled)
        await reminders.reschedule(tasks: tasks, habits: [brush], now: morning)
        #expect(centre.pending.keys.allSatisfy { $0.hasPrefix("habit-") }, "the task's reminder is not scheduled until asked for")
        #expect(centre.pending[id(brush, "morning")] != nil && reminders.plan?.habitsCoveredThrough != nil)

        // Every step is as of this morning, whatever time the test is run at.
        #expect(await reminders.setEnabled(true, tasks: tasks, habits: [brush], now: morning))
        #expect(centre.pending["reminder-1"] != nil)
        #expect(await reminders.setHabitsEnabled(false, tasks: tasks, habits: [brush], now: morning))
        #expect(centre.pending.keys.sorted() == ["reminder-1"], "habit reminders, and the notice with them, are gone")
        #expect(!Reminders(centre: centre, defaults: defaults).habitsEnabled, "and the choice is remembered")

        // iOS has refused: nothing can be scheduled, and turning them on says so.
        centre.set(.refused)
        #expect(await reminders.setHabitsEnabled(true, tasks: tasks, habits: [brush], now: morning) == false)
        #expect(centre.pending.isEmpty)
        // Never asked: having habits with reminder times is the moment to ask, once.
        centre.set(.notAsked)
        await reminders.askForHabits([brush], tasks: tasks, now: morning)
        #expect(centre.asked == 1 && centre.pending[id(brush, "evening")] != nil)
        await reminders.askForHabits([brush], tasks: tasks, now: morning)
        #expect(centre.asked == 1)
    }

    @Test("with many habits and task reminders, never more than 64 are waiting, day after day, and today's are never dropped")
    func withinTheLimit() async {
        let reminders = reminders
        _ = await reminders.setEnabled(true, tasks: [], habits: [])
        let habits = (1...12).map { habit($0) }
        let tasks = (1...40).map { task($0, inHours: Double($0) * 7) }
        for dayNumber in 0..<10 {
            let now = morning.addingTimeInterval(Double(dayNumber) * 86_400)
            let shown = habits.reckoned(now: now, zone: zone)
            await reminders.reschedule(tasks: tasks, habits: shown, now: now)
            let waiting = centre.pending
            #expect(waiting.count <= NotificationPlan.systemLimit - NotificationPlan.snoozeReserve, "day \(dayNumber): \(waiting.count) waiting")
            // Every reminder for today is there, the notice says where they stop, and tasks have their share.
            for habit in shown {
                #expect(waiting[id(habit, "morning")] != nil && waiting[id(habit, "evening")] != nil, "day \(dayNumber), habit \(habit.id)")
            }
            #expect(waiting[PlannedNotification.noticeIdentifier] != nil)
            #expect(waiting.keys.filter { $0.hasPrefix("reminder-") }.count >= min(24, tasks.filter { ($0.remindAt ?? now) > now }.count))
            // Time passes: what was due has fired and gone.
            for fired in centre.planned.values where fired.fireDate <= now.addingTimeInterval(86_400) { centre.fire(fired.id) }
        }
        #expect(centre.most <= NotificationPlan.systemLimit)
        #expect(reminders.plan?.isShort == false)
    }

    @Test("checking in early takes that slot's reminder and nudge away, and one already on screen")
    func cancelledByCheckingIn() async {
        let reminders = reminders
        let brush = habit(1, streak: 4)
        await reminders.reschedule(tasks: [], habits: [brush], now: morning)
        let (reminder, nudge) = (id(brush, "evening"), id(brush, "evening", nudge: true))
        #expect(centre.pending[reminder]?.body == "Evening · Keeps your 4-day streak going." && centre.pending[nudge] != nil)
        let before = centre.pending.count

        // The evening is checked in at 6 PM, before either fires.
        let evening = morning.addingTimeInterval(12 * 3600)
        let tap = PendingChange(createdAt: evening, kind: .checkIn(habit: 1, name: "Habit 1", slot: "evening", day: brush.today.day, at: evening, zone: zone.identifier, source: .manual, backfilled: false))
        await reminders.reschedule(tasks: [], habits: [brush.reckoned(with: [tap], now: evening, zone: zone)], now: evening)
        #expect(centre.pending[reminder] == nil && centre.pending[nudge] == nil)
        #expect(centre.pending[id(brush, "evening", daysAhead: 1)] != nil, "tomorrow's are untouched")
        #expect(centre.pending.count >= before - 3, "and the places freed are used for reminders further ahead")

        // Checked in after the nudge had fired and been snoozed: both the one on screen and the snooze go.
        let floss = habit(2)
        await reminders.reschedule(tasks: [], habits: [floss], now: morning)
        centre.fire(id(floss, "evening"))
        centre.fire(id(floss, "evening", nudge: true))
        await reminders.snooze(id(floss, "evening", nudge: true), title: "Habit 2", body: "Evening is still open.")
        let snoozed = PlannedNotification.snoozeIdentifier(habit: 2, slot: "evening", day: floss.today.day)
        #expect(centre.snoozes[snoozed] == 15 * 60 && centre.pending[snoozed] != nil)
        let late = morning.addingTimeInterval(17 * 3600)
        let done = PendingChange(createdAt: late, kind: .checkIn(habit: 2, name: "Habit 2", slot: "evening", day: floss.today.day, at: late, zone: zone.identifier, source: .manual, backfilled: false))
        await reminders.reschedule(tasks: [], habits: [floss.reckoned(with: [done], now: late, zone: zone)], now: late)
        #expect(centre.pending[snoozed] == nil && centre.shown.isEmpty, "nothing about that evening is left waiting or on screen")
    }

    @Test("a snoozed reminder holds a place of its own, so the total still fits")
    func snoozing() async {
        let reminders = reminders
        let habits = (1...12).map { habit($0) }
        await reminders.reschedule(tasks: [], habits: habits, now: morning)
        for habit in habits.prefix(8) {
            centre.fire(id(habit, "morning"))
            await reminders.snooze(id(habit, "morning"), title: habit.name, body: "Morning")
        }
        let later = morning.addingTimeInterval(2 * 3600)
        await reminders.reschedule(tasks: [], habits: habits.reckoned(now: later, zone: zone), now: later)
        let waiting = centre.pending
        #expect(waiting.keys.filter { $0.hasPrefix("snooze-") }.count == 8, "still open, so still snoozed")
        #expect(waiting.count <= NotificationPlan.systemLimit && waiting[PlannedNotification.noticeIdentifier] != nil)
        #expect(centre.most <= NotificationPlan.systemLimit)
        // Something that is not a habit's reminder can't be snoozed.
        await reminders.snooze("reminder-3", title: "x", body: "y")
        #expect(centre.pending.count == waiting.count)
    }
}

@MainActor
@Suite("The buttons on a habit's reminder")
struct ReminderActionTests {
    let mac = FakeMac()
    let centre = FakeCentre()
    let keychain = KeychainCredentialStore(service: "com.abhishekpratapa.todos.tests.\(UUID().uuidString)")
    let credentials = try! HubCredentials(address: HubAddress("my-mac.tail1234.ts.net"), token: "test-token-\(UUID().uuidString)")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todos-reminder-tests-\(UUID().uuidString)", isDirectory: true)
    private let channel = AsyncStream.makeStream(of: LiveState.self)

    /// The app as iOS starts it in the background to answer a button: paired earlier, nothing on screen.
    func background(_ reminders: Reminders) async -> AppModel {
        let model = AppModel(credentials: keychain, makeClient: { [mac] in mac.client($0) }, liveStates: { [channel] _ in channel.stream }, dataDirectory: directory)
        model.didReload = { tasks, habits in await reminders.reschedule(tasks: tasks, habits: habits) }
        return model
    }

    func cleanUp() {
        try? keychain.clear()
        try? FileManager.default.removeItem(at: directory)
    }

    @Test("Done checks the habit in without the app being opened, says how, and clears what is left for that slot")
    func done() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth", streak: 6)
        let reminders = Reminders(centre: centre, defaults: UserDefaults(suiteName: "todos.tests.\(UUID().uuidString)")!)
        #expect(await background(reminders).pair(credentials) == nil) // the app was set up at some point

        // Later: the evening reminder is on screen, a nudge was snoozed, and Done is pressed. The app starts afresh.
        let model = await background(reminders)
        let reminder = PlannedNotification.identifier(habit: brush.id, slot: "evening", day: brush.today.day, isNudge: false)
        let snoozed = PlannedNotification.snoozeIdentifier(habit: brush.id, slot: "evening", day: brush.today.day)
        await centre.schedule(PlannedNotification(id: reminder, subject: .habit(id: brush.id, slot: "evening", day: brush.today.day, isNudge: false), title: "Brush teeth", body: "Evening", fireDate: Date()))
        centre.fire(reminder)
        await reminders.snooze(reminder, title: "Brush teeth", body: "Evening")

        await reminders.done(reminder, model: model)
        #expect(mac.habit(brush.id)?.today.slots.map(\.done) == [false, true], "it reached the Mac")
        let sent = try #require(mac.writes.last { $0.url?.path.hasSuffix("/checkins") == true }?.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
        #expect(body["source"] as? String == "notification" && body["slot"] as? String == "evening" && body["zone"] as? String == TimeZone.current.identifier)
        #expect(centre.pending[snoozed] == nil && centre.shown.contains(reminder) == false, "the snooze and the reminder on screen are gone")
        #expect(model.changes.isEmpty && model.habit(brush.id)?.today.slots[1].done == true)

        // Pressed again from an old banner: nothing more happens.
        let writes = mac.writes.count
        await reminders.done(reminder, model: model)
        #expect(mac.writes.count == writes)
    }

    @Test("Done with no connection: the check-in is kept and sent when the Mac is back")
    func doneOffline() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth")
        let reminders = Reminders(centre: centre, defaults: UserDefaults(suiteName: "todos.tests.\(UUID().uuidString)")!)
        #expect(await background(reminders).pair(credentials) == nil)
        mac.isUnreachable = true
        var model = await background(reminders)
        await reminders.done(PlannedNotification.identifier(habit: brush.id, slot: "morning", day: brush.today.day, isNudge: false), model: model)
        #expect(model.waiting.count == 1 && model.habit(brush.id)?.today.slots[0].done == true)
        #expect(centre.pending.keys.contains { $0.contains("-morning-\(brush.today.day)") } == false, "and nothing more will remind about it today")

        // The app is opened later, with the Mac in reach.
        mac.isUnreachable = false
        model = await background(reminders)
        await model.start()
        await model.activate()
        #expect(model.changes.isEmpty && mac.habit(brush.id)?.today.slots[0].done == true)
    }

    @Test("Done on a reminder from days ago says it is too late, and checks nothing in")
    func tooLate() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth")
        let reminders = Reminders(centre: centre, defaults: UserDefaults(suiteName: "todos.tests.\(UUID().uuidString)")!)
        let model = await background(reminders)
        #expect(await model.pair(credentials) == nil)
        let writes = mac.writes.count
        await reminders.done(PlannedNotification.identifier(habit: brush.id, slot: "evening", day: brush.today.day.adding(days: -3), isNudge: false), model: model)
        #expect(mac.writes.count == writes && model.changes.isEmpty)
        #expect(centre.said == ["Too late to log that one"])

        // Yesterday's can still be logged, and is marked as logged late.
        await reminders.done(PlannedNotification.identifier(habit: brush.id, slot: "evening", day: brush.today.day.adding(days: -1), isNudge: false), model: model)
        let sent = try #require(mac.writes.last?.httpBody)
        #expect((try JSONSerialization.jsonObject(with: sent) as? [String: Any])?["day"] as? String == brush.today.day.adding(days: -1).description)
        // A habit that has since been deleted: the reminder is simply taken away.
        await reminders.done(PlannedNotification.identifier(habit: 99, slot: "evening", day: brush.today.day, isNudge: false), model: model)
        #expect(centre.cancelled.contains { $0.hasPrefix("habit-99-") })
    }

    @Test("a check-in from outside the app before it is paired does nothing")
    func notPaired() async {
        defer { cleanUp() }
        let model = await background(Reminders(centre: centre, defaults: UserDefaults(suiteName: "todos.tests.\(UUID().uuidString)")!))
        #expect(await model.checkInFromOutside(habit: 1, slot: nil, source: .notification) == .notPaired)
    }
}
