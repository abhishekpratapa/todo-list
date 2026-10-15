// Habits against a real Todos server (temporary data directory).
//
// The Mac works streaks out; between syncs the phone reckons them itself
// (HabitReckoning.swift). Most of these tests hold the two to the same answer:
// the phone is given what the Mac said on some day, makes changes "offline" over
// the days that follow, and its reckoning at each point is compared with what
// the Mac says at that same point once those changes have reached it. The
// server's clock is pinned for each question, so the days are whatever the test says.

#if os(macOS)
import Foundation
import Testing
@testable import TodosKit

@Suite("Habits, against a real Todos server", .enabled(if: TestHub.node != nil, "Node.js is needed to run the Todos server"))
struct HabitIntegrationTests {
    let hub: TestHub
    let phone: HubClient
    let store: LocalStore
    let engine: SyncEngine

    static let zone = TimeZone(identifier: "America/Chicago")!
    /// A Monday five weeks back, so every day these tests speak of is in the past.
    static let origin = Day(Date(), calendar: .gregorian(in: zone)).weekStart.adding(days: -35)

    static var twice: [String: Any] {
        ["kind": "daily", "slots": [
            ["name": "Morning", "remind": "07:30", "from": "05:00", "until": "11:00"],
            ["name": "Evening", "remind": "21:30", "from": "19:00", "until": "02:00"],
        ]]
    }

    init() throws {
        hub = try TestHub()
        phone = hub.phone()
        store = LocalStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-habits-\(UUID().uuidString)", isDirectory: true))
        engine = SyncEngine(client: phone, store: store)
        try hub.habitZone(Self.zone.identifier, at: at(-1, "12:00"))
    }

    // MARK: Days and moments

    func day(_ offset: Int) -> Day {
        Self.origin.adding(days: offset)
    }

