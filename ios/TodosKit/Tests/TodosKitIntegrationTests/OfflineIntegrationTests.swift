// Offline changes replayed against a real Todos server (temporary data directory).
// "Offline" here means the phone only writes to its own store while the Mac's list
// changes underneath it; then the queue is sent.

#if os(macOS)
import Foundation
import Testing
@testable import TodosKit

@Suite("Offline changes, against a real Todos server", .enabled(if: TestHub.node != nil, "Node.js is needed to run the Todos server"))
struct OfflineIntegrationTests {
    let hub: TestHub
    let phone: HubClient
    let store: LocalStore
    let engine: SyncEngine

    init() throws {
        hub = try TestHub()
        phone = hub.phone()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-offline-\(UUID().uuidString)", isDirectory: true)
        store = LocalStore(directory: directory)
        engine = SyncEngine(client: phone, store: store)
    }

    /// Queues an edit the way the app does: with the fields as they were before it.
    private func edit(_ task: TodoTask, _ patch: TaskPatch) async {
        await store.add(.update(task: task.id, baseRev: task.rev, base: TaskPatch(of: task, fields: patch.fields), patch: patch))
    }

    @Test("an offline edit and a concurrent edit on the Mac to the same task: nothing is lost")
    func noLostData() async throws {
        let created = try hub.macCreate(["title": "Plan the launch", "priority": "medium", "notes": "Draft", "subtasks": ["Write copy", "Book room"], "tags": ["work"]])
        try await engine.refresh()
        let cached = try #require(await store.task(created.id))

        // On the phone, with no connection: rename it, tag it, check a subtask off, add a subtask, comment.
        await edit(cached, TaskPatch(title: "Plan the spring launch", tags: ["work", "q2"]))
        await store.add(.setSubtask(task: cached.id, subtask: 1, done: true))
        await store.add(.addSubtask(task: cached.id, title: "Invite the team", localID: -1))
        await store.add(.setSubtask(task: cached.id, subtask: -1, done: true))
        await store.add(.comment(task: cached.id, text: "Renamed it on the train."))

        // Meanwhile, on the Mac, a Claude session works on the same task.
        try hub.macUpdate(cached.id, ["priority": "high", "notes": "Draft v2, with numbers", "tags": ["work", "launch"], "comment": "Added the Q1 numbers."], by: "Claude Code · launch")
        try hub.macUpdate(cached.id, ["add_subtasks": ["Check the budget"]], by: "Claude Code · launch")

        // What the phone shows before it can connect: its own changes, on the list it last had.
        let shown = try #require(await store.task(cached.id)?.applying(await store.changes))
        #expect(shown.title == "Plan the spring launch" && shown.subtasks.count == 3 && shown.subtasks[0].done)

        #expect(await engine.replay() == .finished)
        #expect(await store.changes.isEmpty, "everything was accepted")

        let final = try await phone.task(cached.id)
        #expect(final.title == "Plan the spring launch", "my rename")
        #expect(final.priority == .high && final.notes == "Draft v2, with numbers", "the Mac's edits")
        #expect(final.tags == ["work", "launch", "q2"], "both sides' tags")
        #expect(final.subtasks.map(\.title) == ["Write copy", "Book room", "Check the budget", "Invite the team"])
        #expect(final.subtasks.map(\.done) == [true, false, false, true], "my two check marks, on the right subtasks")
        let comments = final.activity?.filter { $0.kind == .comment }.map(\.text)
        #expect(comments == ["Added the Q1 numbers.", "Renamed it on the train."])
        #expect(await store.task(cached.id) == final, "and the phone's copy now matches the Mac's")
    }

