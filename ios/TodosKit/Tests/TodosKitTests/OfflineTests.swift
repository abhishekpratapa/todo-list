// The offline side: waiting changes shown on top of the list, the three-way merge,
// what is kept on disk, and sending the queue (with the network replaced by canned answers).

import Foundation
import Testing
@testable import TodosKit

private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-tests-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func json(_ task: TodoTask) -> String {
    String(decoding: try! HubJSON.encoder().encode(task), as: UTF8.self)
}

@Suite("Waiting changes on top of the list")
struct OverlayTests {
    let tasks = [Sample.task(1, "One", tags: ["a"]), Sample.task(2, "Two"), Sample.task(3, "Three")]

    @Test("an edit, a completion and a delete show at once")
    func basics() {
        let changes = [
            PendingChange(kind: .update(task: 1, baseRev: 1, base: TaskPatch(title: "One"), patch: TaskPatch(title: "One, edited", due: .set(Day("2026-10-20")!)))),
            PendingChange(kind: .complete(task: 2)),
            PendingChange(kind: .delete(task: 3, baseRev: 1)),
        ]
        let shown = tasks.applying(changes)
        #expect(shown.map(\.id) == [1, 2])
        #expect(shown[0].title == "One, edited" && shown[0].due == Day("2026-10-20") && shown[0].rev == 1)
        #expect(shown[1].status == .done)
        #expect(tasks.applying([]) == tasks)
    }

    @Test("changes to one task stack in the order they were made")
    func stacking() {
        let changes = [
            PendingChange(kind: .update(task: 1, baseRev: 1, base: TaskPatch(priority: .medium), patch: TaskPatch(priority: .high))),
            PendingChange(kind: .addSubtask(task: 1, title: "Step", localID: -1)),
            PendingChange(kind: .setSubtask(task: 1, subtask: -1, done: true)),
            PendingChange(kind: .renameSubtask(task: 1, subtask: -1, title: "First step")),
            PendingChange(kind: .update(task: 1, baseRev: 1, base: TaskPatch(priority: .high), patch: TaskPatch(priority: .low))),
        ]
        let shown = tasks.applying(changes)[0]
        #expect(shown.priority == .low)
        #expect(shown.subtasks == [Subtask(id: -1, title: "First step", done: true)])
        #expect(tasks.applying(changes + [PendingChange(kind: .removeSubtask(task: 1, subtask: -1))])[0].subtasks.isEmpty)
    }

    @Test("a waiting comment shows in the history if it is loaded, and in the count if not")
    func comments() {
        var withHistory = tasks[0]
        withHistory.activity = []
        let change = PendingChange(kind: .comment(task: 1, text: "On it"))
        let shown = withHistory.applying([change])
        #expect(shown?.activity?.last?.text == "On it" && shown?.activity?.last?.author == "You · iPhone")
        #expect(shown?.commentCount == 1)
        #expect(tasks[0].applying([change])?.commentCount == 1, "no history loaded: the count still goes up")
    }

    @Test("a change that needs a decision is left off, so the task shows the Mac's version")
    func attention() {
        let edit = PendingChange.Kind.update(task: 1, baseRev: 1, base: TaskPatch(title: "One"), patch: TaskPatch(title: "Mine"))
        #expect(tasks.applying([PendingChange(kind: edit, state: .conflict(theirs: tasks[0]))])[0].title == "One")
        #expect(tasks.applying([PendingChange(kind: edit, state: .rejected(message: "no"))])[0].title == "One")
        #expect(tasks.applying([PendingChange(kind: edit)])[0].title == "Mine")
        #expect(PendingChange(kind: edit, state: .taskDeleted(last: nil)).needsAttention)
    }

    @Test("captures and restores make new tasks, so they are not overlaid on any")
    func newTasks() {
        let capture = PendingChange(kind: .capture(line: "Buy milk tomorrow"))
        #expect(tasks.applying([capture, PendingChange(kind: .restore(task: tasks[0]))]) == tasks)
        #expect(capture.taskID == nil && capture.capturedLine == "Buy milk tomorrow")
        #expect(PendingChange(kind: .complete(task: 2)).taskID == 2)
    }

