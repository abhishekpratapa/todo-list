// Habits in TodosKit: reading what the Mac sends, what is sent back, the queue,
// what is kept on the phone, and the phone's own reckoning between syncs. That
// the reckoning agrees with the real server is tested in HabitIntegrationTests.

import Foundation
import Testing
@testable import TodosKit

enum HabitSample {
    /// Two habits exactly as the Mac sends them (src/habits.js), on Wednesday 7 October 2026.
    static let listJSON = """
    {"habits":[
     {"id":1,"name":"Brush teeth","icon":"🪥","color":"blue","dayStart":"03:00",
      "schedule":{"kind":"daily","slots":[
        {"id":"morning","name":"Morning","remind":"07:30","from":"05:00","until":"11:00","nudge":null},
        {"id":"evening","name":"Evening","remind":"21:30","from":"19:00","until":"02:00","nudge":"22:30"}]},
      "paused":false,"archived":false,"rev":1,"createdAt":"2026-10-05T11:00:00.000Z","updatedAt":"2026-10-05T11:00:00.000Z",
      "today":{"day":"2026-10-07","state":"open","done":1,"total":2,"slots":[
        {"id":"morning","done":true,"at":"2026-10-07T12:10:00.000Z","by":"me","via":"iPhone","source":"notification","checkins":[5]},
        {"id":"evening","done":false}]},
      "yesterday":{"day":"2026-10-06","state":"done","done":2,"total":2,"slots":[
        {"id":"morning","done":true,"at":"2026-10-06T12:00:00.000Z","by":"me","source":"manual","checkins":[3]},
        {"id":"evening","done":true,"at":"2026-10-07T02:00:00.000Z","by":"me","via":"iPhone","source":"manual","checkins":[4]}]},
      "streak":{"current":2,"best":2,"unit":"days","atRisk":null,"previous":null},
      "rates":{"d7":1,"d30":1,"d365":1},"skipsLeft":2},
     {"id":2,"name":"Gym","icon":null,"color":"indigo","dayStart":"03:00",
      "schedule":{"kind":"weekly","target":3,"remind":{"days":["mon","wed","fri"],"time":"17:30"}},
      "paused":false,"archived":false,"rev":1,"createdAt":"2026-10-05T11:00:00.000Z","updatedAt":"2026-10-05T11:00:00.000Z",
      "today":{"day":"2026-10-07","done":true,"checkins":[7]},
      "yesterday":{"day":"2026-10-06","done":false,"checkins":[]},
      "week":{"start":"2026-10-05","state":"open","count":2,"target":3,"days":["2026-10-05","2026-10-07"],"whole":true},
      "lastWeek":null,
      "streak":{"current":0,"best":0,"unit":"weeks","atRisk":null,"previous":null},
      "rates":{"d7":null,"d30":null,"d365":null},"skipsLeft":1}
    ],"zone":"America/Chicago","version":9}
    """

    static let list = try! HubJSON.decoder().decode(HubClient.HabitList.self, from: Data(listJSON.utf8))
    static var brush: Habit { list.habits[0] }
    static var gym: Habit { list.habits[1] }
    static func json(_ habit: Habit) -> String { String(decoding: try! HubJSON.encoder().encode(habit), as: UTF8.self) }

    static let chicago = TimeZone(identifier: "America/Chicago")!
    /// "2026-10-07 21:00" on a clock in Chicago.
    static func at(_ stamp: String, zone: TimeZone = chicago) -> Date {
        let day = Day(String(stamp.prefix(10)))!
        let time = ClockTime(String(stamp.suffix(5)))!
        return Calendar.gregorian(in: zone).date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute))!
    }

    static func checkIn(_ habit: Habit, _ slot: String?, _ stamp: String, day: String? = nil) -> PendingChange {
        let when = at(stamp)
        let today = HabitClock.day(of: when, zone: chicago, dayStart: habit.dayStart)
        return PendingChange(createdAt: when, kind: .checkIn(habit: habit.id, name: habit.name, slot: slot, day: day.flatMap(Day.init) ?? today, at: when, zone: chicago.identifier, source: .manual, backfilled: day != nil))
    }
}

