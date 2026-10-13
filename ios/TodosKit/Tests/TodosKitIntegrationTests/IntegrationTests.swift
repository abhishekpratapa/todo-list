// The client against a real Todos server (the Mac app's own server code), running
// with a separate, temporary data directory: CRUD, quick capture, live updates,
// conflicts, a revoked token, and the refusals the app has to explain.

#if os(macOS)
import Foundation
import Testing
@testable import TodosKit

@Suite("Against a real Todos server", .enabled(if: TestHub.node != nil, "Node.js is needed to run the Todos server"))
struct IntegrationTests {
    let hub: TestHub
    let phone: HubClient

    init() throws {
        hub = try TestHub()
        phone = hub.phone()
    }

    // MARK: Compatibility

    @Test("the server in this repository is one this app is compatible with")
    func compatibility() async throws {
        let check = try await phone.checkCompatibility()
        #expect(check.result == .compatible)
        #expect(check.meta?.api.version == Compatibility.apiVersion)
        #expect((check.meta?.api.revision ?? 0) >= Compatibility.requiredRevision)

        let package = try JSONSerialization.jsonObject(with: Data(contentsOf: TestHub.repository.appendingPathComponent("package.json"))) as? [String: Any]
        #expect(check.meta?.app?.version == package?["version"] as? String)
    }

    // MARK: Tasks

    @Test("create, read, edit, complete and delete a task")
    func crud() async throws {
        let created = try await phone.capture("Write the report").task
        #expect(created.title == "Write the report")
        #expect(created.rev == 1 && created.status == .todo && created.priority == .medium)

        let read = try await phone.task(created.id)
        #expect(read == created)
        #expect(read.activity?.first?.text == "created this task")

        let reminder = Date(timeIntervalSince1970: 1_900_000_000)
        let edited = try await phone.update(created.id, rev: read.rev, TaskPatch(
            title: "Write the quarterly report", notes: "Use **Q3** numbers", status: .inProgress, priority: .high, assignee: .claude,
            tags: ["Writing", "@urgent"], due: .set(Day("2027-01-15")!), project: .set("Work"), repeats: .set(.monthly), remindAt: .set(reminder)
        )).task
        #expect(edited.rev == 2)
        #expect(edited.title == "Write the quarterly report" && edited.notes == "Use **Q3** numbers")
        #expect(edited.status == .inProgress && edited.priority == .high && edited.assignee == .claude)
        #expect(edited.tags == ["writing", "urgent"], "the Mac normalises tags")
        #expect(edited.due == Day("2027-01-15") && edited.project == "Work" && edited.repeats == .monthly)
        #expect(edited.remindAt == reminder, "a reminder is an exact moment, whatever time zone the Mac is in")

        let cleared = try await phone.update(created.id, rev: edited.rev, TaskPatch(due: .clear, project: .clear, repeats: .clear, remindAt: .clear)).task
        #expect(cleared.rev == 3)
        #expect(cleared.due == nil && cleared.project == nil && cleared.repeats == nil && cleared.remindAt == nil)
        #expect(cleared.title == edited.title, "fields that were not sent are untouched")

        let done = try await phone.complete(created.id, comment: "Sent to the team")
        #expect(done.task.status == .done && done.task.completedAt != nil && done.next == nil)
        #expect(done.task.activity?.last?.text == "Sent to the team")

        try await phone.delete(created.id, rev: done.task.rev)
        await #expect(throws: HubError.notFound(message: "No todo with id #\(created.id)")) { try await phone.task(created.id) }
    }