    @Test("each kind of change says what it is in a few words")
    func summaries() {
        #expect(PendingChange(kind: .capture(line: "Buy milk")).summary == "Add “Buy milk”")
        #expect(PendingChange(kind: .update(task: 1, baseRev: 1, base: TaskPatch(), patch: TaskPatch(title: "x", due: .clear))).summary == "Edit title and due date")
        #expect(PendingChange(kind: .setSubtask(task: 1, subtask: 2, done: false)).summary == "Uncheck a subtask")
        #expect(PendingChange(kind: .restore(task: tasks[1])).summary == "Put back “Two”")
    }

    @Test("a change survives being saved and loaded, whatever its kind and state")
    func coding() throws {
        let all: [PendingChange] = [
            PendingChange(kind: .capture(line: "x")),
            PendingChange(kind: .update(task: 1, baseRev: 4, base: TaskPatch(due: .set(Day("2026-10-12")!), project: .clear), patch: TaskPatch(due: .clear, project: .set("p"))), state: .conflict(theirs: Sample.task)),
            PendingChange(kind: .complete(task: 2), state: .taskDeleted(last: Sample.task)),
            PendingChange(kind: .delete(task: 3, baseRev: 9), state: .taskDeleted(last: nil)),
            PendingChange(kind: .comment(task: 1, text: "c"), state: .rejected(message: "m")),
            PendingChange(kind: .addSubtask(task: 1, title: "s", localID: -3)),
            PendingChange(kind: .setSubtask(task: 1, subtask: 2, done: true)),
            PendingChange(kind: .renameSubtask(task: 1, subtask: 2, title: "t")),
            PendingChange(kind: .removeSubtask(task: 1, subtask: 2)),
            PendingChange(kind: .restore(task: Sample.task)),
        ]
        for change in all {
            let decoded = try HubJSON.decoder().decode(PendingChange.self, from: HubJSON.encoder().encode(change))
            #expect(decoded.id == change.id && decoded.kind == change.kind && decoded.state == change.state)
            #expect(abs(decoded.createdAt.timeIntervalSince(change.createdAt)) < 0.001)
        }
    }
}

@Suite("Merging my edit with the Mac's")
struct MergeTests {
    let base = Sample.task // rev 4: "Renew passport", high, due 2026-10-16, project personal, tags errand+travel, notes "Bring **photos**"

    private func merge(_ mine: TaskPatch, theirs change: (inout TodoTask) -> Void) -> MergeResult {
        var theirs = base
        change(&theirs)
        theirs.rev += 1
        return ThreeWayMerge.merge(base: TaskPatch(of: base, fields: mine.fields), mine: mine, theirs: theirs)
    }

    @Test("edits to different fields both survive")
    func disjoint() {
        let result = merge(TaskPatch(title: "Renew passport this week", due: .clear)) { $0.priority = .low; $0.notes = "New notes" }
        #expect(result == MergeResult(apply: TaskPatch(title: "Renew passport this week", due: .clear), conflicts: []))
        #expect(result.isClean)
    }

    @Test("a comment or subtask on the Mac moves the revision but conflicts with nothing")
    func unrelated() {
        let result = merge(TaskPatch(status: .done)) { $0.subtasks.append(Subtask(id: 9, title: "x", done: false)) }
        #expect(result == MergeResult(apply: TaskPatch(status: .done), conflicts: []))
    }

    @Test("the same field changed to different things is a conflict, and only that field")
    func overlap() {
        let result = merge(TaskPatch(title: "Mine", priority: .low, due: .set(Day("2026-11-01")!))) { $0.title = "Theirs"; $0.due = nil }
        #expect(result.apply == TaskPatch(priority: .low), "the untouched field still goes through")
        #expect(result.conflicts == [.title, .due])
        #expect(!result.isClean)
    }

    @Test("both sides making the same change is not a conflict, and there is nothing left to send")
    func sameChange() {
        let result = merge(TaskPatch(status: .done, project: .clear)) { $0.status = .done; $0.project = nil }
        #expect(result == MergeResult(apply: TaskPatch(), conflicts: []))
    }

