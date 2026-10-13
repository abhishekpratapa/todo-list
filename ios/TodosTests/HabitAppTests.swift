// Habits in the app: loading them, checking in with and without a connection,
// taking a check-in back, and what happens with a Mac too old to have habits.
// The network is a stand-in Mac (FakeMac); the files on disk are real. That the
// phone and the real server agree on streaks is tested in TodosKit.

import Foundation
import Testing
@testable import Todos
@testable import TodosKit

@MainActor
@Suite("Habits in the app, online and off")
struct HabitAppTests {
    let mac = FakeMac()
    let keychain = KeychainCredentialStore(service: "com.abhishekpratapa.todos.tests.\(UUID().uuidString)")
    let credentials = try! HubCredentials(address: HubAddress("my-mac.tail1234.ts.net"), token: "test-token-\(UUID().uuidString)")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todos-habit-tests-\(UUID().uuidString)", isDirectory: true)
    private let channel = AsyncStream.makeStream(of: LiveState.self)
    var live: AsyncStream<LiveState>.Continuation { channel.continuation }

    func launch() -> AppModel {
        AppModel(credentials: keychain, makeClient: { [mac] in mac.client($0) }, liveStates: { [channel] _ in channel.stream }, dataDirectory: directory)
    }

    func paired() async -> AppModel {
        let model = launch()
        #expect(await model.pair(credentials) == nil)
        return model
    }

    func cleanUp() {
        try? keychain.clear()
        try? FileManager.default.removeItem(at: directory)
    }

    func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    @Test("habits load with the list; a check-in shows at once and reaches the Mac")
    func checkingIn() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth", streak: 6)
        mac.addHabit("Gym", weekly: 3)
        mac.add("An ordinary task")
        let model = await paired()
        #expect(model.habitsSupported == true && model.habits.map(\.name) == ["Brush teeth", "Gym"] && model.tasks.count == 1)
        #expect(model.habits.leftToday == 3 && model.habits.forToday().due.count == 2)