    @Test("the whole list arrives in the Mac's order, a page at a time, with its version")
    func listing() async throws {
        try hub.macCreate(["title": "Low", "priority": "low"])
        try hub.macCreate(["title": "Doing", "status": "in_progress"])
        try hub.macCreate(["title": "High, due", "priority": "high", "due": "2027-03-01"])
        try hub.macCreate(["title": "Finished", "status": "done"])
        try hub.macCreate(["title": "Stuck", "status": "blocked", "subtasks": ["a", "b"]], by: "Claude Code · repo")
        try hub.macUpdate(1, ["comment": "A note"])

        let snapshot = try await phone.allTasks(pageSize: 2)
        #expect(snapshot.tasks.map(\.title) == ["Doing", "Stuck", "High, due", "Low", "Finished"])
        #expect(snapshot.tasks.map(\.id) == snapshot.tasks.inListOrder().map(\.id), "this app sorts the same way")
        #expect(snapshot.version == (try hub.version))
        #expect(snapshot.summary == snapshot.tasks.counts(today: .today()), "and counts the same way")
        #expect(snapshot.summary.open == 4 && snapshot.summary.blocked == 1)

        let low = try #require(snapshot.tasks.first { $0.title == "Low" })
        #expect(low.activity == nil && low.commentCount == 1, "lists carry a comment count, not the history")
        #expect(snapshot.tasks.first { $0.title == "Stuck" }?.createdBy == "Claude Code · repo")
    }

    @Test("subtasks and comments are additive: no revision, and they work from a stale copy")
    func additive() async throws {
        let stale = try hub.macCreate(["title": "Plan the trip", "subtasks": ["Book flights"]])
        try hub.macUpdate(stale.id, ["priority": "high"], by: "Claude Code · travel") // the phone's copy is now out of date

        var task = try await phone.addSubtask(stale.id, title: "Reserve hotel")
        #expect(task.subtasks.map(\.title) == ["Book flights", "Reserve hotel"])
        task = try await phone.setSubtask(stale.id, subtask: 1, done: true)
        #expect(task.subtasks.first?.done == true && task.subtasksDone == 1)
        task = try await phone.renameSubtask(stale.id, subtask: 2, title: "Reserve a hotel")
        #expect(task.subtasks.last?.title == "Reserve a hotel")
        task = try await phone.removeSubtask(stale.id, subtask: 1)
        #expect(task.subtasks.map(\.id) == [2])
        task = try await phone.addComment(stale.id, text: "Flights are booked: https://example.com/booking")
        #expect(task.activity?.last?.kind == .comment)
        #expect(task.priority == .high, "the Mac's change is still there")
        #expect(task.rev == stale.rev + 6)

        await #expect(throws: HubError.self) { try await phone.setSubtask(stale.id, subtask: 99, done: true) }
    }

    @Test("completing a repeating task returns its next occurrence")
    func repeating() async throws {
        let task = try hub.macCreate(["title": "Water plants", "repeat": "daily", "due": "today"])
        let result = try await phone.complete(task.id)
        let next = try #require(result.next)
        #expect(result.task.status == .done && result.task.repeats == nil)
        #expect(next.id != task.id && next.status == .todo && next.repeats == .daily)
        #expect(next.due == Day(Date().addingTimeInterval(86_400)), "tomorrow")
    }

    @Test("changes are recorded as made by you, on the iPhone")
    func attribution() async throws {
        let task = try await phone.capture("From the phone").task
        #expect(task.createdBy == "me")
        #expect(task.activity?.first?.via == "iPhone")
        #expect(task.activity?.first?.author == "You · iPhone")
    }

    // MARK: Quick capture

    @Test("quick capture is read by the Mac's own one-line parser")
    func quickCapture() async throws {
        let line = "Renew passport fri !high #personal @errand @claude every year"
        let preview = try await phone.preview(line)
        #expect(preview.title == "Renew passport")
        #expect(preview.fields.priority == .high && preview.fields.project == "personal")
        #expect(preview.fields.tags == ["errand"] && preview.fields.assignee == .claude && preview.fields.repeats == .yearly)
        let friday = try #require(preview.fields.due)
        #expect(Calendar.current.component(.weekday, from: friday.date()) == 6, "a Friday")
        #expect(friday > .today())
        #expect(try await phone.allTasks().tasks.isEmpty, "a preview adds nothing")

        let captured = try await phone.capture(line)
        #expect(captured.parsed == preview)
        let task = captured.task
        #expect(task.title == "Renew passport" && task.priority == .high && task.project == "personal")
        #expect(task.tags == ["errand"] && task.assignee == .claude && task.repeats == .yearly && task.due == friday)

        let timed = try await phone.capture("Call dentist tomorrow 3pm").task
        #expect(timed.title == "Call dentist")
        #expect(timed.due == Day(Date().addingTimeInterval(86_400)))
        let remind = try #require(timed.remindAt)
        #expect(Calendar.current.component(.hour, from: remind) == 15 && Day(remind) == timed.due)

        #expect(try await phone.capture("Reply to @sam about PR #42").task.title == "Reply to @sam about PR #42", "markers in the middle stay in the title")
    }