    @Test("clearing a field the Mac changed is a conflict; clearing one it left alone is not")
    func clearing() {
        #expect(merge(TaskPatch(project: .clear)) { $0.project = "work" }.conflicts == [.project])
        #expect(merge(TaskPatch(project: .clear)) { $0.title = "x" } == MergeResult(apply: TaskPatch(project: .clear), conflicts: []))
        #expect(merge(TaskPatch(remindAt: .set(Date(timeIntervalSince1970: 5)))) { $0.remindAt = nil }.conflicts == [.remindAt])
    }

    @Test("tags combine: the Mac's, plus what I added, minus what I removed")
    func tags() {
        // base: errand, travel. I add urgent and remove travel; the Mac adds official.
        let result = merge(TaskPatch(tags: ["errand", "urgent"])) { $0.tags = ["errand", "travel", "official"] }
        #expect(result == MergeResult(apply: TaskPatch(tags: ["errand", "official", "urgent"]), conflicts: []))
        // Both add the same tag: nothing to send.
        #expect(merge(TaskPatch(tags: ["errand", "travel", "x"])) { $0.tags = ["errand", "travel", "x"] }.apply.isEmpty)
        // The Mac removed a tag I kept: it stays removed, and my addition still lands.
        #expect(merge(TaskPatch(tags: ["errand", "travel", "mine"])) { $0.tags = ["errand"] }.apply == TaskPatch(tags: ["errand", "mine"]))
        #expect(ThreeWayMerge.tags(base: ["a"], mine: [], theirs: ["a", "b"]) == ["b"])
    }

    @Test("notes are one field: two different rewrites conflict rather than being spliced")
    func notes() {
        #expect(merge(TaskPatch(notes: "My version")) { $0.notes = "Their version" }.conflicts == [.notes])
    }

    @Test("patches can be narrowed, widened and read off a task")
    func patchHelpers() {
        let patch = TaskPatch(title: "t", priority: .low, due: .clear)
        #expect(patch.only([.title, .notes]) == TaskPatch(title: "t"))
        #expect(patch.without([.title]) == TaskPatch(priority: .low, due: .clear))
        #expect(patch.merging(TaskPatch(title: "u", status: .done)) == TaskPatch(title: "u", status: .done, priority: .low, due: .clear))
        #expect(TaskPatch(of: base, fields: [.title, .due, .repeats, .project]) == TaskPatch(title: "Renew passport", due: .set(Day("2026-10-16")!), project: .set("personal"), repeats: .set(.yearly)))
        #expect(TaskPatch(of: base, fields: TaskField.allCases).applied(to: Sample.task(1)).title == "Renew passport")
    }
}

@Suite("What is kept on this iPhone")
struct LocalStoreTests {
    let directory = temporaryDirectory()

    @Test("the list is there the next time the app opens, with its version and when it was fetched")
    func listPersists() async {
        let when = Date(timeIntervalSince1970: 1_791_849_600)
        let store = LocalStore(directory: directory)
        let empty = await store.list
        #expect(empty.tasks.isEmpty && empty.syncedAt == nil)
        await store.replaceList([Sample.task(1, "One"), Sample.task(2, "Two")], version: 7, syncedAt: when)

        let reopened = LocalStore(directory: directory)
        let list = await reopened.list
        #expect(list.tasks.map(\.title) == ["One", "Two"])
        #expect(list.version == 7 && list.syncedAt == when)
    }