        await model.checkIn(try #require(model.habit(brush.id)), slot: "morning")
        #expect(model.habit(brush.id)?.today.slots.map(\.done) == [true, false])
        #expect(mac.habit(brush.id)?.today.slots.map(\.done) == [true, false], "it reached the Mac")
        #expect(model.changes.isEmpty && model.habits.leftToday == 2)

        // With no slot named, it is the one still to do. The day is then done and the streak a day longer.
        await model.checkIn(try #require(model.habit(brush.id)))
        #expect(model.habit(brush.id)?.today.isComplete == true && model.habit(brush.id)?.streak.current == 7)
        await model.checkIn(try #require(model.habit(brush.id)))
        #expect(mac.recordedCheckins == 2, "nothing is left to check in, so nothing is sent")

        // A habit counted in weeks: one visit a day.
        let gym = try #require(model.habits.first { $0.isWeekly })
        await model.checkIn(gym)
        #expect(model.habit(gym.id)?.today.state == .done && model.habit(gym.id)?.week?.count == 1)
        await model.checkIn(try #require(model.habit(gym.id)))
        #expect(mac.recordedCheckins == 3)
        // Checking in a habit doesn't disturb the tasks, or show up among them.
        #expect(model.tasks.count == 1 && model.waitingAdditions.isEmpty)
    }

    @Test("with no connection a check-in waits, shows, survives a relaunch, and is sent once when the Mac is back")
    func offline() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth", streak: 6)
        var model = await paired()
        mac.isUnreachable = true
        await model.checkIn(try #require(model.habit(brush.id)), slot: "morning")
        await model.checkIn(try #require(model.habit(brush.id)), slot: "evening")
        #expect(model.habit(brush.id)?.today.isComplete == true && model.habit(brush.id)?.streak.current == 7, "shown as done, with the streak it will have")
        #expect(model.waiting.count == 2 && model.hasWaitingChanges(habit: brush.id) && model.issue != nil)
        #expect(model.waiting.map(\.summary) == ["Check in (morning)", "Check in (evening)"] && model.title(for: model.waiting[0]) == "Brush teeth")
        #expect(mac.habit(brush.id)?.today.done == 0)

        // The app is closed and opened again, still with no connection.
        model = launch()
        await model.start()
        #expect(model.habit(brush.id)?.today.isComplete == true && model.waiting.count == 2, "nothing was lost")

        // A slip: the evening is taken back before it was ever sent. Both the check-in and its undo wait.
        await model.undoCheckIn(try #require(model.habit(brush.id)), slot: "evening")
        #expect(model.habit(brush.id)?.today.slots.map(\.done) == [true, false] && model.habit(brush.id)?.streak.current == 6)
        #expect(model.waiting.count == 3)

        mac.isUnreachable = false
        await model.activate()
        #expect(await eventually { model.changes.isEmpty })
        #expect(mac.habit(brush.id)?.today.slots.map(\.done) == [true, false], "the Mac ends up where the phone was")
        #expect(model.habit(brush.id)?.today.slots.map(\.done) == [true, false] && model.issue == nil)
        // Sent again by a retry, a check-in is recorded once.
        let writes = mac.writes.count
        await model.send()
        #expect(mac.writes.count == writes && mac.recordedCheckins == 1)
    }

    @Test("taking a check-in back names what the Mac has and what is still waiting here")
    func undoing() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth")
        mac.checkIn(brush.id, slot: "morning") // on the Mac, or by another device
        let model = await paired()
        #expect(model.habit(brush.id)?.today.slots[0].checkins.count == 1)

        // Checked in again here, offline, not knowing; then all of it taken back.
        mac.isUnreachable = true
        await model.checkIn(try #require(model.habit(brush.id)), slot: "morning")
        await model.undoCheckIn(try #require(model.habit(brush.id)), slot: "morning")
        #expect(model.habit(brush.id)?.today.slots[0].done == false)
        guard case .undoCheckIn(_, _, let slot, _, let checkins, let keys, _)? = model.waiting.last?.kind else {
            Issue.record("expected an undo to be waiting")
            return
        }
        #expect(slot == "morning" && checkins.count == 1 && keys == [model.waiting[0].id])
        // Nothing left to take back: nothing more is queued.
        await model.undoCheckIn(try #require(model.habit(brush.id)), slot: "morning")
        #expect(model.waiting.count == 2)

        mac.isUnreachable = false
        await model.send()
        #expect(model.changes.isEmpty && mac.habit(brush.id)?.today.slots[0].done == false && mac.recordedCheckins == 0)
    }

    @Test("a rest day, and taking it back")
    func skipping() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth", streak: 3)
        let model = await paired()
        await model.skip(try #require(model.habit(brush.id)))
        #expect(model.habit(brush.id)?.today.state == .skipped && mac.habit(brush.id)?.today.state == .skipped)
        #expect(model.habits.leftToday == 0 && model.habits.forToday().due.isEmpty)
        await model.undoSkip(try #require(model.habit(brush.id)))
        #expect(model.habit(brush.id)?.today.state == .open && mac.habit(brush.id)?.today.state == .open)
    }

    @Test("what the Mac refuses is kept with its reason, for the user to see")
    func refused() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth")
        let model = await paired()
        mac.refusesCheckIns = "You can log yesterday until the end of today, but no further back."
        await model.checkIn(try #require(model.habit(brush.id)), slot: "morning")
        #expect(model.needingAttention.count == 1 && model.waiting.isEmpty)
        #expect(model.notice?.text == "You can log yesterday until the end of today, but no further back." && model.notice?.isError == true)
        #expect(model.habit(brush.id)?.today.slots[0].done == false, "it shows as the Mac has it")
        await model.discard(model.needingAttention[0])
        #expect(model.changes.isEmpty)
    }

    @Test("the Mac says its habits changed: they are fetched, and the list is left alone")
    func liveUpdate() async throws {
        defer { cleanUp() }
        let brush = mac.addHabit("Brush teeth")
        let model = await paired()
        let listFetches = { mac.requests.filter { $0.url?.path == "/api/v1/tasks" }.count }
        let before = listFetches()
        mac.checkIn(brush.id, slot: "evening")
        live.yield(.habitsChanged(version: mac.habitsVersion))
        #expect(await eventually { model.habit(brush.id)?.today.slots[1].done == true })
        #expect(listFetches() == before)
        // The same version again asks for nothing.
        let requests = mac.requests.count
        live.yield(.habitsChanged(version: mac.habitsVersion))
        try await Task.sleep(for: .milliseconds(100))
        #expect(mac.requests.count == requests)
    }

    @Test("the phone tells the Mac which time zone it is in, when the Mac has another")
    func zone() async throws {
        defer { cleanUp() }
        mac.addHabit("Brush teeth")
        mac.habitZone = TimeZone.current.identifier == "Asia/Tokyo" ? "Europe/Paris" : "Asia/Tokyo"
        let model = await paired()
        #expect(mac.habitZone == TimeZone.current.identifier)
        #expect(model.habits.count == 1)
        let reports = { mac.requests.filter { $0.url?.path == "/api/v1/habits/zone" }.count }
        #expect(reports() == 1)
        await model.refresh()
        #expect(reports() == 1, "and not again while they agree")
    }

    @Test("a Mac whose Todos is older has no habits: the app says so, and tasks work as before")
    func olderMac() async throws {
        defer { cleanUp() }
        mac.apiRevision = 4
        mac.add("An ordinary task")
        let model = await paired()
        #expect(model.habitsSupported == false && model.habits.isEmpty && model.issue == nil)
        #expect(model.tasks.map(\.title) == ["An ordinary task"])
        await model.complete(model.tasks[0].id)
        #expect(mac.all[0].status == .done)
        #expect(await model.saveHabit(HabitDraft.everyDay()) != nil, "and a habit can't be made")

        // Todos is updated on the Mac: next time, the habits are there.
        mac.apiRevision = 5
        mac.addHabit("Brush teeth")
        await model.refresh()
        #expect(model.habitsSupported == true && model.habits.map(\.name) == ["Brush teeth"])
    }

    @Test("making and changing a habit needs the Mac; without it nothing is queued and the reason is given")
    func managing() async throws {
        defer { cleanUp() }
        let model = await paired()
        var draft = HabitDraft.twiceADay()
        draft.name = "Floss"
        draft.icon = "🧵"
        #expect(await model.saveHabit(draft) == nil)
        let floss = try #require(model.habits.first)
        #expect(floss.name == "Floss" && floss.icon == "🧵" && floss.today.slots.map(\.id) == ["morning", "evening"])

        // Changed on the Mac meanwhile: the edit is not applied, and the Mac's version is shown.
        var edit = HabitDraft(floss)
        edit.name = "Floss properly"
        #expect(await model.setHabit(floss, paused: true) == nil && model.habit(floss.id)?.paused == true)
        let conflict = await model.saveHabit(edit, editing: floss)
        #expect(conflict?.contains("changed on your Mac") == true && model.habit(floss.id)?.name == "Floss")
        #expect(await model.saveHabit(edit, editing: try #require(model.habit(floss.id))) == nil && model.habit(floss.id)?.name == "Floss properly")

        mac.isUnreachable = true
        let offline = await model.saveHabit(HabitDraft.everyDay())
        #expect(offline?.contains("can’t be reached") == true && model.changes.isEmpty && model.habits.count == 1)
        #expect(await model.deleteHabit(try #require(model.habit(floss.id))) != nil && model.habits.count == 1)
        mac.isUnreachable = false

        #expect(await model.setHabit(try #require(model.habit(floss.id)), archived: true) == nil && model.habits.isEmpty, "an archived habit leaves the list")
        mac.addHabit("Brush teeth")
        await model.refreshHabits()
        #expect(await model.deleteHabit(try #require(model.habits.first)) == nil && model.habits.isEmpty && mac.allHabits.filter { !$0.archived }.isEmpty)
    }

    @Test("unpairing forgets the habits kept here")
    func unpairing() async throws {
        defer { cleanUp() }
        mac.addHabit("Brush teeth")
        let model = await paired()
        #expect(model.habits.count == 1)
        await model.unpair(erasingData: true)
        #expect(model.habits.isEmpty && model.habitsSupported == nil)
        let again = launch()
        await again.start()
        #expect(again.phase == .unpaired && again.habits.isEmpty)
    }
}