    @Test("a line with nothing but markers is refused with the Mac's explanation")
    func captureRefusals() async throws {
        await #expect(throws: HubError.invalid(code: "invalid", message: "That line has no title, only dates and markers.")) { try await phone.capture("tomorrow !high") }
        await #expect(throws: HubError.invalid(code: "invalid", message: "Send the line to capture as \"text\".")) { try await phone.capture("   ") }
    }

    // MARK: Live updates

    @Test("live updates announce changes made on the Mac and from the phone")
    func liveUpdates() async throws {
        let log = LiveLog()
        await log.start(LiveUpdates(client: phone))
        let start = try hub.version
        #expect(await log.saw { $0 == .live(version: start) })
        #expect(await log.states.first == .connecting)

        try hub.macCreate(["title": "Added on the Mac"], by: "Claude Code · repo")
        #expect(await log.saw { $0 == .changed(version: start + 1) })

        _ = try await phone.capture("Added on the phone")
        #expect(await log.saw { $0 == .changed(version: start + 2) })

        let snapshot = try await phone.allTasks()
        #expect(snapshot.version == start + 2, "the list's version is the one the stream announced")
        #expect(snapshot.tasks.map(\.title).sorted() == ["Added on the Mac", "Added on the phone"])
        await log.stop()
    }

    @Test("a dropped connection is retried, and picks the new version up")
    func reconnects() async throws {
        let log = LiveLog()
        await log.start(LiveUpdates(client: phone, pauses: [0.05]))
        #expect(await log.saw { if case .live = $0 { true } else { false } })

        // Switching remote access off and on drops every live connection from other devices.
        try hub.command("enabled", ["on": false])
        #expect(await log.saw { $0 == .waiting(.remoteAccessOff, retryIn: 0.05) })
        try hub.macCreate(["title": "Changed while disconnected"])
        try hub.command("enabled", ["on": true])

        // Reconnected, and told about the change: either in the greeting, or (if the Mac
        // had not noticed its own change yet when the phone reconnected) right after it.
        let version = try hub.version
        #expect(await log.saw { $0 == .live(version: version) || $0 == .changed(version: version) })
        let states = await log.states
        let dropped = try #require(states.firstIndex(of: .waiting(.remoteAccessOff, retryIn: 0.05)))
        #expect(states[dropped...].contains { if case .live = $0 { true } else { false } }, "it connected again after the drop")
        #expect(await log.isFinished == false)
        await log.stop()
    }

    // MARK: Conflicts

    @Test("an edit based on a stale copy is refused with the Mac's current task, and nothing is changed")
    func conflict() async throws {
        let mine = try await phone.capture("Draft the proposal !med").task

        // Meanwhile, on the Mac, a Claude session changes the same task.
        try hub.macUpdate(mine.id, ["priority": "high", "comment": "Raised: the client asked again."], by: "Claude Code · proposal")

        do {
            _ = try await phone.update(mine.id, rev: mine.rev, TaskPatch(title: "Draft the proposal for Friday"))
            Issue.record("the stale edit should have been refused")
        } catch HubError.conflict(let current) {
            #expect(current.id == mine.id && current.rev == mine.rev + 1)
            #expect(current.priority == .high)
            #expect(current.title == "Draft the proposal", "my edit was not applied")
            #expect(current.activity?.last?.author == "Claude Code · proposal")

            // The edits don't overlap, so mine can go on top of theirs and both survive.
            let merged = try await phone.update(mine.id, rev: current.rev, TaskPatch(title: "Draft the proposal for Friday")).task
            #expect(merged.title == "Draft the proposal for Friday" && merged.priority == .high && merged.rev == current.rev + 1)
        }
        #expect(try await phone.task(mine.id).commentCount == 1, "the comment made on the Mac is still there")
    }