    /// `time` on a clock in Chicago, `offset` days after the origin.
    func at(_ offset: Int, _ time: String) -> Date {
        let day = day(offset)
        let clock = ClockTime(time)!
        return Calendar.gregorian(in: Self.zone).date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: clock.hour, minute: clock.minute))!
    }

    // MARK: Changes made on the phone

    func checkIn(_ habit: Habit, _ slot: String?, _ offset: Int, _ time: String, forYesterday: Bool = false) -> PendingChange {
        let when = at(offset, time)
        let today = HabitClock.day(of: when, zone: Self.zone, dayStart: habit.dayStart)
        return PendingChange(createdAt: when, kind: .checkIn(habit: habit.id, name: habit.name, slot: slot, day: forYesterday ? today.adding(days: -1) : today,
                                                              at: when, zone: Self.zone.identifier, source: .manual, backfilled: forYesterday))
    }

    func skip(_ habit: Habit, _ offset: Int, _ time: String) -> PendingChange {
        let when = at(offset, time)
        return PendingChange(createdAt: when, kind: .skipHabit(habit: habit.id, name: habit.name, day: HabitClock.day(of: when, zone: Self.zone, dayStart: habit.dayStart),
                                                                at: when, zone: Self.zone.identifier, reason: nil))
    }

    /// The phone, offline: everything it has done since it last heard from the Mac.
    final class Offline: @unchecked Sendable {
        var heard: Habit
        var changes: [PendingChange] = []
        init(_ heard: Habit) { self.heard = heard }
    }

    /// The phone does these things without a connection; then they reach the Mac. The
    /// phone's own reckoning at `offset`/`time` must be what the Mac says at that moment.
    @discardableResult
    func then(_ offline: Offline, _ new: [PendingChange], at offset: Int, _ time: String, _ note: String, sourceLocation: SourceLocation = #_sourceLocation) async throws -> (mine: Habit, theirs: Habit) {
        offline.changes += new
        for change in new { await store.put(change) }
        #expect(await engine.replay() == .finished, "\(note): delivered", sourceLocation: sourceLocation)
        #expect(await store.changes.isEmpty, "\(note): nothing refused", sourceLocation: sourceLocation)

        let moment = at(offset, time)
        let mine = offline.heard.reckoned(with: offline.changes, now: moment, zone: Self.zone)
        let theirs = try #require(try hub.habits(at: moment).first { $0.id == offline.heard.id }, sourceLocation: sourceLocation)
        func same<T: Equatable>(_ what: String, _ a: T, _ b: T) {
            #expect(a == b, "\(note): \(what)", sourceLocation: sourceLocation)
        }
        same("today", mine.today.day, theirs.today.day)
        same("today's state", mine.today.state, theirs.today.state)
        same("today's slots", mine.today.slots.map(\.done), theirs.today.slots.map(\.done))
        same("yesterday's state", mine.yesterday.state, theirs.yesterday.state)
        same("yesterday's slots", mine.yesterday.slots.map(\.done), theirs.yesterday.slots.map(\.done))
        same("streak", mine.streak.current, theirs.streak.current)
        same("best", mine.streak.best, theirs.streak.best)
        same("at risk", mine.streak.atRisk?.day, theirs.streak.atRisk?.day)
        same("what is missing", mine.streak.atRisk?.missing, theirs.streak.atRisk?.missing)
        same("until when", mine.streak.atRisk?.until, theirs.streak.atRisk?.until)
        same("the streak before", mine.streak.previous?.length, theirs.streak.previous?.length)
        same("this week", mine.week.map { [$0.start.description, $0.state.rawValue, "\($0.count)/\($0.target)"] }, theirs.week.map { [$0.start.description, $0.state.rawValue, "\($0.count)/\($0.target)"] })
        same("this week's days", mine.week?.days, theirs.week?.days)
        same("last week", mine.lastWeek.map { [$0.start.description, $0.state.rawValue, "\($0.count)/\($0.target)"] }, theirs.lastWeek.map { [$0.start.description, $0.state.rawValue, "\($0.count)/\($0.target)"] })
        return (mine, theirs)
    }

    // MARK: The phone's reckoning against the Mac's

    @Test("a habit with slots, over a week offline: done days, a late log, a missed day, a skip, an undo")
    func daysOffline() async throws {
        let made = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice], at: at(0, "06:00"))
        for offset in 0...1 {
            try hub.habitCheckIn(made.id, ["slot": "morning"], at: at(offset, "07:00"))
            try hub.habitCheckIn(made.id, ["slot": "evening"], at: at(offset, "21:00"))
        }
        // The last the phone hears: early on day 2, with a streak of two.
        let heard = try #require(try hub.habits(at: at(2, "06:30")).first)
        #expect(heard.streak.current == 2 && heard.today.state == .open && heard.today.day == day(2))
        let offline = Offline(heard)

        var now = try await then(offline, [checkIn(heard, "morning", 2, "07:00"), checkIn(heard, "evening", 2, "21:00")], at: 2, "22:00", "day 2 done")
        #expect(now.mine.streak.current == 3 && now.mine.today.isComplete)

        now = try await then(offline, [checkIn(heard, "morning", 3, "07:00")], at: 3, "23:00", "day 3 half done")
        #expect(now.mine.streak.current == 3 && now.mine.today.done == 1)

        // After midnight it is still day 3; at 3 AM it is day 4, and day 3 can still be finished.
        now = try await then(offline, [], at: 4, "01:00", "after midnight")
        #expect(now.mine.today.day == day(3))
        now = try await then(offline, [], at: 4, "09:00", "day 4, with day 3 unfinished")
        #expect(now.mine.streak.atRisk?.day == day(3) && now.mine.streak.atRisk?.missing == ["evening"] && now.mine.streak.current == 3)

        now = try await then(offline, [checkIn(heard, "evening", 4, "09:30", forYesterday: true)], at: 4, "10:00", "day 3 logged late")
        #expect(now.mine.streak.current == 4 && now.mine.streak.atRisk == nil && now.mine.yesterday.isComplete)

        now = try await then(offline, [checkIn(heard, "morning", 4, "10:05"), checkIn(heard, "evening", 4, "21:00")], at: 4, "22:00", "day 4 done")
        #expect(now.mine.streak.current == 5)

        // Day 5 goes by with nothing; day 6 is skipped. On day 7 the streak of five is over.
        now = try await then(offline, [], at: 5, "23:00", "day 5, nothing yet")
        #expect(now.mine.streak.current == 5, "an unfinished today breaks nothing")
        now = try await then(offline, [skip(heard, 6, "20:00")], at: 6, "21:00", "day 6 skipped")
        #expect(now.mine.today.state == .skipped && now.mine.streak.current == 5, "and day 5 is not closed until day 6 ends")
        now = try await then(offline, [], at: 7, "08:00", "day 7: day 5 has closed")
        #expect(now.mine.streak.current == 0 && now.mine.streak.previous?.length == 5 && now.mine.streak.best == 5 && now.mine.yesterday.state == .skipped)

        let again = [checkIn(heard, "morning", 7, "08:30"), checkIn(heard, "evening", 7, "21:00")]
        now = try await then(offline, again, at: 7, "22:00", "a new streak")
        #expect(now.mine.streak.current == 1)

        // A slip of the thumb, taken back: the undo names this iPhone's own check-in.
        let undo = PendingChange(createdAt: at(7, "22:10"), kind: .undoCheckIn(habit: heard.id, name: heard.name, slot: "evening", day: day(7), checkins: [], keys: [again[1].id], at: at(7, "22:10")))
        now = try await then(offline, [undo], at: 7, "22:20", "the evening taken back")
        #expect(now.mine.streak.current == 0 && now.mine.today.slots.map(\.done) == [true, false])
    }

    @Test("a check-in made on the Mac, taken back on the phone; and a skip taken back")
    func undoingWhatTheMacHas() async throws {
        let made = try hub.habitCreate(["name": "Floss", "schedule": Self.twice], at: at(0, "06:00"))
        try hub.habitCheckIn(made.id, ["slot": "morning"], at: at(0, "07:00"))
        try hub.habitCheckIn(made.id, ["slot": "evening"], at: at(0, "21:00"))
        try hub.habitCheckIn(made.id, ["slot": "morning"], at: at(1, "07:00"), by: "Claude Code · repo")
        let heard = try #require(try hub.habits(at: at(1, "08:00")).first)
        let morning = try #require(heard.today.slots.first)
        #expect(morning.done && morning.checkins.count == 1 && morning.by == "Claude Code · repo")
        let offline = Offline(heard)

        let undo = PendingChange(createdAt: at(1, "08:05"), kind: .undoCheckIn(habit: heard.id, name: heard.name, slot: "morning", day: day(1), checkins: morning.checkins, keys: [], at: at(1, "08:05")))
        var now = try await then(offline, [undo], at: 1, "08:10", "the Mac's check-in taken back")
        #expect(now.mine.today.slots.map(\.done) == [false, false])

        let rest = skip(heard, 1, "20:00")
        now = try await then(offline, [rest], at: 1, "20:30", "a rest day")
        #expect(now.mine.today.state == .skipped && now.mine.skipsLeft == now.theirs.skipsLeft)
        let back = PendingChange(createdAt: at(1, "20:40"), kind: .undoSkip(habit: heard.id, name: heard.name, day: day(1), at: at(1, "20:40"), zone: Self.zone.identifier))
        now = try await then(offline, [back], at: 1, "20:50", "the skip taken back")
        #expect(now.mine.today.state == .open && now.mine.skipsLeft == now.theirs.skipsLeft)
    }

    @Test("a habit on chosen weekdays, and one that is paused")
    func weekdaysAndPauses() async throws {
        let schedule: [String: Any] = ["kind": "days", "days": ["mon", "wed", "fri"], "slots": [["name": "Run", "remind": "06:30"]]]
        let made = try hub.habitCreate(["name": "Run", "schedule": schedule], at: at(0, "06:00")) // a Monday
        try hub.habitCheckIn(made.id, [:], at: at(0, "07:00"))
        let heard = try #require(try hub.habits(at: at(1, "08:00")).first)
        #expect(heard.today.state == .off, "Tuesday expects nothing")
        let offline = Offline(heard)
        var now = try await then(offline, [checkIn(heard, "run", 2, "07:00")], at: 2, "08:00", "Wednesday done")
        #expect(now.mine.streak.current == 2)
        now = try await then(offline, [], at: 3, "08:00", "Thursday is off")
        #expect(now.mine.today.state == .off && now.mine.streak.current == 2)
        now = try await then(offline, [], at: 6, "08:00", "Friday was missed, and by Sunday it has closed")
        #expect(now.mine.streak.current == 0 && now.mine.streak.previous?.length == 2)

        // Paused on the Mac: the phone hears so, and expects nothing from then on.
        let paused = try hub.habitUpdate(made.id, ["paused": true], at: at(7, "09:00"))
        #expect(paused.paused)
        let resting = Offline(try #require(try hub.habits(at: at(7, "09:30")).first))
        now = try await then(resting, [], at: 16, "09:00", "nine days into a pause")
        #expect(now.mine.today.state == .off && now.mine.streak.current == now.theirs.streak.current)
    }

    @Test("a habit counted in weeks, over a month offline: a week met, one saved on Monday, one missed, one skipped")
    func weeksOffline() async throws {
        let made = try hub.habitCreate(["name": "Gym", "schedule": ["kind": "weekly", "target": 3]], at: at(0, "06:00")) // a Monday
        for offset in [0, 2, 4] { try hub.habitCheckIn(made.id, [:], at: at(offset, "18:00")) }
        let heard = try #require(try hub.habits(at: at(7, "07:00")).first)
        #expect(heard.streak.current == 1 && heard.streak.unit == .weeks && heard.lastWeek?.state == .met && heard.week?.count == 0)
        let offline = Offline(heard)

        var now = try await then(offline, [checkIn(heard, nil, 7, "18:00"), checkIn(heard, nil, 7, "19:00"), checkIn(heard, nil, 8, "18:00")], at: 13, "20:00", "week two, one short on Sunday")
        #expect(now.mine.week?.count == 2 && now.mine.streak.current == 1, "twice on Monday is one day")

        now = try await then(offline, [], at: 14, "10:00", "Monday: last week can still be saved")
        #expect(now.mine.streak.atRisk?.day == day(13) && now.mine.lastWeek?.state == .open)
        now = try await then(offline, [checkIn(heard, nil, 14, "10:05", forYesterday: true)], at: 14, "10:10", "Sunday logged on Monday")
        #expect(now.mine.streak.current == 2 && now.mine.lastWeek?.state == .met && now.mine.streak.atRisk == nil)

        // Week three: one visit. By the Wednesday after, it has closed and the streak is over.
        now = try await then(offline, [checkIn(heard, nil, 15, "18:00")], at: 20, "20:00", "week three, well short")
        #expect(now.mine.streak.current == 2)
        now = try await then(offline, [], at: 23, "09:00", "week three has closed")
        #expect(now.mine.streak.current == 0 && now.mine.streak.previous?.length == 2)

        // Week four is a rest week; week five is met.
        now = try await then(offline, [skip(heard, 24, "09:00")], at: 24, "10:00", "week four skipped")
        #expect(now.mine.week?.state == .skipped)
        now = try await then(offline, [checkIn(heard, nil, 28, "18:00"), checkIn(heard, nil, 30, "18:00"), checkIn(heard, nil, 31, "18:00")], at: 32, "09:00", "week five met")
        #expect(now.mine.streak.current == 1 && now.mine.week?.state == .met && now.mine.today.state == .open && now.mine.yesterday.state == .done)
    }

    // MARK: The queue

    @Test("a check-in made while the Mac can't be reached waits, shows at once, and is recorded once when sent twice")
    func offlineThenSync() async throws {
        let made = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice])
        let fetched = try await engine.refreshHabits()
        #expect(fetched.habits.map(\.name) == ["Brush teeth"] && fetched.supported == true && fetched.zone == Self.zone.identifier)
        let habit = try #require(fetched.habits.first)

        try hub.command("listening", ["on": false])
        let tapped = Date()
        let change = await store.add(.checkIn(habit: habit.id, name: habit.name, slot: "morning", day: habit.today.day, at: tapped, zone: Self.zone.identifier, source: .widget, backfilled: false), at: tapped)
        guard case .interrupted = await engine.replay() else {
            Issue.record("the Mac is not listening, so the check-in should have waited")
            return
        }
        #expect(await store.changes.map(\.id) == [change.id], "still waiting, nothing dropped")
        let shown = habit.reckoned(with: await store.changes, now: tapped, zone: Self.zone)
        #expect(shown.today.slots.map(\.done) == [true, false] && shown.today.slots[0].via == "iPhone", "shown as done straight away")

        try hub.command("listening", ["on": true])
        #expect(await engine.replay() == .finished)
        #expect(await store.changes.isEmpty)
        let kept = try #require(await store.habits.habits.first)
        #expect(kept.today.slots[0].done && kept.today.slots[0].source == "widget" && kept.today.slots[0].via == "iPhone")

        // The answer to the first try is lost and it goes again with the same key: still one check-in.
        await store.put(change)
        #expect(await engine.replay() == .finished)
        let history = try await phone.habitHistory(made.id)
        #expect(history.events.count == 1 && history.events[0].slot == "morning" && history.events[0].undone == false)
        #expect(history.mark(for: habit.today.day) == "o" && history.days.count == 365)
    }

    @Test("the same slot checked in from the iPhone, another client and a Claude session is one slot, and every reader sees one streak")
    func oneStreakEverywhere() async throws {
        let made = try hub.habitCreate(["name": "Floss", "schedule": ["kind": "daily", "slots": [["name": "Evening", "remind": "21:30"]]]])
        let other = HubClient(credentials: try HubCredentials(address: HubAddress(loopbackPort: hub.port), token: hub.token), clientName: "todos 0.2.0",
                              session: .shared) { try await URLSession.shared.data(for: $0) }
        var relayed = other
        relayed.extraHeaders = hub.relayHeaders()

        let fromPhone = try await phone.checkIn(made.id, slot: "evening", key: UUID())
        let fromOther = try await relayed.checkIn(made.id, source: .shortcut, key: UUID())
        let fromClaude = try hub.habitCheckIn(made.id, ["source": "claude"], by: "Claude Code · repo")
        #expect(fromPhone.checkin?.via == "iPhone" && fromPhone.habit.streak.current == 1)
        #expect(fromOther.checkin == nil, "nothing was left to check in, and no slot was named")
        #expect(fromClaude.today.slots[0].checkins.count == 1)

        // Named, a second check-in of the same slot is kept and changes nothing else.
        let named = try await relayed.checkIn(made.id, slot: "evening", source: .shortcut, key: UUID())
        #expect(named.checkin?.via == "todos 0.2.0" && named.habit.today.slots[0].checkins.count == 2)
        let claude = try hub.habitCheckIn(made.id, ["slot": "evening", "source": "claude"], by: "Claude Code · repo")
        #expect(claude.today.slots[0].checkins.count == 3 && claude.today.done == 1 && claude.streak.current == 1)

        let seenByPhone = try await phone.habit(made.id)
        let seenByOther = try await relayed.habits().habits[0]
        let seenOnMac = try #require(try hub.habits().first)
        #expect(seenByPhone == seenByOther && seenByOther == seenOnMac, "one answer, whoever asks")
        #expect(seenOnMac.streak.current == 1 && seenOnMac.today.isComplete)

        // Taking back only the phone's leaves the slot done; taking back all three undoes it.
        let after = try await phone.undoCheckIns(made.id, checkins: [try #require(fromPhone.checkin?.id)], keys: [])
        #expect(after.today.slots[0].done && after.today.slots[0].checkins.count == 2)
        let cleared = try await phone.undoCheckIns(made.id, checkins: after.today.slots[0].checkins, keys: [])
        #expect(!cleared.today.slots[0].done && cleared.streak.current == 0)
    }

    @Test("what the Mac refuses is kept with its reason; a habit deleted on the Mac says so")
    func refusals() async throws {
        let made = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice])
        let habit = try #require(try await engine.refreshHabits().habits.first)
        let now = Date()
        // A check-in for three days ago: further back than can be logged.
        await store.add(.checkIn(habit: habit.id, name: habit.name, slot: "morning", day: habit.today.day.adding(days: -3), at: now, zone: Self.zone.identifier, source: .manual, backfilled: true), at: now)
        #expect(await engine.replay() == .finished)
        let refused = try #require(await store.changes.first)
        guard case .rejected(let message) = refused.state else {
            Issue.record("expected the check-in to be set aside")
            return
        }
        #expect(message.contains("until the end of today"))
        await store.discard(refused.id)

        try await phone.deleteHabit(made.id)
        await store.add(.checkIn(habit: habit.id, name: habit.name, slot: "morning", day: habit.today.day, at: now, zone: Self.zone.identifier, source: .manual, backfilled: false), at: now)
        #expect(await engine.replay() == .finished)
        guard case .rejected(let gone)? = await store.changes.first?.state else {
            Issue.record("expected the check-in to be set aside")
            return
        }
        #expect(gone == "“Brush teeth” was deleted on your Mac.")
        #expect(await store.habits.habits.isEmpty, "and the habit is gone from the phone too")
    }

    @Test("creating, editing, pausing and deleting a habit from the phone")
    func managing() async throws {
        var draft = HabitDraft.twiceADay()
        draft.name = "Brush teeth"
        draft.icon = "🪥"
        draft.color = .blue
        let made = try await phone.createHabit(draft, key: UUID())
        #expect(made.name == "Brush teeth" && made.icon == "🪥" && made.color == .blue && made.dayStart == .defaultDayStart)
        #expect(made.schedule.slots.map(\.id) == ["morning", "evening"], "the Mac names the slots")
        #expect(made.schedule.slots[1].until == ClockTime("02:00") && made.schedule.slots[0].remind == ClockTime("07:30"))
        #expect(made.today.state == .open && made.today.total == 2 && made.streak == HabitStreak(current: 0, best: 0, unit: .days))

        var edit = HabitDraft(made)
        edit.name = "Brush"
        edit.icon = ""
        edit.schedule = .daily(slots: made.schedule.slots.map { var slot = $0; slot.remind = ClockTime("08:00"); return slot })
        let edited = try await phone.updateHabit(made.id, rev: made.rev, edit)
        #expect(edited.name == "Brush" && edited.icon == nil && edited.rev == 2 && edited.schedule.slots.map(\.remind) == [ClockTime("08:00"), ClockTime("08:00")])
        await #expect(throws: HubError.habitConflict(current: edited)) { try await phone.updateHabit(made.id, rev: made.rev, edit) }

        let paused = try await phone.setHabit(made.id, paused: true)
        #expect(paused.paused && paused.today.state == .off)
        #expect(try await phone.setHabit(made.id, paused: false).today.state == .open)
        let weekly = try await phone.createHabit(HabitDraft(name: "Gym", schedule: .weekly(target: 3, remind: .init(days: [.mon, .wed, .fri], time: ClockTime("17:30")!))))
        #expect(weekly.isWeekly && weekly.week?.target == 3 && weekly.today.isSession && weekly.schedule == .weekly(target: 3, remind: .init(days: [.mon, .wed, .fri], time: ClockTime("17:30")!)))
        #expect(try await phone.habits().habits.map(\.name) == ["Brush", "Gym"])

        _ = try await phone.setHabit(weekly.id, archived: true)
        #expect(try await phone.habits().habits.map(\.name) == ["Brush"])
        #expect(try await phone.habits(includingArchived: true).habits.count == 2)
        try await phone.deleteHabit(made.id)
        await #expect(throws: HubError.self) { try await phone.habit(made.id) }
        try await phone.reportZone("Asia/Tokyo")
        #expect(try await phone.habits().zone == "Asia/Tokyo")
    }

    @Test("a check-in from the widget's button reaches the Mac, marked as the widget's, and once")
    func fromTheWidget() async throws {
        let made = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice])
        try await engine.refreshHabits()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-widget-\(UUID().uuidString)", isDirectory: true)
        let widget = LocalStore(directory: folder) // the same folder the app writes, as the widget finds it
        await widget.replaceHabits(await store.habits.habits, version: nil, zone: Self.zone.identifier)

        let result = await WidgetCheckIn.perform(habit: made.id, slot: "morning", in: folder, client: phone, zone: Self.zone)
        #expect(result.outcome == .sent && result.slot == "morning")
        let seen = try await phone.habit(made.id)
        #expect(seen.today.slots[0].done && seen.today.slots[0].source == "widget" && seen.today.slots[0].via == "iPhone")
        #expect(LocalStore.readHabits(directory: folder).habits.first?.today.slots[0].done == true, "what the Mac answered is kept for the app")

        // The Mac out of reach: saved, shown, and sent later by whoever runs next.
        try hub.command("listening", ["on": false])
        let waiting = await WidgetCheckIn.perform(habit: made.id, slot: "evening", in: folder, client: phone, zone: Self.zone, patience: 1)
        #expect(waiting.outcome == .waiting)
        #expect(await WidgetCheckIn.perform(habit: made.id, in: folder, client: phone, zone: Self.zone, patience: 1).outcome == .nothingToDo, "the widget already shows it done")
        try hub.command("listening", ["on": true])
        #expect(await SyncEngine(client: phone, store: LocalStore(directory: folder)).replay() == .finished)
        let after = try await phone.habitHistory(made.id)
        #expect(after.events.map(\.slot) == ["morning", "evening"] && after.events.allSatisfy { $0.source == "widget" })
    }

    @Test("the year so far, for the year widget: fetched from the Mac once a day, and read with today's own check-ins")
    func theYear() async throws {
        let brush = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice], at: at(0, "06:00"))
        let gym = try hub.habitCreate(["name": "Gym", "schedule": ["kind": "weekly", "target": 3]], at: at(0, "06:00"))
        try hub.habitCheckIn(brush.id, ["slot": "morning"], at: at(0, "07:00"))
        try hub.habitCheckIn(brush.id, ["slot": "evening"], at: at(0, "21:00"))
        try hub.habitCheckIn(brush.id, ["slot": "morning"], at: at(1, "07:00"))
        try hub.habitCheckIn(gym.id, [:], at: at(1, "18:00"))
        try hub.habitCheckIn(brush.id, ["slot": "morning"], at: at(3, "07:00"))
        try hub.habitCheckIn(brush.id, ["slot": "evening"], at: at(3, "21:00"))

        let fetched = try await engine.refreshHabits()
        let today = try #require(fetched.habits.map(\.today.day).max())
        try await engine.refreshCalendar(today: today)
        let calendar = try #require(await store.habits.calendar)
        let january = Day(year: today.year, month: 1, day: 1)!
        #expect(calendar.year == today.year && calendar.asOf == today && calendar.habits.map(\.habit) == [brush.id, gym.id])
        #expect(calendar.habits.allSatisfy { $0.days.count == today.days(since: january, calendar: .utc) + 1 }, "January 1 to today")
        guard day(0).year == today.year else { return } // early January: the days above are last year's

        let year = HabitYear(calendar: calendar, habits: fetched.habits.reckoned(now: Date(), zone: Self.zone), today: today)
        let mark = { (offset: Int) in year.marks[self.day(offset).days(since: january, calendar: .utc)] }
        #expect(mark(-1) == .none, "before the habits began")
        #expect(mark(0) == .complete && mark(1) == .partial && mark(2) == .missed && mark(3) == .complete)
        #expect(year.marks[year.today] == .open && year.completed == 2)

        // Asked again the same day, with the same habits: nothing to fetch, so it works with the Mac out of reach.
        try hub.command("listening", ["on": false])
        try await engine.refreshCalendar(today: today)
        try hub.command("listening", ["on": true])
        // A new habit: fetched again, and it is in.
        let floss = try hub.habitCreate(["name": "Floss", "schedule": Self.twice])
        try await engine.refreshHabits()
        try await engine.refreshCalendar(today: today)
        #expect(await store.habits.calendar?.habits.map(\.habit) == [brush.id, gym.id, floss.id])
        // A new day: fetched again.
        try await engine.refreshCalendar(today: today.adding(days: 1))
        #expect(await store.habits.calendar?.asOf == today.adding(days: 1))
    }

    @Test("habits are announced on the live connection, separately from the list")
    func liveUpdates() async throws {
        let made = try hub.habitCreate(["name": "Brush teeth", "schedule": Self.twice])
        try await Task.sleep(for: .milliseconds(200)) // let that be announced before anyone is listening
        let log = LiveLog()
        await log.start(LiveUpdates(client: phone))
        #expect(await log.saw { if case .live = $0 { true } else { false } })
        try hub.habitCheckIn(made.id, ["slot": "morning"])
        #expect(await log.saw { if case .habitsChanged = $0 { true } else { false } })
        #expect(await log.states.contains { if case .changed = $0 { true } else { false } } == false, "the list itself did not change")
        try hub.macCreate(["title": "An ordinary task"])
        #expect(await log.saw { if case .changed = $0 { true } else { false } })
        await log.stop()
    }
}
#endif