@Suite("Habits: what the Mac sends")
struct HabitModelTests {
    @Test("a habit with slots is read whole")
    func withSlots() {
        let habit = HabitSample.brush
        #expect(habit.name == "Brush teeth" && habit.icon == "🪥" && habit.color == .blue && habit.dayStart == ClockTime("03:00") && habit.rev == 1)
        #expect(habit.schedule == .daily(slots: [
            HabitSlot(id: "morning", name: "Morning", remind: ClockTime("07:30"), from: ClockTime("05:00"), until: ClockTime("11:00")),
            HabitSlot(id: "evening", name: "Evening", remind: ClockTime("21:30"), from: ClockTime("19:00"), until: ClockTime("02:00"), nudge: ClockTime("22:30")),
        ]))
        #expect(!habit.isWeekly && !habit.paused && !habit.archived)
        #expect(habit.today.day == Day("2026-10-07") && habit.today.state == .open && habit.today.done == 1 && habit.today.total == 2 && !habit.today.isSession)
        #expect(habit.today.slots[0] == HabitDay.Slot(id: "morning", done: true, at: HubJSON.parseDate("2026-10-07T12:10:00.000Z"), by: "me", via: "iPhone", source: "notification", checkins: [5]))
        #expect(habit.today.slots[1] == HabitDay.Slot(id: "evening"))
        #expect(habit.today.remaining.map(\.id) == ["evening"])
        #expect(habit.yesterday.isComplete && habit.yesterday.slots[0].via == nil)
        #expect(habit.streak == HabitStreak(current: 2, best: 2, unit: .days))
        #expect(habit.rates == HabitRates(d7: 1, d30: 1, d365: 1) && habit.skipsLeft == 2 && habit.week == nil)
        #expect(habit.slotName("evening") == "Evening" && habit.slot("noon") == nil)
    }

    @Test("a habit counted in weeks is read whole")
    func weekly() {
        let habit = HabitSample.gym
        #expect(habit.isWeekly && habit.icon == nil && habit.color == .indigo)
        #expect(habit.schedule == .weekly(target: 3, remind: .init(days: [.mon, .wed, .fri], time: ClockTime("17:30")!)))
        #expect(habit.schedule.slots.isEmpty)
        #expect(habit.today == HabitDay(day: Day("2026-10-07")!, state: .done, checkins: [7], isSession: true))
        #expect(habit.today.done == 1 && habit.today.total == 1)
        #expect(habit.yesterday.state == .open && habit.yesterday.checkins.isEmpty)
        #expect(habit.week == HabitWeek(start: Day("2026-10-05")!, state: .open, count: 2, target: 3, days: [Day("2026-10-05")!, Day("2026-10-07")!]))
        #expect(habit.lastWeek == nil && habit.streak.unit == .weeks && habit.rates == HabitRates())
        #expect(HabitSample.list.zone == "America/Chicago" && HabitSample.list.version == 9)
    }

    @Test("what is kept on the phone reads back exactly as it was")
    func roundTrip() throws {
        for habit in HabitSample.list.habits {
            let again = try HubJSON.decoder().decode(Habit.self, from: HubJSON.encoder().encode(habit))
            #expect(again == habit)
        }
        let risky = """
        {"current":12,"best":21,"unit":"days","atRisk":{"day":"2026-10-06","missing":["evening"],"until":"2026-10-08T08:00:00.000Z"},"previous":{"length":4,"lastDay":"2026-09-20"}}
        """
        let streak = try HubJSON.decoder().decode(HabitStreak.self, from: Data(risky.utf8))
        #expect(streak.atRisk == .init(day: Day("2026-10-06")!, missing: ["evening"], until: HubJSON.parseDate("2026-10-08T08:00:00.000Z")))
        #expect(streak.previous == .init(length: 4, lastDay: Day("2026-09-20")))
    }

    @Test("something newer from the Mac doesn't break the list: an unknown color is the default one")
    func unknowns() throws {
        let json = HabitSample.json(HabitSample.brush).replacingOccurrences(of: "\"blue\"", with: "\"chartreuse\"")
        #expect(try HubJSON.decoder().decode(Habit.self, from: Data(json.utf8)).color == .indigo)
        let odd = HabitSample.json(HabitSample.brush).replacingOccurrences(of: "\"daily\"", with: "\"hourly\"")
        #expect(throws: DecodingError.self) { try HubJSON.decoder().decode(Habit.self, from: Data(odd.utf8)) }
    }

    @Test("times of day, days of the week")
    func clock() {
        #expect(ClockTime("07:30") == ClockTime(hour: 7, minute: 30) && ClockTime("7:05")?.description == "07:05")
        for bad in ["", "7", "24:00", "12:60", "12:5", "ab:cd", "12:30:00"] { #expect(ClockTime(bad) == nil, "\(bad)") }
        #expect(ClockTime("02:00")! < ClockTime("19:00")!)
        let evening = (ClockTime("19:00")!, ClockTime("02:00")!)
        #expect(ClockTime("23:30")!.isWithin(evening.0, evening.1) && ClockTime("01:59")!.isWithin(evening.0, evening.1), "a window may run past midnight")
        #expect(!ClockTime("02:00")!.isWithin(evening.0, evening.1) && !ClockTime("12:00")!.isWithin(evening.0, evening.1))
        #expect(ClockTime("05:00")!.isWithin(ClockTime("05:00")!, ClockTime("11:00")!) && !ClockTime("11:00")!.isWithin(ClockTime("05:00")!, ClockTime("11:00")!))
        #expect(Weekday(Day("2026-10-13")!) == .tue && Weekday(Day("2026-10-18")!) == .sun && Weekday(Day("2026-10-12")!) == .mon)
        #expect(Day("2026-10-13")!.weekStart == Day("2026-10-12") && Day("2026-10-18")!.weekStart == Day("2026-10-12") && Day("2026-10-12")!.weekStart == Day("2026-10-12"))
        #expect(Day("2026-02-28")!.adding(days: 1) == Day("2026-03-01") && Day("2027-01-01")!.adding(days: -1) == Day("2026-12-31"))
        #expect(HabitSchedule.days([.mon, .fri], slots: []).includes(.fri) && !HabitSchedule.days([.mon, .fri], slots: []).includes(.tue) && HabitSchedule.daily(slots: []).includes(.tue))
    }

    @Test("the habit day: the calendar date where the user is, or the one before until the day start")
    func habitDay() {
        func at(_ stamp: String) -> Date { HabitSample.at(stamp) }
        let three = ClockTime.defaultDayStart
        #expect(HabitClock.day(of: at("2026-10-13 00:30"), zone: HabitSample.chicago, dayStart: three) == Day("2026-10-12"), "after midnight is still the evening before")
        #expect(HabitClock.day(of: at("2026-10-13 02:59"), zone: HabitSample.chicago, dayStart: three) == Day("2026-10-12"))
        #expect(HabitClock.day(of: at("2026-10-13 03:00"), zone: HabitSample.chicago, dayStart: three) == Day("2026-10-13"))
        #expect(HabitClock.day(of: at("2026-10-13 00:30"), zone: HabitSample.chicago, dayStart: ClockTime("00:00")!) == Day("2026-10-13"))
        // The same instant is another date in Tokyo.
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        #expect(HabitClock.day(of: at("2026-10-13 17:00"), zone: tokyo, dayStart: three) == Day("2026-10-14"))
        // The autumn change: 1:30 AM happens twice on 1 November, and both are Saturday night.
        let first = HubJSON.parseDate("2026-11-01T06:30:00Z")!
        let second = HubJSON.parseDate("2026-11-01T07:30:00Z")!
        #expect(HabitClock.day(of: first, zone: HabitSample.chicago, dayStart: three) == Day("2026-10-31") && HabitClock.day(of: second, zone: HabitSample.chicago, dayStart: three) == Day("2026-10-31"))
        // The spring change: 1:59 AM is followed by 3:00 AM.
        #expect(HabitClock.day(of: HubJSON.parseDate("2027-03-14T07:59:00Z")!, zone: HabitSample.chicago, dayStart: three) == Day("2027-03-13"))
        #expect(HabitClock.day(of: HubJSON.parseDate("2027-03-14T08:00:00Z")!, zone: HabitSample.chicago, dayStart: three) == Day("2027-03-14"))
        #expect(HabitClock.end(of: Day("2026-10-07")!, zone: HabitSample.chicago, dayStart: three) == HubJSON.parseDate("2026-10-08T08:00:00Z"))
        #expect(HabitClock.end(of: Day("2026-11-01")!, zone: HabitSample.chicago, dayStart: three) == HubJSON.parseDate("2026-11-02T09:00:00Z"), "the 25-hour day ends at 3 AM standard time")
    }
}