    @Test("when both changed the same field, the Mac's value stays, mine is kept for me to choose, and the rest goes through")
    func sameField() async throws {
        let created = try hub.macCreate(["title": "Call the bank", "due": "2027-01-10"])
        try await engine.refresh()
        let cached = try #require(await store.task(created.id))

        await edit(cached, TaskPatch(title: "Call the bank about the card", due: .set(Day("2027-01-12")!), project: .set("money")))
        try hub.macUpdate(cached.id, ["title": "Call the bank (urgent)", "due": "2027-01-11"], by: "Claude Code · finance")

        #expect(await engine.replay() == .finished)
        var onMac = try await phone.task(cached.id)
        #expect(onMac.title == "Call the bank (urgent)" && onMac.due == Day("2027-01-11"), "not overwritten")
        #expect(onMac.project == "money", "the field only I changed went through")

        let parked = try #require(await store.changes.first)
        #expect(await store.changes.count == 1)
        #expect(parked.kind == .update(task: cached.id, baseRev: onMac.rev,
                                       base: TaskPatch(title: "Call the bank", due: .set(Day("2027-01-10")!)),
                                       patch: TaskPatch(title: "Call the bank about the card", due: .set(Day("2027-01-12")!))), "my versions are kept")
        guard case .conflict(let theirs) = parked.state else {
            Issue.record("expected a conflict")
            return
        }
        #expect(theirs == onMac)
        #expect(await store.task(cached.id)?.applying(await store.changes)?.title == "Call the bank (urgent)", "the list shows the Mac's version until I decide")

        // I keep my title and take the Mac's date.
        #expect(await store.resolveEdit(parked.id, keeping: TaskPatch(title: "Call the bank about the card")))
        #expect(await engine.replay() == .finished)
        onMac = try await phone.task(cached.id)
        #expect(onMac.title == "Call the bank about the card" && onMac.due == Day("2027-01-11") && onMac.project == "money")
        #expect(await store.changes.isEmpty)
    }

    @Test("a line captured offline is read as of when it was typed, and sending it twice adds it once")
    func offlineCapture() async throws {
        // Typed three days ago at noon, while there was no connection.
        let typed = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date().addingTimeInterval(-3 * 86_400))!
        let change = await store.add(.capture(line: "Call dentist tomorrow 3pm !high"), at: typed)
        #expect(await store.changes.compactMap(\.capturedLine) == ["Call dentist tomorrow 3pm !high"], "shown as pending until then")

        // The first attempt reaches the Mac, but its answer is lost on the way back.
        _ = try await phone.capture("Call dentist tomorrow 3pm !high", typedAt: change.createdAt, key: change.id)

        #expect(await engine.replay() == .finished)
        #expect(await store.changes.isEmpty)
        let tasks = try await phone.allTasks().tasks
        #expect(tasks.count == 1, "added once")
        let task = try #require(tasks.first)
        let dayAfterTyping = Day(typed.addingTimeInterval(86_400))
        #expect(task.title == "Call dentist" && task.priority == .high)
        #expect(task.due == dayAfterTyping, "tomorrow, counted from when it was typed")
        #expect(task.remindAt.map { Day($0) } == dayAfterTyping)
        #expect(task.remindAt.map { Calendar.current.component(.hour, from: $0) } == 15)
    }

    @Test("an edit whose answer was lost is not mistaken for a conflict with itself")
    func lostAnswer() async throws {
        let created = try hub.macCreate(["title": "Send the invoice"])
        try await engine.refresh()
        let cached = try #require(await store.task(created.id))
        await edit(cached, TaskPatch(priority: .high))
        let change = try #require(await store.changes.first)

        _ = try await phone.update(cached.id, rev: cached.rev, TaskPatch(priority: .high), key: change.id) // accepted; answer lost

        #expect(await engine.replay() == .finished)
        #expect(await store.changes.isEmpty)
        let final = try await phone.task(cached.id)
        #expect(final.priority == .high && final.rev == cached.rev + 1, "applied exactly once")
    }

    @Test("if the token is rotated while changes wait, they keep waiting and go through after pairing again")
    func revokedWhileWaiting() async throws {
        let created = try hub.macCreate(["title": "Water the plants"])
        try await engine.refresh()
        await store.add(.complete(task: created.id))
        await store.add(.capture(line: "Buy plant food"))

        try hub.command("rotate")
        #expect(await engine.replay() == .interrupted(.unauthorized))
        #expect(await store.changes.count == 2)
        #expect(await store.changes.allSatisfy(\.isWaiting))

        let paired = SyncEngine(client: hub.phone(), store: store) // the new token, the same store
        #expect(await paired.replay() == .finished)
        #expect(await store.changes.isEmpty)
        let tasks = try await hub.phone().allTasks().tasks
        #expect(tasks.first { $0.id == created.id }?.status == .done)
        #expect(tasks.contains { $0.title == "Buy plant food" })
    }

    @Test("when the Mac can't be reached, the queue waits; when it can, it empties")
    func unreachable() async throws {
        let created = try hub.macCreate(["title": "Patient task"])
        try await engine.refresh()
        await store.add(.comment(task: created.id, text: "Written in a tunnel"))

        let nowhere = SyncEngine(client: hub.phone(port: 1), store: store)
        #expect(await nowhere.replay() == .interrupted(.transport(.cannotConnectToHost)))
        #expect(await store.changes.count == 1)
        await #expect(throws: HubError.transport(.cannotConnectToHost)) { try await nowhere.refresh() }
        #expect(await store.list.tasks.count == 1, "the cached list is still there to read")

        #expect(await engine.replay() == .finished)
        #expect(try await phone.task(created.id).activity?.last?.text == "Written in a tunnel")
    }

    @Test("deleting a task that changed on the Mac asks first; the task survives until I decide")
    func deleteAfterChange() async throws {
        let created = try hub.macCreate(["title": "Old idea"])
        try await engine.refresh()
        let cached = try #require(await store.task(created.id))
        await store.add(.delete(task: cached.id, baseRev: cached.rev))
        #expect(await store.list.tasks.applying(await store.changes).isEmpty, "gone from the phone's list straight away")

        try hub.macUpdate(cached.id, ["notes": "Actually, this matters."], by: "Claude Code · ideas")
        #expect(await engine.replay() == .finished)
        #expect(try await phone.task(cached.id).notes == "Actually, this matters.", "not deleted")
        let parked = try #require(await store.changes.first)
        #expect(await store.list.tasks.applying(await store.changes).map(\.id) == [cached.id], "and back in the list, as the Mac has it")

        #expect(await store.resolveDelete(parked.id, deleteAnyway: true))
        #expect(await engine.replay() == .finished)
        await #expect(throws: HubError.self) { try await phone.task(cached.id) }
        #expect(await store.changes.isEmpty)
        #expect(await store.list.tasks.isEmpty)
    }

    @Test("an edit to a task deleted on the Mac is kept, and the task can be put back with it")
    func editAfterDelete() async throws {
        let created = try hub.macCreate(["title": "Trip checklist", "subtasks": ["Passport"], "due": "2027-02-01", "tags": ["travel"]])
        try await engine.refresh()
        let cached = try #require(await store.task(created.id))
        await edit(cached, TaskPatch(notes: "Don't forget the adapter", priority: .high))
        await store.add(.addSubtask(task: cached.id, title: "Adapter", localID: -1))
        await store.add(.comment(task: cached.id, text: "Packing tonight"))

        try hub.macDelete(cached.id)
        #expect(await engine.replay() == .finished)
        let changes = await store.changes
        #expect(changes.count == 3, "all three are still here")
        guard case .taskDeleted(let last) = try #require(changes.first).state else {
            Issue.record("expected the task to be reported deleted")
            return
        }
        #expect(last?.title == "Trip checklist")

        #expect(await store.restoreTask(for: changes[0].id))
        #expect(await engine.replay() == .finished)
        let tasks = try await phone.allTasks().tasks
        let restored = try #require(tasks.first)
        #expect(tasks.count == 1 && restored.id != cached.id)
        #expect(restored.title == "Trip checklist" && restored.notes == "Don't forget the adapter" && restored.priority == .high)
        #expect(restored.due == Day("2027-02-01") && restored.tags == ["travel"])
        #expect(restored.subtasks.map(\.title) == ["Passport", "Adapter"])
        // The comment can't be recreated with the task. It stays set aside, where its text can be read.
        let left = await store.changes
        #expect(left.map(\.kind) == [.comment(task: cached.id, text: "Packing tonight")])
    }

    @Test("after a refresh, everything needed to read offline is on the phone, and survives a relaunch")
    func readableOffline() async throws {
        try hub.macCreate(["title": "With history", "notes": "Read **me** offline"], by: "Claude Code · repo")
        try hub.macUpdate(1, ["comment": "A comment to read on a plane."], by: "Claude Code · repo")
        try hub.macCreate(["title": "Done one", "status": "done"])
        let list = try await engine.refresh()
        #expect(list.tasksNeedingHistory.isEmpty)
        #expect(list.version == (try hub.version))

        // The app is closed and opened again with no connection at all.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-relaunch-\(UUID().uuidString)", isDirectory: true)
        let first = LocalStore(directory: directory)
        try await SyncEngine(client: phone, store: first).refresh()
        let relaunched = LocalStore(directory: directory)
        let offline = await relaunched.list
        #expect(offline.tasks.map(\.title) == ["With history", "Done one"])
        #expect(offline.tasks[0].notes == "Read **me** offline")
        #expect(offline.tasks[0].activity?.last?.text == "A comment to read on a plane.")
        #expect(offline.syncedAt != nil && offline.version == list.version)
    }

    @Test("a long queue goes through in order")
    func longQueue() async throws {
        let created = try hub.macCreate(["title": "Busy task"])
        try await engine.refresh()
        for i in 1...25 { await store.add(.comment(task: created.id, text: "Comment \(i)")) }
        for i in 1...5 { await store.add(.capture(line: "Captured \(i)")) }
        #expect(await engine.replay() == .finished)
        let final = try await phone.task(created.id)
        #expect(final.activity?.filter { $0.kind == .comment }.map(\.text) == (1...25).map { "Comment \($0)" })
        #expect(try await phone.allTasks().tasks.filter { $0.title.hasPrefix("Captured") }.map(\.title).sorted() == (1...5).map { "Captured \($0)" })
    }
}
#endif