    @Test("histories are kept across list refreshes, and the store knows which are out of date")
    func histories() async {
        let store = LocalStore(directory: directory)
        var full = Sample.task(1, "One")
        full.activity = [ActivityEntry(at: Date(timeIntervalSince1970: 1), by: "me", kind: .comment, text: "Kept")]
        await store.replaceList([Sample.task(1, "One"), Sample.task(2, "Two", status: .done), Sample.task(3, "Three")], version: 1)
        #expect(await store.list.tasksNeedingHistory == [1, 3, 2], "open tasks first")
        await store.keep(full)
        #expect(await store.list.tasksNeedingHistory == [3, 2])

        // A refresh brings the task back without its history: the one on hand stays.
        await store.replaceList([Sample.task(1, "One"), Sample.task(3, "Three")], version: 2)
        #expect(await store.task(1)?.activity?.first?.text == "Kept")
        #expect(await store.list.tasksNeedingHistory == [3])
        #expect(await store.task(2) == nil, "a task the Mac no longer lists is gone")

        // The task moved on: the old history still shows, but is known to be stale.
        var moved = Sample.task(1, "One, renamed")
        moved.rev = 2
        await store.replaceList([moved, Sample.task(3, "Three")], version: 3)
        #expect(await store.task(1)?.activity?.first?.text == "Kept")
        #expect(await store.list.tasksNeedingHistory == [1, 3])
        #expect(await LocalStore(directory: directory).list.tasksNeedingHistory == [1, 3], "and that survives a relaunch")
    }

    @Test("waiting changes survive a relaunch, in the order they were made")
    func changesPersist() async {
        let store = LocalStore(directory: directory)
        let now = Date()
        let first = await store.add(.capture(line: "First"), at: now)
        let second = await store.add(.complete(task: 2), at: now) // the same instant
        let third = await store.add(.comment(task: 2, text: "Third"), at: now.addingTimeInterval(-60)) // a clock that went backwards
        #expect(first.createdAt < second.createdAt && second.createdAt < third.createdAt)

        let reopened = LocalStore(directory: directory)
        #expect(await reopened.changes.map(\.id) == [first.id, second.id, third.id])
        #expect(await reopened.changes.map(\.kind) == [.capture(line: "First"), .complete(task: 2), .comment(task: 2, text: "Third")])

        await reopened.remove(change: second.id)
        #expect(await LocalStore(directory: directory).changes.map(\.id) == [first.id, third.id])
    }

    @Test("a change keeps its place when its state changes or it is swapped for another")
    func changesUpdate() async {
        let store = LocalStore(directory: directory)
        let a = await store.add(.complete(task: 1))
        var b = await store.add(.comment(task: 1, text: "b"))
        let c = await store.add(.complete(task: 3))
        b.state = .rejected(message: "no")
        await store.put(b)
        let swapped = await store.replace(a, with: .delete(task: 1, baseRev: 2), state: .conflict(theirs: Sample.task(1)))
        #expect(swapped.id != a.id, "a new identity, so a later attempt is not mistaken for the first")

        let reopened = LocalStore(directory: directory)
        #expect(await reopened.changes.map(\.id) == [swapped.id, b.id, c.id])
        #expect(await reopened.changes.map(\.isWaiting) == [false, false, true])
    }