    @Test("a delete based on a stale copy is refused too; the task survives")
    func deleteConflict() async throws {
        let mine = try await phone.capture("Old idea").task
        try hub.macUpdate(mine.id, ["notes": "Actually, this matters."])
        await #expect(throws: HubError.self) { try await phone.delete(mine.id, rev: mine.rev) }
        #expect(try await phone.task(mine.id).notes == "Actually, this matters.")
    }

    @Test("editing a task that was deleted on the Mac says it is gone")
    func editDeleted() async throws {
        let mine = try await phone.capture("Short-lived").task
        try hub.macDelete(mine.id)
        await #expect(throws: HubError.notFound(message: "No todo with id #\(mine.id)")) { try await phone.update(mine.id, rev: mine.rev, TaskPatch(title: "Too late")) }
    }

    // MARK: Refusals the app has to explain

    @Test("after the token is rotated on the Mac, the old one is refused everywhere and the live connection stops")
    func revokedToken() async throws {
        let log = LiveLog()
        await log.start(LiveUpdates(client: phone, pauses: [0.05]))
        #expect(await log.saw { if case .live = $0 { true } else { false } })
        let task = try await phone.capture("Before rotation").task

        try hub.command("rotate")

        await #expect(throws: HubError.unauthorized) { try await phone.allTasks() }
        await #expect(throws: HubError.unauthorized) { try await phone.update(task.id, rev: task.rev, TaskPatch(title: "x")) }
        await #expect(throws: HubError.unauthorized) { try await phone.checkCompatibility() }
        #expect(ConnectionIssue(.unauthorized, tailscaleConnected: true) == .tokenRevoked)

        // The stream is closed by the Mac; one reconnection attempt is refused, and then it stops for good.
        #expect(await log.saw { $0 == .stopped(.unauthorized) })
        #expect(await log.finished())
        #expect(await log.states.filter { $0 == .connecting }.count == 2, "exactly one retry: wrong tokens are rate limited")

        // Pairing again with the new token works, and nothing was lost.
        let paired = hub.phone()
        #expect(try await paired.task(task.id).title == "Before rotation")
    }

    @Test("a wrong token is refused")
    func wrongToken() async throws {
        let stranger = hub.phone(token: "not-the-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        await #expect(throws: HubError.unauthorized) { try await stranger.allTasks() }
        await #expect(throws: HubError.unauthorized) { try await stranger.capture("Sneaky") }
        #expect(try await phone.allTasks().tasks.isEmpty)
    }

    @Test("with remote access switched off on the Mac, the phone is told so")
    func remoteAccessOff() async throws {
        try hub.command("enabled", ["on": false])
        do {
            _ = try await phone.allTasks()
            Issue.record("should have been refused")
        } catch let error as HubError {
            #expect(error == .remoteAccessOff)
            #expect(ConnectionIssue(error, tailscaleConnected: true) == .remoteAccessOff)
        }
        try hub.command("enabled", ["on": true])
        #expect(try await phone.allTasks().tasks.isEmpty)
    }

    @Test("a device signed in to Tailscale as someone else is refused, even with the token")
    func wrongTailscaleAccount() async throws {
        let other = hub.phone(login: "someone-else@example.com")
        do {
            _ = try await other.allTasks()
            Issue.record("should have been refused")
        } catch let error as HubError {
            guard case .forbidden(let code, _) = error else {
                Issue.record("unexpected error \(error)")
                return
            }
            #expect(code == "forbidden_user")
            #expect(ConnectionIssue(error, tailscaleConnected: true) == .wrongTailscaleAccount)
        }
    }

    @Test("when nothing answers at the address, that is reported as a connection failure")
    func nothingListening() async throws {
        let nowhere = hub.phone(port: 1) // nothing listens on port 1
        do {
            _ = try await nowhere.allTasks()
            Issue.record("should have failed")
        } catch let error as HubError {
            #expect(error == .transport(.cannotConnectToHost))
            #expect(ConnectionIssue(error, tailscaleConnected: true) == .macUnreachable)
            #expect(ConnectionIssue(error, tailscaleConnected: false) == .tailscaleOff)
        }
    }
}
#endif