@Suite("Habits: what is sent to the Mac")
struct HabitClientTests {
    let stub = StubTransport()
    var client: HubClient { Sample.client(stub) }
    var one: String { "{\"habit\":\(HabitSample.json(HabitSample.brush))}" }

    @Test("listing, and a Mac too old to have habits")
    func listing() async throws {
        stub.reply(200, HabitSample.listJSON)
        #expect(try await client.habits() == HabitSample.list)
        #expect(stub.last.url?.absoluteString == "https://my-mac.tail1234.ts.net/api/v1/habits" && stub.last.httpMethod == "GET")
        stub.reply(200, HabitSample.listJSON)
        _ = try await client.habits(includingArchived: true)
        #expect(stub.last.url?.query == "archived=true")
        stub.reply(404, #"{"error":{"code":"not_found","message":"No such endpoint."}}"#)
        await #expect(throws: HubError.notFound(message: "No such endpoint.")) { try await client.habits() }
    }

    @Test("a check-in says when, where and how, and carries a key")
    func checkIn() async throws {
        let key = UUID()
        let when = HabitSample.at("2026-10-07 21:40")
        stub.reply(201, "{\"habit\":\(HabitSample.json(HabitSample.brush)),\"checkin\":{\"id\":9,\"habit\":1,\"kind\":\"done\",\"slot\":\"evening\",\"day\":\"2026-10-07\",\"at\":\"2026-10-08T02:40:00.000Z\",\"zone\":\"America/Chicago\",\"by\":\"me\",\"via\":\"iPhone\",\"source\":\"widget\"}}")
        let result = try await client.checkIn(1, slot: "evening", at: when, zone: "America/Chicago", source: .widget, key: key)
        #expect(result.habit == HabitSample.brush && result.checkin?.id == 9 && result.checkin?.slot == "evening" && result.checkin?.kind == .done && result.skip == nil)
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/habits/1/checkins")
        #expect(stub.last.value(forHTTPHeaderField: "Idempotency-Key") == key.uuidString && stub.last.value(forHTTPHeaderField: "X-Todos-Client") == "iPhone")
        #expect(stub.body() as NSDictionary == ["slot": "evening", "at": "2026-10-08T02:40:00.000Z", "zone": "America/Chicago", "source": "widget"] as NSDictionary, "no day unless it is yesterday being logged")

        stub.reply(200, "{\"habit\":\(HabitSample.json(HabitSample.gym)),\"checkin\":null}")
        let nothing = try await client.checkIn(2, day: Day("2026-10-06"))
        #expect(nothing.checkin == nil)
        #expect(stub.body() as NSDictionary == ["day": "2026-10-06", "source": "manual"] as NSDictionary)
        #expect(stub.last.value(forHTTPHeaderField: "Idempotency-Key") == nil)
    }

    @Test("undoing names what it takes back; skipping and taking a skip back")
    func undoAndSkip() async throws {
        let mine = UUID()
        stub.reply(200, one)
        _ = try await client.undoCheckIns(1, checkins: [5, 6], keys: [mine], at: HabitSample.at("2026-10-07 21:41"), key: UUID())
        #expect(stub.last.url?.path == "/api/v1/habits/1/undo")
        #expect(stub.body() as NSDictionary == ["checkins": [5, 6], "keys": [mine.uuidString], "at": "2026-10-08T02:41:00.000Z"] as NSDictionary)

        stub.reply(201, "{\"habit\":\(HabitSample.json(HabitSample.brush)),\"skip\":{\"id\":10,\"habit\":1,\"kind\":\"skip\",\"slot\":null,\"day\":\"2026-10-07\",\"at\":\"2026-10-08T02:40:00.000Z\",\"zone\":\"America/Chicago\",\"by\":\"me\",\"reason\":\"flu\"}}")
        let skipped = try await client.skip(1, day: Day("2026-10-07"), reason: "flu")
        #expect(skipped.skip?.kind == .skip && skipped.skip?.reason == "flu" && skipped.checkin == nil)
        #expect(stub.last.url?.path == "/api/v1/habits/1/skips" && stub.body() as NSDictionary == ["day": "2026-10-07", "reason": "flu"] as NSDictionary)

        stub.reply(200, one)
        _ = try await client.undoSkip(1, day: Day("2026-10-07")!, zone: "America/Chicago")
        #expect(stub.body() as NSDictionary == ["skip": true, "day": "2026-10-07", "zone": "America/Chicago"] as NSDictionary)
    }

    @Test("creating and editing send the whole habit; an edit says which revision it is based on")
    func managing() async throws {
        var draft = HabitDraft.twiceADay()
        draft.name = "Brush teeth"
        stub.reply(201, one)
        _ = try await client.createHabit(draft, key: UUID())
        let body = stub.body()
        #expect(body["name"] as? String == "Brush teeth" && body["icon"] as? String == "" && body["color"] as? String == "indigo" && body["dayStart"] as? String == "03:00")
        let slots = (body["schedule"] as? [String: Any])?["slots"] as? [[String: Any]]
        #expect((body["schedule"] as? [String: Any])?["kind"] as? String == "daily")
        #expect(slots?.map { $0["name"] as? String } == ["Morning", "Evening"] && slots?[0]["id"] == nil, "a new slot has no id: the Mac makes one")
        #expect(slots?[1]["from"] as? String == "19:00" && slots?[1]["until"] as? String == "02:00" && slots?[1]["nudge"] is NSNull)

        stub.reply(200, one)
        _ = try await client.updateHabit(1, rev: 4, HabitDraft(HabitSample.brush))
        #expect(stub.last.httpMethod == "PATCH" && stub.last.value(forHTTPHeaderField: "If-Match") == "\"4\"")
        #expect(((stub.body()["schedule"] as? [String: Any])?["slots"] as? [[String: Any]])?.map { $0["id"] as? String } == ["morning", "evening"], "existing slots keep their ids, and so their history")

        stub.reply(409, "{\"error\":{\"code\":\"conflict\",\"message\":\"changed\",\"current\":\(HabitSample.json(HabitSample.brush))}}")
        await #expect(throws: HubError.habitConflict(current: HabitSample.brush)) { try await client.updateHabit(1, rev: 1, HabitDraft(HabitSample.brush)) }
        // A task's conflict is still a task's.
        stub.reply(409, "{\"error\":{\"code\":\"conflict\",\"message\":\"changed\",\"current\":\(Sample.taskJSON)}}")
        await #expect(throws: HubError.self) { try await client.update(12, rev: 1, TaskPatch(title: "x")) }

        stub.reply(200, one)
        _ = try await client.setHabit(1, paused: true)
        #expect(stub.body() as NSDictionary == ["paused": true] as NSDictionary && stub.last.value(forHTTPHeaderField: "If-Match") == "*")
        stub.reply(204, "")
        try await client.deleteHabit(1)
        #expect(stub.last.httpMethod == "DELETE" && stub.last.value(forHTTPHeaderField: "If-Match") == "*")

        stub.reply(200, #"{"zone":"Asia/Tokyo"}"#)
        try await client.reportZone("Asia/Tokyo")
        #expect(stub.last.url?.path == "/api/v1/habits/zone" && stub.body() as NSDictionary == ["zone": "Asia/Tokyo"] as NSDictionary)

        stub.reply(200, #"{"from":"2026-10-01","to":"2026-10-07","today":"2026-10-07","days":"....ddo","events":[{"id":1,"habit":1,"kind":"done","slot":"morning","day":"2026-10-05","at":"2026-10-05T12:00:00.000Z","zone":"America/Chicago","by":"me","source":"manual","undone":false}]}"#)
        let history = try await client.habitHistory(1, from: Day("2026-10-01"), to: Day("2026-10-07"))
        #expect(stub.last.url?.query == "from=2026-10-01&to=2026-10-07")
        #expect(history.mark(for: Day("2026-10-05")!) == "d" && history.mark(for: Day("2026-10-07")!) == "o" && history.mark(for: Day("2026-09-30")!) == nil && history.mark(for: Day("2026-10-08")!) == nil)
        #expect(history.events.first?.slot == "morning" && history.weeks == nil)
    }

    @Test("the live updates say when habits change")
    func events() {
        #expect(HubEvent(.init(event: "habits", data: #"{"version":57,"habits":12}"#)) == .habits(version: 12), "the habits' own version, not the list's")
        #expect(HubEvent(.init(event: "habits", data: #"{"version":57}"#)) == nil)
        #expect(HubEvent(.init(event: "change", data: #"{"version":58}"#)) == .change(version: 58))
        #expect(HubEvent(.init(event: "hello", data: #"{"version":58}"#)) == .hello(version: 58))
    }
}

@Suite("Habits: the queue and what is kept on the phone")
struct HabitStoreTests {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-habit-tests-\(UUID().uuidString)", isDirectory: true)
    let stub = StubTransport()

    @Test("habit changes are saved like any other, and read back after a relaunch")
    func saved() async throws {
        let store = LocalStore(directory: directory)
        let when = HabitSample.at("2026-10-07 21:40")
        let kinds: [PendingChange.Kind] = [
            .checkIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-07")!, at: when, zone: "America/Chicago", source: .notification, backfilled: false),
            .undoCheckIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-07")!, checkins: [5], keys: [UUID()], at: when),
            .skipHabit(habit: 2, name: "Gym", day: Day("2026-10-07")!, at: when, zone: "America/Chicago", reason: "flu"),
            .undoSkip(habit: 2, name: "Gym", day: Day("2026-10-07")!, at: when, zone: "America/Chicago"),
        ]
        for kind in kinds { await store.add(kind, at: when) }
        let read = await LocalStore(directory: directory).changes
        #expect(read.map(\.kind) == kinds)
        #expect(read.map(\.habitID) == [1, 1, 2, 2] && read.allSatisfy { $0.taskID == nil && $0.isWaiting })
        #expect(read.map(\.habitName) == ["Brush teeth", "Brush teeth", "Gym", "Gym"])
        #expect(read.map(\.summary) == ["Check in (evening)", "Undo a check-in", "Skip a day", "Undo a skipped day"])
        // They don't disturb the tasks shown.
        #expect([Sample.task(1, "A task")].applying(read) == [Sample.task(1, "A task")])
    }

    @Test("the habits the Mac last sent are kept, and go when the phone is unpaired")
    func kept() async throws {
        let store = LocalStore(directory: directory)
        #expect(await store.habits == CachedHabits())
        await store.replaceHabits(HabitSample.list.habits, version: 9, zone: "America/Chicago", syncedAt: HabitSample.at("2026-10-07 20:00"))
        var again = LocalStore(directory: directory)
        var kept = await again.habits
        #expect(kept.habits == HabitSample.list.habits && kept.version == 9 && kept.zone == "America/Chicago" && kept.supported == true)
        #expect(LocalStore.readHabits(directory: directory) == kept, "the widget reads the same file")

        var edited = HabitSample.gym
        edited.name = "Gym, properly"
        await again.keep(edited)
        await again.forget(habit: 1)
        #expect(await again.habits.habits.map(\.name) == ["Gym, properly"])
        var archived = edited
        archived.archived = true
        await again.keep(archived)
        #expect(await again.habits.habits.isEmpty, "an archived habit is not kept")

        await again.habitsUnsupported()
        again = LocalStore(directory: directory)
        kept = await again.habits
        #expect(kept.supported == false && kept.habits.isEmpty)
        await again.replaceHabits(HabitSample.list.habits, version: 10, zone: "America/Chicago")
        await again.erase()
        #expect(await LocalStore(directory: directory).habits == CachedHabits())
    }

    @Test("a check-in is sent as it was tapped; what the Mac refuses is kept with its reason")
    func sending() async throws {
        let store = LocalStore(directory: directory)
        let engine = SyncEngine(client: Sample.client(stub), store: store)
        await store.replaceHabits(HabitSample.list.habits, version: 9, zone: "America/Chicago")
        let when = HabitSample.at("2026-10-07 21:40")
        let change = await store.add(.checkIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-07")!, at: when, zone: "America/Chicago", source: .notification, backfilled: false), at: when)

        // The Mac can't be reached: it waits.
        stub.fail(.notConnectedToInternet)
        #expect(await engine.replay() == .interrupted(.transport(.notConnectedToInternet)))
        #expect(await store.changes.map(\.id) == [change.id])

        // It can: the check-in goes, with its key, and the habit the Mac answers with is kept.
        var done = HabitSample.brush
        done.today.slots[1] = HabitDay.Slot(id: "evening", done: true, at: when, by: "me", via: "iPhone", source: "notification", checkins: [8])
        done.today.state = .done
        let fresh = StubTransport()
        fresh.reply(201, "{\"habit\":\(HabitSample.json(done)),\"checkin\":null}")
        let online = SyncEngine(client: Sample.client(fresh), store: store)
        #expect(await online.replay() == .finished)
        #expect(fresh.last.value(forHTTPHeaderField: "Idempotency-Key") == change.id.uuidString)
        #expect(fresh.body() as NSDictionary == ["slot": "evening", "at": "2026-10-08T02:40:00.000Z", "zone": "America/Chicago", "source": "notification"] as NSDictionary)
        let nothingWaiting = await store.changes.isEmpty
        let keptHabit = await store.habits.habits[0]
        #expect(nothingWaiting && keptHabit.today.isComplete)

        // Logged late, the day is named. Refused, the Mac's words are kept for the user.
        await store.add(.checkIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-04")!, at: when, zone: "America/Chicago", source: .manual, backfilled: true), at: when)
        fresh.reply(400, #"{"error":{"code":"too_late","message":"You can log yesterday until the end of today, but no further back."}}"#)
        #expect(await online.replay() == .finished)
        #expect(fresh.body()["day"] as? String == "2026-10-04")
        #expect(await store.changes.map(\.state) == [.rejected(message: "You can log yesterday until the end of today, but no further back.")])
        // It doesn't hold anything else up.
        await store.add(.skipHabit(habit: 2, name: "Gym", day: Day("2026-10-07")!, at: when, zone: "America/Chicago", reason: nil), at: when)
        fresh.reply(201, "{\"habit\":\(HabitSample.json(HabitSample.gym)),\"skip\":null}")
        #expect(await online.replay() == .finished)
        let left = await store.changes.count
        #expect(left == 1 && fresh.last.url?.path == "/api/v1/habits/2/skips")
    }

    @Test("an older Mac has no habits: that is remembered, and is not an error")
    func olderMac() async throws {
        let store = LocalStore(directory: directory)
        let engine = SyncEngine(client: Sample.client(stub), store: store)
        stub.reply(404, #"{"error":{"code":"not_found","message":"No such endpoint."}}"#)
        #expect(try await engine.refreshHabits().supported == false)
        stub.reply(200, HabitSample.listJSON)
        let fetched = try await engine.refreshHabits()
        #expect(fetched.supported == true && fetched.habits.count == 2 && fetched.version == 9)
    }
}

@Suite("Habits: the phone's reckoning between syncs")
struct HabitReckoningTests {
    let brush = HabitSample.brush // Wednesday 7 October: morning done, evening not; a streak of 2
    let gym = HabitSample.gym // two of three this week
    let zone = HabitSample.chicago
    func shown(_ habit: Habit, _ changes: [PendingChange], _ stamp: String) -> Habit {
        habit.reckoned(with: changes, now: HabitSample.at(stamp), zone: zone)
    }

    @Test("with nothing waiting and no time passed, it is what the Mac said")
    func unchanged() {
        #expect(shown(brush, [], "2026-10-07 20:00") == brush)
        #expect(shown(gym, [], "2026-10-07 20:00") == gym)
        #expect(HabitSample.list.habits.reckoned(now: HabitSample.at("2026-10-07 20:00"), zone: zone) == HabitSample.list.habits)
    }

    @Test("a waiting check-in shows at once, and the streak with it")
    func waiting() {
        let tap = HabitSample.checkIn(brush, "evening", "2026-10-07 21:40")
        let now = shown(brush, [tap], "2026-10-07 21:41")
        #expect(now.today.isComplete && now.streak.current == 3 && now.streak.best == 3)
        #expect(now.today.slots[1] == HabitDay.Slot(id: "evening", done: true, at: HabitSample.at("2026-10-07 21:40"), by: "me", via: "iPhone", source: "manual"))
        // Someone else's change, a change for another habit, and one the Mac refused, don't count.
        var refused = tap
        refused.state = .rejected(message: "no")
        #expect(shown(brush, [refused, HabitSample.checkIn(gym, nil, "2026-10-07 21:40")], "2026-10-07 21:41") == brush)

        // Taken back: by its own key.
        let undo = PendingChange(createdAt: HabitSample.at("2026-10-07 21:42"), kind: .undoCheckIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-07")!, checkins: [], keys: [tap.id], at: HabitSample.at("2026-10-07 21:42")))
        let back = shown(brush, [tap, undo], "2026-10-07 21:43")
        #expect(back.today.slots == brush.today.slots && back.streak.current == 2)
        // The Mac's own check-in taken back: by its id.
        let undoMac = PendingChange(createdAt: HabitSample.at("2026-10-07 21:42"), kind: .undoCheckIn(habit: 1, name: "Brush teeth", slot: "morning", day: Day("2026-10-07")!, checkins: [5], keys: [], at: HabitSample.at("2026-10-07 21:42")))
        #expect(shown(brush, [undoMac], "2026-10-07 21:43").today.slots.map(\.done) == [false, false])
    }

    @Test("days go by without the Mac: an unfinished day closes, a skipped day is passed over")
    func daysGoBy() {
        // Thursday morning: Wednesday's evening is still missing, and the streak is at risk.
        var now = shown(brush, [], "2026-10-08 09:00")
        #expect(now.today.day == Day("2026-10-08") && now.today.state == .open && now.today.slots.map(\.id) == ["morning", "evening"] && now.yesterday.state == .open)
        #expect(now.streak.current == 2 && now.streak.atRisk == .init(day: Day("2026-10-07")!, missing: ["evening"], until: HabitSample.at("2026-10-09 03:00")))
        // Logged late, it is saved.
        let late = HabitSample.checkIn(brush, "evening", "2026-10-08 09:05", day: "2026-10-07")
        now = shown(brush, [late], "2026-10-08 09:06")
        #expect(now.yesterday.isComplete && now.streak.current == 3 && now.streak.atRisk == nil)
        // Not logged, by Friday it has closed.
        now = shown(brush, [], "2026-10-09 09:00")
        #expect(now.streak.current == 0 && now.streak.previous == .init(length: 2, lastDay: Day("2026-10-06")) && now.streak.best == 2)
        // A rest day on Thursday, and Wednesday finished late: Friday continues the streak.
        let rest = PendingChange(createdAt: HabitSample.at("2026-10-08 20:00"), kind: .skipHabit(habit: 1, name: "Brush teeth", day: Day("2026-10-08")!, at: HabitSample.at("2026-10-08 20:00"), zone: zone.identifier, reason: nil))
        let friday = [HabitSample.checkIn(brush, "morning", "2026-10-09 07:00"), HabitSample.checkIn(brush, "evening", "2026-10-09 21:00")]
        now = shown(brush, [late, rest] + friday, "2026-10-09 22:00")
        #expect(now.yesterday.state == .skipped && now.today.isComplete && now.streak.current == 4 && now.skipsLeft == 1)
        // A clock set back can't unwind what the Mac said.
        #expect(shown(brush, [], "2026-10-01 09:00") == brush)
    }

    @Test("a habit counted in weeks: a third day meets the week; a week that closes short ends the streak")
    func weeks() {
        let friday = HabitSample.checkIn(gym, nil, "2026-10-09 18:00")
        var now = shown(gym, [friday], "2026-10-09 18:01")
        #expect(now.week?.state == .met && now.week?.count == 3 && now.streak.current == 1 && now.today.state == .done && now.today.isSession)
        // Twice in a day is one day.
        now = shown(gym, [HabitSample.checkIn(gym, nil, "2026-10-07 19:00")], "2026-10-07 19:01")
        #expect(now.week?.count == 2 && now.streak.current == 0)
        // Next Monday, with nothing more done: last week is one short, and open until Monday ends.
        now = shown(gym, [], "2026-10-12 09:00")
        #expect(now.week?.start == Day("2026-10-12") && now.week?.count == 0 && now.lastWeek?.state == .open)
        // On Tuesday it has closed. It began on its Monday, so it is a miss.
        now = shown(gym, [], "2026-10-13 09:00")
        #expect(now.lastWeek?.state == .missed && now.streak.current == 0)
    }

    @Test("a check-in with no slot named goes to the slot whose time it is")
    func slotToCheckIn() {
        #expect(brush.slotToCheckIn(at: HabitSample.at("2026-10-07 21:00"), zone: zone) == "evening", "only one is left")
        let fresh = shown(brush, [], "2026-10-08 06:00")
        #expect(fresh.slotToCheckIn(at: HabitSample.at("2026-10-08 06:00"), zone: zone) == "morning")
        #expect(fresh.slotToCheckIn(at: HabitSample.at("2026-10-08 21:00"), zone: zone) == "evening", "the evening window, though morning is not done either")
        #expect(fresh.slotToCheckIn(at: HabitSample.at("2026-10-08 14:00"), zone: zone) == "morning", "outside both: the earliest")
        let done = shown(brush, [HabitSample.checkIn(brush, "evening", "2026-10-07 21:40")], "2026-10-07 21:41")
        #expect(done.slotToCheckIn(at: HabitSample.at("2026-10-07 21:41"), zone: zone) == nil && gym.slotToCheckIn() == nil)
    }
}

@Suite("Habits: how they read on screen")
struct HabitTextTests {
    let brush = HabitSample.brush // morning done, evening not; a streak of 2
    let gym = HabitSample.gym // two of three this week, one of them today
    let us = Locale(identifier: "en_US")

    @Test("times are written the way the phone's region writes them")
    func times() {
        // U.S. English puts a narrow no-break space before AM and PM.
        #expect(ClockTime("21:30")!.formatted(locale: us) == "9:30\u{202F}PM" && ClockTime("07:05")!.formatted(locale: us) == "7:05\u{202F}AM")
        #expect(ClockTime("21:30")!.formatted(locale: Locale(identifier: "de_DE")) == "21:30")
        #expect(Day("2026-10-04")!.weekdayName(locale: us) == "Sunday")
    }

    @Test("the line under a habit's name says how today stands and what is next")
    func progress() {
        #expect(HabitText.progress(brush, locale: us) == "1 of 2 · Evening 9:30\u{202F}PM")
        #expect(HabitText.progress(gym, locale: us) == "2 of 3 this week")
        var done = brush
        done.today.state = .done
        #expect(HabitText.progress(done, locale: us) == "2 of 2 · done")
        done.today.state = .skipped
        #expect(HabitText.progress(done, locale: us) == "Rest day")
        done.today.state = .off
        #expect(HabitText.progress(done, locale: us) == "Not today")
        done.paused = true
        #expect(HabitText.progress(done, locale: us) == "Paused")
        var met = gym
        met.week?.state = .met
        met.week?.count = 3
        #expect(HabitText.progress(met, locale: us) == "3 of 3 this week · done")
        // One unnamed slot has nothing to add but its time.
        var single = brush
        single.schedule = .daily(slots: [HabitSlot(id: "once", name: "", remind: ClockTime("09:00"))])
        single.today = HabitDay(day: brush.today.day, state: .open, slots: [.init(id: "once")])
        #expect(HabitText.progress(single, locale: us) == "9:00\u{202F}AM")
        single.schedule = .daily(slots: [HabitSlot(id: "once", name: "")])
        #expect(HabitText.progress(single, locale: us) == "To do today")
        single.today.state = .done
        #expect(HabitText.progress(single, locale: us) == "Done today")
    }

    @Test("a schedule in a line")
    func schedule() {
        #expect(HabitText.schedule(brush.schedule, locale: us) == "Every day · Morning 7:30\u{202F}AM, Evening 9:30\u{202F}PM")
        #expect(HabitText.schedule(gym.schedule, locale: us) == "3 days a week · reminders Mon, Wed, Fri at 5:30\u{202F}PM")
        #expect(HabitText.schedule(.days([.mon, .thu], slots: [HabitSlot(id: "run", name: "Run")]), locale: us) == "Mon, Thu · Run")
        #expect(HabitText.schedule(.weekly(target: 1, remind: nil), locale: us) == "1 day a week")
        #expect(HabitText.schedule(.daily(slots: [HabitSlot(id: "once", name: "")]), locale: us) == "Every day")
    }

    @Test("the Today list: what is still to do, soonest first; then what is done; then what expects nothing")
    func todayOrder() {
        var floss = brush
        floss.id = 3
        floss.name = "Floss"
        floss.today = HabitDay(day: brush.today.day, state: .open, slots: [.init(id: "morning"), .init(id: "evening")])
        var done = brush
        done.id = 4
        done.today.state = .done
        done.today.slots[1].done = true
        var off = brush
        off.id = 5
        off.today = HabitDay(day: brush.today.day, state: .off)
        var paused = gym
        paused.id = 6
        paused.paused = true
        var archived = brush
        archived.id = 7
        archived.archived = true
        let today = [done, gym, brush, off, floss, paused, archived].forToday()
        #expect(today.due.map(\.id) == [3, 1], "the morning still to do comes before the evening still to do")
        #expect(today.done.map(\.id) == [4, 2], "gym was checked in today, though its week isn't met yet")
        #expect(today.off.map(\.id) == [5, 6])
        #expect(brush.nextDue == (21 * 60 + 30) - 3 * 60 && floss.nextDue == (7 * 60 + 30) - 3 * 60, "minutes after the 3 AM day start")
        #expect([done, gym, brush, off, floss, paused].leftToday == 3, "one slot of Brush teeth and two of Floss")
        // A habit counted in weeks with no check-in today is due, at its reminder time on a reminder day.
        var visit = gym
        visit.today = HabitDay(day: Day("2026-10-07")!, state: .open, isSession: true) // a Wednesday
        #expect(visit.isDueToday && visit.nextDue == (17 * 60 + 30) - 3 * 60)
        visit.today.day = Day("2026-10-08")!
        #expect(visit.nextDue == nil, "Thursday is not a reminder day")
        visit.week?.state = .met
        #expect(!visit.isDueToday && visit.isDoneToday)
    }

    @Test("a streak at risk, and one that has ended, are said kindly")
    func streaks() {
        var risky = brush
        risky.streak = HabitStreak(current: 12, best: 21, unit: .days, atRisk: .init(day: Day("2026-10-06")!, missing: ["evening"]))
        risky.yesterday.slots[1] = .init(id: "evening")
        risky.yesterday.state = .open
        #expect(HabitText.atRisk(risky) == "Log yesterday’s evening by the end of today to keep your 12-day streak.")
        #expect(HabitText.atRisk(brush) == nil)

        var over = brush
        over.streak = HabitStreak(current: 0, best: 21, unit: .days, previous: .init(length: 14, lastDay: Day("2026-10-04")))
        #expect(HabitText.ended(over, locale: us) == "Your 14-day streak ended after Sunday. Your best is 21 days. Today starts a new one.")
        over.streak.best = 14
        over.streak.previous?.lastDay = nil
        #expect(HabitText.ended(over, locale: us) == "Your 14-day streak ended. That is your best so far. Today starts a new one.")
        over.streak.current = 1
        #expect(HabitText.ended(over) == nil, "a new one is under way")
        over.streak = HabitStreak(current: 0, best: 1, unit: .days, previous: .init(length: 1))
        #expect(HabitText.ended(over) == nil, "one day is not a streak to mourn")
        var weeks = gym
        weeks.streak = HabitStreak(current: 0, best: 6, unit: .weeks, previous: .init(length: 4, lastWeek: Day("2026-09-21")))
        #expect(HabitText.ended(weeks, locale: us) == "Your 4-week streak ended. Your best is 6 weeks. This week starts a new one.")
        #expect(HabitText.length(1, .days) == "1 day" && HabitText.length(3, .weeks) == "3 weeks")
        #expect(HabitText.rate(0.934) == "93%" && HabitText.rate(1) == "100%" && HabitText.rate(nil) == "–")
    }
}

@Suite("Habits: the widget's button")
struct WidgetCheckInTests {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-widget-tests-\(UUID().uuidString)", isDirectory: true)
    let zone = HabitSample.chicago
    let stub = StubTransport()
    func at(_ stamp: String) -> Date { HabitSample.at(stamp) }

    /// The phone as the app left it: the sample habits, kept on disk. (Wednesday 7 October; Brush teeth's morning is done.)
    func kept() async -> LocalStore {
        let store = LocalStore(directory: directory)
        await store.replaceHabits(HabitSample.list.habits, version: 9, zone: zone.identifier)
        return store
    }

    func tap(_ habit: Int, slot: String? = nil, day: String? = nil, _ stamp: String, client: HubClient? = nil) async -> WidgetCheckIn.Result {
        await WidgetCheckIn.perform(habit: habit, slot: slot, day: day.flatMap(Day.init), in: directory, client: client, now: at(stamp), zone: zone, patience: 2)
    }

    @Test("with no way to reach the Mac the check-in is saved for the app to send, and shows meanwhile")
    func saved() async {
        _ = await kept()
        let result = await tap(1, "2026-10-07 21:40")
        #expect(result == .init(outcome: .waiting, slot: "evening", day: Day("2026-10-07")))
        // Another process, the app or the widget drawing itself, finds it in the queue.
        let read = LocalStore.read(directory: directory).changes
        #expect(read.count == 1)
        guard case .checkIn(1, "Brush teeth", "evening", Day("2026-10-07")!, let when, "America/Chicago", .widget, false)? = read.first?.kind else {
            Issue.record("expected a check-in from the widget to be waiting")
            return
        }
        #expect(when == at("2026-10-07 21:40"))
        let shown = LocalStore.readHabits(directory: directory).habits.reckoned(with: read, now: at("2026-10-07 21:41"), zone: zone)
        #expect(shown[0].today.isComplete && shown[0].streak.current == 3)
        // Tapped again before the widget has redrawn: nothing is left, so nothing more is saved.
        #expect(await tap(1, "2026-10-07 21:42").outcome == .nothingToDo)
        #expect(LocalStore.read(directory: directory).changes.count == 1)
    }

    @Test("with the Mac in reach it is sent at once, and what the Mac answers is kept for the app")
    func sent() async {
        _ = await kept()
        var done = HabitSample.brush
        done.today.slots[1] = HabitDay.Slot(id: "evening", done: true, at: at("2026-10-07 21:40"), by: "me", via: "iPhone", source: "widget", checkins: [8])
        done.today.state = .done
        done.streak.current = 3
        stub.reply(201, "{\"habit\":\(HabitSample.json(done)),\"checkin\":null}")
        let result = await tap(1, "2026-10-07 21:40", client: Sample.client(stub))
        #expect(result.outcome == .sent && result.slot == "evening")
        #expect(stub.last.url?.path == "/api/v1/habits/1/checkins" && stub.body()["source"] as? String == "widget" && stub.last.value(forHTTPHeaderField: "Idempotency-Key") != nil)
        #expect(LocalStore.read(directory: directory).changes.isEmpty)
        #expect(LocalStore.readHabits(directory: directory).habits[0].streak.current == 3)

        // The Mac can't be reached: it doesn't keep anyone waiting, and the check-in stays for later.
        let gone = StubTransport()
        gone.fail(.timedOut)
        #expect(await tap(2, day: "2026-10-06", "2026-10-07 21:45", client: Sample.client(gone)).outcome == .waiting)
        #expect(LocalStore.read(directory: directory).changes.count == 1)
    }

    @Test("which slot, which day, and when there is nothing to do")
    func choosing() async {
        _ = await kept()
        // A widget drawn yesterday and tapped today still means the day it showed.
        let late = await tap(2, day: "2026-10-06", "2026-10-07 21:40")
        #expect(late == .init(outcome: .waiting, slot: nil, day: Day("2026-10-06")), "the gym, for yesterday")
        guard case .checkIn(_, _, nil, _, _, _, .widget, true)? = LocalStore.read(directory: directory).changes.last?.kind else {
            Issue.record("expected it to be marked as logged late")
            return
        }
        #expect(await tap(2, "2026-10-07 21:40").outcome == .nothingToDo, "the gym was already checked in today")
        #expect(await tap(1, slot: "morning", "2026-10-07 21:40").outcome == .nothingToDo, "this morning is done")
        #expect(await tap(1, day: "2026-10-04", "2026-10-07 21:40").outcome == .nothingToDo, "too long ago to log")
        #expect(await tap(99, "2026-10-07 21:40").outcome == .nothingToDo, "no such habit any more")
        // The next day, with both still to do: the one whose time it is.
        #expect(await tap(1, "2026-10-08 21:00").slot == "evening")
        #expect(await tap(1, "2026-10-08 21:05").slot == "morning", "then whatever is left")
        #expect(await WidgetCheckIn.perform(habit: 1, in: nil, client: nil).outcome == .notPaired)
        #expect(WidgetCheckIn.notifications(habit: 1, slot: "evening", day: Day("2026-10-07")!) == ["habit-1-evening-2026-10-07", "habit-1-evening-2026-10-07-nudge", "snooze-1-evening-2026-10-07"])
        #expect(AppLinks.habit(from: AppLinks.habit(12)) == 12 && AppLinks.habit(from: AppLinks.task(12)) == nil && AppLinks.task(from: AppLinks.habit(12)) == nil)
    }
}