    @Test("later edits follow the revision when an earlier change of mine is accepted, and only then")
    func advancing() async {
        let store = LocalStore(directory: directory)
        await store.add(.update(task: 1, baseRev: 5, base: TaskPatch(title: "a"), patch: TaskPatch(title: "b")))
        await store.add(.delete(task: 1, baseRev: 5))
        await store.add(.update(task: 2, baseRev: 5, base: TaskPatch(title: "a"), patch: TaskPatch(title: "b")))
        await store.add(.update(task: 1, baseRev: 3, base: TaskPatch(notes: ""), patch: TaskPatch(notes: "n")))
        await store.advance(task: 1, from: 5, to: 6)
        #expect(await store.changes.map(\.kind) == [
            .update(task: 1, baseRev: 6, base: TaskPatch(title: "a"), patch: TaskPatch(title: "b")),
            .delete(task: 1, baseRev: 6),
            .update(task: 2, baseRev: 5, base: TaskPatch(title: "a"), patch: TaskPatch(title: "b")),
            .update(task: 1, baseRev: 3, base: TaskPatch(notes: ""), patch: TaskPatch(notes: "n")),
        ])
    }

    @Test("a subtask added here gets its real id in the changes that follow it")
    func renumbering() async {
        let store = LocalStore(directory: directory)
        await store.add(.setSubtask(task: 1, subtask: -1, done: true))
        await store.add(.renameSubtask(task: 1, subtask: -1, title: "t"))
        await store.add(.removeSubtask(task: 1, subtask: -2))
        await store.add(.setSubtask(task: 2, subtask: -1, done: true))
        await store.renumber(subtask: -1, of: 1, to: 4)
        #expect(await store.changes.map(\.kind) == [
            .setSubtask(task: 1, subtask: 4, done: true), .renameSubtask(task: 1, subtask: 4, title: "t"),
            .removeSubtask(task: 1, subtask: -2), .setSubtask(task: 2, subtask: -1, done: true),
        ])
    }

    @Test("a file this version can't read is set aside, not deleted, and the rest still load")
    func unreadable() async throws {
        let store = LocalStore(directory: directory)
        let good = await store.add(.capture(line: "Good"))
        let outbox = directory.appendingPathComponent("outbox")
        try Data("{\"from\":\"the future\"}".utf8).write(to: outbox.appendingPathComponent("000001791849600000-future.json"))
        try Data("not json".utf8).write(to: directory.appendingPathComponent("list.json"))

        let reopened = LocalStore(directory: directory)
        #expect(await reopened.changes.map(\.id) == [good.id])
        #expect(await reopened.list.tasks.isEmpty, "an unreadable list is simply fetched again")
        #expect(FileManager.default.fileExists(atPath: outbox.appendingPathComponent("unreadable/000001791849600000-future.json").path))
    }

    @Test("erasing removes the list and every waiting change")
    func erasing() async {
        let store = LocalStore(directory: directory)
        await store.replaceList([Sample.task(1)], version: 1)
        await store.add(.capture(line: "x"))
        await store.erase()
        #expect(await store.list == CachedList())
        #expect(await store.changes.isEmpty)
        let reopened = LocalStore(directory: directory)
        #expect(await reopened.list.tasks.isEmpty)
        #expect(await reopened.changes.isEmpty)
        await reopened.add(.capture(line: "works again"))
        #expect(await LocalStore(directory: directory).changes.count == 1)
    }
}

@Suite("Sending the queue")
struct ReplayTests {
    let stub = StubTransport()
    let store = LocalStore(directory: temporaryDirectory())
    var engine: SyncEngine { SyncEngine(client: Sample.client(stub), store: store) }

    private func task(_ id: Int, rev: Int = 1, title: String = "Task", priority: TaskPriority = .medium) -> TodoTask {
        var task = Sample.task(id, title, priority: priority)
        task.rev = rev
        task.activity = []
        return task
    }

    private func ok(_ task: TodoTask) -> String { #"{"task":\#(json(task)),"next":null}"# }
    private func conflict(_ task: TodoTask) -> String { #"{"error":{"code":"conflict","message":"changed","current":\#(json(task))}}"# }

    @Test("changes go out in the order they were made, each with its own key, and the queue empties")
    func order() async {
        await store.replaceList([task(1), task(2)], version: 1)
        let a = await store.add(.comment(task: 1, text: "first"))
        let b = await store.add(.complete(task: 2))
        let c = await store.add(.capture(line: "Buy milk tomorrow"), at: Date(timeIntervalSince1970: 1_792_072_800))
        stub.reply(201, ok(task(1, rev: 2)))
        stub.reply(200, ok(task(2, rev: 2)))
        stub.reply(201, #"{"task":\#(json(task(3, title: "Buy milk"))),"parsed":{"title":"Buy milk","fields":{}}}"#)

        #expect(await engine.replay() == .finished)
        #expect(stub.requests.map { $0.url!.path } == ["/api/v1/tasks/1/comments", "/api/v1/tasks/2/complete", "/api/v1/capture"])
        #expect(stub.requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") } == [a.id.uuidString, b.id.uuidString, c.id.uuidString])
        #expect(stub.body()["at"] as? String == "2026-10-15T14:00:00.000Z", "the line says when it was typed")
        #expect(await store.changes.isEmpty)
        #expect(await store.list.tasks.map(\.id).sorted() == [1, 2, 3], "what the Mac answered is stored")
    }

    @Test("when the Mac can't be reached, everything stays waiting and nothing is skipped")
    func unreachable() async {
        await store.replaceList([task(1)], version: 1)
        await store.add(.comment(task: 1, text: "first"))
        await store.add(.complete(task: 1))
        stub.fail(.timedOut)
        #expect(await engine.replay() == .interrupted(.transport(.timedOut)))
        #expect(stub.requests.count == 1, "it stops at the first failure rather than trying the rest out of order")
        #expect(await store.changes.count == 2)
        #expect(await store.changes.allSatisfy(\.isWaiting))
    }

    @Test("a revoked token stops the queue without losing anything")
    func revoked() async {
        await store.replaceList([task(1)], version: 1)
        await store.add(.capture(line: "Keep me"))
        stub.reply(401, #"{"error":{"code":"unauthorized","message":"That access token is not valid."}}"#)
        #expect(await engine.replay() == .interrupted(.unauthorized))
        #expect(await store.changes.map(\.capturedLine) == ["Keep me"])
        #expect(stub.requests.count == 1, "and does not keep trying a token the Mac has refused")
    }

    @Test("an edit the Mac moved past is merged and sent again on top of the Mac's version")
    func cleanMerge() async {
        await store.replaceList([task(1, rev: 4)], version: 1)
        let change = await store.add(.update(task: 1, baseRev: 4, base: TaskPatch(title: "Task"), patch: TaskPatch(title: "Mine")))
        stub.reply(409, conflict(task(1, rev: 6, priority: .high))) // the Mac changed the priority meanwhile
        stub.reply(200, ok(task(1, rev: 7, title: "Mine", priority: .high)))

        #expect(await engine.replay() == .finished)
        #expect(stub.requests.map { $0.value(forHTTPHeaderField: "If-Match") } == ["\"4\"", "\"6\""])
        #expect(stub.body()["title"] as? String == "Mine")
        #expect(stub.requests.allSatisfy { $0.value(forHTTPHeaderField: "Idempotency-Key") == change.id.uuidString })
        #expect(await store.changes.isEmpty)
        let merged = await store.task(1)
        #expect(merged?.title == "Mine" && merged?.priority == .high, "both changes survive")
    }

    @Test("when the Mac already has what the edit wanted, there is nothing to send")
    func alreadyThere() async {
        await store.replaceList([task(1, rev: 4)], version: 1)
        await store.add(.update(task: 1, baseRev: 4, base: TaskPatch(priority: .medium), patch: TaskPatch(priority: .high)))
        stub.reply(409, conflict(task(1, rev: 5, priority: .high)))
        #expect(await engine.replay() == .finished)
        #expect(stub.requests.count == 1)
        #expect(await store.changes.isEmpty)
    }

    @Test("a true conflict sends the part that doesn't overlap and keeps the rest for me to decide")
    func realConflict() async throws {
        await store.replaceList([task(1, rev: 4)], version: 1)
        let original = await store.add(.update(task: 1, baseRev: 4, base: TaskPatch(title: "Task", priority: .medium), patch: TaskPatch(title: "Mine", priority: .low)))
        let later = await store.add(.comment(task: 1, text: "A later change to the same task"))
        let other = await store.add(.complete(task: 2))
        stub.reply(409, conflict(task(1, rev: 5, title: "Theirs")))            // the Mac renamed it
        stub.reply(200, ok(task(1, rev: 6, title: "Theirs", priority: .low)))  // my priority goes through
        stub.reply(200, ok(task(2, rev: 2)))                                   // the other task carries on

        #expect(await engine.replay() == .finished)
        #expect(stub.requests.map { $0.url!.path } == ["/api/v1/tasks/1", "/api/v1/tasks/1", "/api/v1/tasks/2/complete"])
        #expect(stub.body(stub.requests[1]).keys.sorted() == ["priority"], "only the field that doesn't overlap")
        #expect(stub.requests[1].value(forHTTPHeaderField: "If-Match") == "\"5\"")

        let changes = await store.changes
        #expect(changes.count == 2 && !changes.contains { $0.id == other.id })
        let parked = try #require(changes.first)
        #expect(parked.id != original.id)
        #expect(parked.kind == .update(task: 1, baseRev: 6, base: TaskPatch(title: "Task"), patch: TaskPatch(title: "Mine")), "my title is kept, not dropped")
        guard case .conflict(let theirs) = parked.state else {
            Issue.record("expected a conflict")
            return
        }
        #expect(theirs.title == "Theirs" && theirs.priority == .low && theirs.rev == 6)
        #expect(changes.last?.id == later.id && changes.last?.isWaiting == true, "the later change to that task waits behind it")
        #expect(await store.task(1)?.title == "Theirs", "the list shows the Mac's version meanwhile")
    }

    @Test("a refused change is set aside with the Mac's reason, and the queue moves on")
    func rejected() async throws {
        await store.replaceList([task(1)], version: 1)
        await store.add(.capture(line: "tomorrow !high"))
        await store.add(.comment(task: 1, text: "still sent"))
        stub.reply(400, #"{"error":{"code":"invalid","message":"That line has no title, only dates and markers."}}"#)
        stub.reply(201, ok(task(1, rev: 2)))
        #expect(await engine.replay() == .finished)
        let changes = await store.changes
        #expect(changes.count == 1)
        #expect(changes[0].kind == .capture(line: "tomorrow !high"))
        #expect(changes[0].state == .rejected(message: "That line has no title, only dates and markers."))
    }

    @Test("changes to a task that was deleted on the Mac are kept, with the task as it was")
    func deletedOnMac() async throws {
        await store.replaceList([task(1, title: "Gone"), task(2)], version: 1)
        await store.add(.update(task: 1, baseRev: 1, base: TaskPatch(notes: ""), patch: TaskPatch(notes: "Important")))
        await store.add(.comment(task: 2, text: "c"))
        stub.reply(404, #"{"error":{"code":"not_found","message":"No todo with id #1"}}"#)
        stub.reply(404, #"{"error":{"code":"not_found","message":"No todo with id #2"}}"#)
        #expect(await engine.replay() == .finished)
        let changes = await store.changes
        #expect(changes.count == 2)
        guard case .taskDeleted(let last) = changes[0].state else {
            Issue.record("expected the task to be reported deleted")
            return
        }
        #expect(last?.title == "Gone")
        #expect(await store.list.tasks.isEmpty, "the deleted tasks leave the list")
    }

    @Test("deleting: gone already is success; changed meanwhile asks first")
    func deleting() async throws {
        await store.replaceList([task(1), task(2, rev: 3)], version: 1)
        await store.add(.delete(task: 1, baseRev: 1))
        await store.add(.delete(task: 2, baseRev: 3))
        stub.reply(404, #"{"error":{"code":"not_found","message":"No todo with id #1"}}"#)
        stub.reply(409, conflict(task(2, rev: 4, title: "Edited on the Mac")))
        #expect(await engine.replay() == .finished)
        #expect(stub.requests.allSatisfy { $0.httpMethod == "DELETE" })
        let changes = await store.changes
        #expect(changes.count == 1)
        #expect(changes[0].kind == .delete(task: 2, baseRev: 4))
        #expect(changes[0].state == .conflict(theirs: task(2, rev: 4, title: "Edited on the Mac")))
        #expect(await store.list.tasks.map(\.id) == [2])
    }

    @Test("a subtask added and checked off while offline arrives as both")
    func offlineSubtask() async {
        await store.replaceList([task(1)], version: 1)
        await store.add(.addSubtask(task: 1, title: "New step", localID: -1))
        await store.add(.setSubtask(task: 1, subtask: -1, done: true))
        var added = task(1, rev: 2)
        added.subtasks = [Subtask(id: 3, title: "New step", done: false)]
        var checked = added
        checked.rev = 3
        checked.subtasks[0].done = true
        stub.reply(201, ok(added))
        stub.reply(200, ok(checked))
        #expect(await engine.replay() == .finished)
        #expect(stub.requests.map { $0.url!.path } == ["/api/v1/tasks/1/subtasks", "/api/v1/tasks/1/subtasks/3"], "the second uses the id the Mac assigned")
        #expect(await store.changes.isEmpty)
        #expect(await store.task(1)?.subtasks == [Subtask(id: 3, title: "New step", done: true)])
    }

    @Test("a change to a subtask that no longer exists is simply finished")
    func subtaskGone() async {
        await store.replaceList([task(1)], version: 1)
        await store.add(.setSubtask(task: 1, subtask: 9, done: true))
        await store.add(.removeSubtask(task: 1, subtask: 9))
        stub.reply(404, #"{"error":{"code":"not_found","message":"Task #1 has no subtask 9"}}"#)
        stub.reply(404, #"{"error":{"code":"not_found","message":"Task #1 has no subtask 9"}}"#)
        #expect(await engine.replay() == .finished)
        #expect(await store.changes.isEmpty)
    }

    @Test("my own earlier change does not make my later one look like a conflict")
    func chained() async {
        await store.replaceList([task(1, rev: 4)], version: 1)
        await store.add(.comment(task: 1, text: "first"))
        await store.add(.update(task: 1, baseRev: 4, base: TaskPatch(title: "Task"), patch: TaskPatch(title: "Mine")))
        stub.reply(201, ok(task(1, rev: 5)))
        stub.reply(200, ok(task(1, rev: 6, title: "Mine")))
        #expect(await engine.replay() == .finished)
        #expect(stub.last.value(forHTTPHeaderField: "If-Match") == "\"5\"", "based on the revision my comment produced")
        #expect(stub.requests.count == 2)
    }

    @Test("when the Mac says to slow down, the queue waits and then carries on")
    func rateLimited() async {
        await store.replaceList([task(1)], version: 1)
        await store.add(.comment(task: 1, text: "patient"))
        stub.reply(429, #"{"error":{"code":"rate_limited","message":"Too many changes in a short time."}}"#, headers: ["Retry-After": "1"])
        stub.reply(201, ok(task(1, rev: 2)))
        let started = Date()
        #expect(await engine.replay() == .finished)
        #expect(Date().timeIntervalSince(started) >= 0.9)
        #expect(stub.requests.count == 2 && stub.requests[0].value(forHTTPHeaderField: "Idempotency-Key") == stub.requests[1].value(forHTTPHeaderField: "Idempotency-Key"))
        #expect(await store.changes.isEmpty)
    }

    @Test("a refresh stores the list and then fetches the histories it is missing")
    func refresh() async throws {
        let summary = #"{"open":2,"in_progress":0,"blocked":0,"overdue":0,"due_today":0,"claude":0,"done_7d":0}"#
        var listed1 = task(1)
        listed1.activity = nil
        var listed2 = task(2)
        listed2.activity = nil
        stub.reply(200, #"{"tasks":[\#(json(listed1)),\#(json(listed2))],"total":2,"summary":\#(summary),"version":12}"#)
        var full = task(1)
        full.activity = [ActivityEntry(at: Date(timeIntervalSince1970: 1), by: "Claude Code · repo", kind: .comment, text: "Read me offline")]
        stub.reply(200, ok(full))
        stub.reply(404, #"{"error":{"code":"not_found","message":"No todo with id #2"}}"#) // deleted between the two requests

        let list = try await engine.refresh()
        #expect(list.version == 12 && list.syncedAt != nil)
        #expect(list.tasks.map(\.id) == [1])
        #expect(list.tasks[0].activity?.first?.text == "Read me offline")
        #expect(list.tasksNeedingHistory.isEmpty)
        #expect(stub.requests.map { $0.url!.path } == ["/api/v1/tasks", "/api/v1/tasks/1", "/api/v1/tasks/2"])

        stub.fail(.notConnectedToInternet)
        await #expect(throws: HubError.transport(.notConnectedToInternet)) { try await engine.refresh() }
        #expect(await store.list.tasks.map(\.id) == [1], "a failed refresh leaves what was there")
    }
}
