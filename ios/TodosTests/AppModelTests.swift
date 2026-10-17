// The app's behaviour: pairing, opening with no connection, changes made offline,
// sending them later, and what happens when the Mac changed the same task.
// The network is a stand-in Mac (FakeMac); the Keychain and the files on disk are real.

import Foundation
import Testing
@testable import Todos
@testable import TodosKit

@MainActor
@Suite("The app, online and off")
struct AppModelTests {
    let mac = FakeMac()
    let keychain = KeychainCredentialStore(service: "com.abhishekpratapa.todos.tests.\(UUID().uuidString)")
    let credentials = try! HubCredentials(address: HubAddress("my-mac.tail1234.ts.net"), token: "test-token-\(UUID().uuidString)")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todos-app-tests-\(UUID().uuidString)", isDirectory: true)
    /// Settings of its own, so nothing chosen in the app on this Simulator reaches a test, or the other way round.
    let settings = "com.abhishekpratapa.todos.tests.\(UUID().uuidString)"
    var defaults: UserDefaults { UserDefaults(suiteName: settings)! }

    /// The live connection, driven by the test: `live.yield(...)` is the Mac's event stream reporting something.
    private let channel = AsyncStream.makeStream(of: LiveState.self)
    var live: AsyncStream<LiveState>.Continuation { channel.continuation }

    /// A fresh launch of the app, with the same Keychain item and the same files on disk.
    func launch() -> AppModel {
        AppModel(credentials: keychain, makeClient: { [mac] in mac.client($0) }, liveStates: { [channel] _ in channel.stream }, dataDirectory: directory, defaults: defaults)
    }

    /// An app that has paired and loaded the list.
    func paired() async -> AppModel {
        let model = launch()
        #expect(await model.pair(credentials) == nil)
        return model
    }

    func cleanUp() {
        try? keychain.clear()
        try? FileManager.default.removeItem(at: directory)
        defaults.removePersistentDomain(forName: settings)
    }

    /// Waits for something that happens a moment later, on the model's own schedule.
    func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    // MARK: The list's choices

    @Test("the list's filters and sort are kept on this iPhone between launches, but not the search")
    func listChoicesKept() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        #expect(model.query == TaskQuery(), "a first launch starts with everything open, in the Mac's order")
        model.query.filter = .todo
        model.query.focus = [.overdue, .dueToday]
        model.query.projects = ["Home", ""]
        model.query.priorities = [.high]
        model.query.tags = ["errands", "money"]
        model.query.tagMode = .all
        model.query.sort = try TaskSort("due,-priority")
        model.query.search = "passport"

        var kept = model.query
        kept.search = ""
        let again = launch()
        #expect(again.query == kept)

        // What this version can't read (a sort key from a later one) starts afresh; the rest stands.
        defaults.set(Data(#"{"filter": "done", "sort": "due,urgency", "priorities": ["high"]}"#.utf8), forKey: "taskQuery")
        let later = launch()
        #expect(later.query.filter == .done && later.query.sort.isDefault && later.query.priorities == [.high])
        defaults.set(Data("not JSON".utf8), forKey: "taskQuery")
        #expect(launch().query == TaskQuery())

        // Unpairing starts the list afresh, here and at the next launch.
        model.query.priorities = [.low]
        await model.unpair(erasingData: true)
        #expect(model.query == TaskQuery() && launch().query == TaskQuery())
    }

    @Test("the Today tab: overdue, then due today, most important first; its badge is what the widget counts")
    func todayTab() async throws {
        defer { cleanUp() }
        let today = Day.today()
        mac.add("Call mom") { $0.due = today.adding(days: -2) }
        mac.add("Renew passport") { $0.due = today.adding(days: -6); $0.priority = .high }
        mac.add("Pay rent") { $0.due = today; $0.priority = .high }
        mac.add("Order groceries") { $0.due = today }
        mac.add("Finished late") { $0.due = today.adding(days: -1); $0.status = .done }
        mac.add("Tomorrow") { $0.due = today.adding(days: 1) }
        let model = await paired()
        let sections = model.due.todaySections
        #expect(sections.map(\.kind) == [.overdue, .today])
        #expect(sections.map { $0.tasks.map(\.title) } == [["Renew passport", "Call mom"], ["Pay rent", "Order groceries"]])
        #expect(model.due.dueNow.count == 4 && model.counts.overdue + model.counts.dueToday == 4)
    }

    // MARK: Pairing

    @Test("pairing keeps the token only once the Mac has accepted it, and only in the Keychain")
    func pairing() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = launch()
        await model.start()
        #expect(model.phase == .unpaired)

        #expect(await model.pair(credentials) == nil)
        #expect(model.phase == .paired && model.address == credentials.address && model.macVersion == "1.6.0")
        #expect(model.tasks.map(\.title) == ["Renew passport"])
        #expect(model.hasLoaded && model.lastSynced != nil && model.issue == nil)
        #expect(try keychain.load() == credentials)

        // The token is in the Keychain and nowhere else this app writes: not UserDefaults,
        // not the list kept on disk, not any other file in the app's container.
        let token = Data(credentials.token.utf8)
        #expect(!"\(UserDefaults.standard.dictionaryRepresentation())".contains(credentials.token))
        var filesChecked = 0
        let files = FileManager.default.enumerator(at: URL(fileURLWithPath: NSHomeDirectory()), includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey])
        while let file = files?.nextObject() as? URL {
            guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), values.isRegularFile == true, (values.fileSize ?? 0) < 5_000_000,
                  let data = try? Data(contentsOf: file) else { continue }
            filesChecked += 1
            #expect(data.range(of: token) == nil, "found the token in \(file.lastPathComponent)")
        }
        #expect(filesChecked > 0 && FileManager.default.fileExists(atPath: directory.path), "the list on disk was among the files checked")
    }

    @Test("a wrong token, a Mac that is too old or too new, or no connection: nothing is saved and the reason is given")
    func pairingRefused() async throws {
        defer { cleanUp() }
        let model = launch()
        await model.start()

        mac.tokenRevoked = true
        #expect(await model.pair(credentials) == .tokenRevoked)
        mac.tokenRevoked = false

        mac.apiRevision = 2 // Todos 1.5
        #expect(await model.pair(credentials) == .serverTooOld)
        mac.apiRevision = Compatibility.requiredRevision

        mac.isUnreachable = true
        let issue = await model.pair(credentials)
        #expect(issue == .macUnreachable || issue == .tailscaleOff)

        #expect(model.phase == .unpaired)
        #expect(try keychain.load() == nil)
    }

    // MARK: Offline

    @Test("the app opens with the list it last had, even with no connection at all")
    func opensOffline() async throws {
        defer { cleanUp() }
        mac.add("Renew passport") { $0.notes = "Bring **photos**" }
        mac.edit(1) { $0.activity?.append(ActivityEntry(at: Date(), by: "Claude Code · passport", kind: .comment, text: "Form is filled in.")) }
        mac.add("Done already") { $0.status = .done }
        _ = await paired()

        mac.isUnreachable = true
        let relaunched = launch()
        await relaunched.start()
        #expect(relaunched.phase == .paired)
        #expect(relaunched.hasLoaded, "there is a list to show at once, before anything is asked of the network")
        #expect(mac.requests.allSatisfy { _ in true } && relaunched.issue == nil)
        await relaunched.activate()
        #expect(relaunched.tasks.map(\.title) == ["Renew passport", "Done already"])
        #expect(relaunched.task(1)?.notes == "Bring **photos**")
        #expect(relaunched.task(1)?.activity?.contains { $0.text == "Form is filled in." } == true, "comments can be read offline")
        #expect(relaunched.lastSynced != nil)
        #expect(relaunched.issue == .macUnreachable || relaunched.issue == .tailscaleOff)
    }

    @Test("a change made offline shows at once, waits, and is sent when the Mac is back")
    func offlineEdit() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.isUnreachable = true

        await model.update(1, TaskPatch(title: "Renew passport this week", priority: .high))
        await model.addComment(1, "Booked from the train")
        await model.complete(1)
        #expect(model.task(1)?.title == "Renew passport this week" && model.task(1)?.status == .done, "shown straight away")
        #expect(model.task(1)?.activity?.last?.text == "Booked from the train")
        #expect(model.waiting.count == 3 && model.hasWaitingChanges(1))
        #expect(model.issue != nil)
        #expect(mac.task(1)?.title == "Renew passport", "nothing has reached the Mac")
        #expect(SyncText.status(model).contains("3 changes waiting"))

        // The app is closed and opened again, still offline: the changes are still there.
        let relaunched = launch()
        await relaunched.start()
        #expect(relaunched.waiting.count == 3)
        #expect(relaunched.task(1)?.title == "Renew passport this week")

        mac.isUnreachable = false
        await relaunched.retry()
        #expect(relaunched.waiting.isEmpty && relaunched.issue == nil)
        let onMac = try #require(mac.task(1))
        #expect(onMac.title == "Renew passport this week" && onMac.priority == .high && onMac.status == .done)
        #expect(onMac.activity?.contains { $0.text == "Booked from the train" } == true)
        let shown = try #require(relaunched.task(1))
        #expect(shown.rev == onMac.rev && shown.title == onMac.title && shown.status == onMac.status && shown.priority == onMac.priority, "and the phone now shows what the Mac has")
        #expect(shown.activity?.map(\.text) == onMac.activity?.map(\.text) && shown.commentCount == 1)
    }

    @Test("several edits to one task while offline are sent as one change")
    func editsJoin() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.isUnreachable = true
        await model.update(1, TaskPatch(title: "Renew passport today"))
        await model.update(1, TaskPatch(priority: .high))
        await model.update(1, TaskPatch(title: "Renew the passport today", due: .set(Day("2027-01-05")!)))
        #expect(model.waiting.count == 1)
        #expect(model.waiting.first?.kind == .update(task: 1, baseRev: 1,
                                                    base: TaskPatch(title: "Renew passport", priority: .medium, due: .clear),
                                                    patch: TaskPatch(title: "Renew the passport today", priority: .high, due: .set(Day("2027-01-05")!))))
        mac.isUnreachable = false
        let writesBefore = mac.writes.count
        await model.retry()
        #expect(mac.writes.count == writesBefore + 1)
        #expect(mac.task(1)?.title == "Renew the passport today" && mac.task(1)?.due == Day("2027-01-05"))
    }

    @Test("a line captured offline waits as typed, and becomes a task when the Mac is back")
    func offlineCapture() async throws {
        defer { cleanUp() }
        let model = await paired()
        mac.isUnreachable = true
        await model.capture("Call dentist tomorrow 3pm")
        #expect(model.waitingAdditions.map(\.capturedLine) == ["Call dentist tomorrow 3pm"])
        #expect(model.notice?.text.contains("Saved") == true)
        #expect(mac.all.isEmpty)
        #expect(await model.preview("Call dentist tomorrow 3pm") == nil, "no guessing at how the Mac will read it")

        mac.isUnreachable = false
        await model.retry()
        #expect(model.waitingAdditions.isEmpty)
        #expect(mac.all.map(\.title) == ["Call dentist tomorrow 3pm"], "the stand-in Mac keeps the line as its title")
        #expect(mac.writes.last?.value(forHTTPHeaderField: "Idempotency-Key") != nil)
        #expect(model.tasks.count == 1)
    }

    // MARK: When the Mac changed it too

    @Test("an edit to a different field than the Mac changed is merged without asking")
    func mergesQuietly() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.edit(1) { $0.priority = .high } // the phone hasn't heard about this yet
        await model.update(1, TaskPatch(title: "Renew passport this week"))
        #expect(model.needingAttention.isEmpty && model.waiting.isEmpty)
        #expect(mac.task(1)?.title == "Renew passport this week" && mac.task(1)?.priority == .high, "both changes survive")
        #expect(model.task(1)?.priority == .high)
    }

    @Test("an edit to the same field is not applied over the Mac's, and not dropped: I choose")
    func conflict() async throws {
        defer { cleanUp() }
        mac.add("Renew passport") { $0.notes = "Original" }
        let model = await paired()
        mac.edit(1, by: "Claude Code · passport") { $0.title = "Renew passport (urgent)"; $0.notes = "Claude’s notes" }

        await model.update(1, TaskPatch(title: "Renew passport this week", notes: "My notes", priority: .low))
        #expect(mac.task(1)?.title == "Renew passport (urgent)", "the Mac's title is untouched")
        #expect(mac.task(1)?.priority == .low, "the part that didn't overlap went through")
        let change = try #require(model.needingAttention.first)
        #expect(model.needsAttention(1) && model.task(1)?.title == "Renew passport (urgent)", "showing the Mac's version")
        #expect(model.notice?.isError == true)
        guard case .update(_, _, _, let mine) = change.kind, case .conflict(let theirs) = change.state else {
            Issue.record("expected a conflicted edit")
            return
        }
        #expect(mine == TaskPatch(title: "Renew passport this week", notes: "My notes"), "my versions are kept")
        #expect(ConflictText.who(theirs) == "Claude Code · passport")
        #expect(ConflictText.fields(mine) == "title and notes")
        #expect(FieldText.value(.title, in: mine) == "Renew passport this week")
        #expect(SyncText.status(model).contains("1 needs your decision"))

        // A later change to the same task waits behind the decision.
        await model.addComment(1, "After the conflict")
        #expect(model.waiting.count == 1 && mac.task(1)?.commentCount == 0)

        // I take the Mac's title and keep both sets of notes.
        let resolved = ConflictText.resolved(mine: mine, theirs: theirs, choices: [.title: .theirs, .notes: .both])
        #expect(resolved == TaskPatch(notes: "Claude’s notes\n\nMy notes"))
        await model.resolveEdit(change, keeping: resolved)
        #expect(model.changes.isEmpty)
        #expect(mac.task(1)?.title == "Renew passport (urgent)" && mac.task(1)?.notes == "Claude’s notes\n\nMy notes")
        #expect(mac.task(1)?.commentCount == 1, "and the change that was waiting behind it went too")
    }

    @Test("a change to a task that was deleted on the Mac is kept, and the task can be put back")
    func deletedOnMac() async throws {
        defer { cleanUp() }
        mac.add("Trip checklist") { $0.subtasks = [Subtask(id: 1, title: "Passport", done: false)] }
        let model = await paired()
        mac.delete(1)
        await model.update(1, TaskPatch(notes: "Don’t forget the adapter", priority: .high))
        let change = try #require(model.needingAttention.first)
        #expect(model.title(for: change) == "Trip checklist")
        #expect(model.tasks.isEmpty)

        await model.restoreTask(for: change)
        #expect(model.changes.isEmpty)
        let restored = try #require(mac.all.first)
        #expect(restored.title == "Trip checklist" && restored.notes == "Don’t forget the adapter" && restored.priority == .high)
        #expect(restored.subtasks.map(\.title) == ["Passport"])
        #expect(model.tasks.map(\.title) == ["Trip checklist"])
    }

    @Test("giving a change up is something only I can do")
    func discarding() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.isUnreachable = true
        await model.update(1, TaskPatch(title: "Never mind"))
        let change = try #require(model.waiting.first)
        await model.discard(change)
        #expect(model.changes.isEmpty && model.task(1)?.title == "Renew passport")
        mac.isUnreachable = false
        await model.retry()
        #expect(mac.task(1)?.title == "Renew passport")
    }

    // MARK: Connection

    @Test("a live update reloads the list only when the Mac's version has moved on, and sends what was waiting")
    func liveUpdates() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        let before = mac.requests.count

        live.yield(.live(version: mac.version)) // the version the list already has
        #expect(await eventually { model.isLive })
        #expect(mac.requests.count == before, "nothing to fetch")

        mac.add("Added on the Mac")
        mac.edit(1) { $0.title = "Renew passport today" }
        live.yield(.changed(version: mac.version))
        #expect(await eventually { model.tasks.count == 2 })
        #expect(model.task(1)?.title == "Renew passport today")

        // The connection drops; a change is made; the connection comes back.
        live.yield(.waiting(.todosNotRunning, retryIn: 1))
        #expect(await eventually { model.issue == .todosNotRunning })
        #expect(model.isLive == false && model.tasks.count == 2, "the list stays on screen")
        mac.isUnreachable = true
        await model.complete(2)
        #expect(model.waiting.count == 1)
        mac.isUnreachable = false
        live.yield(.live(version: mac.version))
        #expect(await eventually { model.waiting.isEmpty && model.issue == nil })
        #expect(mac.task(2)?.status == .done)
    }

    @Test("a revoked token is reported, changes keep waiting, and pairing again sends them")
    func revoked() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.tokenRevoked = true
        await model.update(1, TaskPatch(title: "Changed while signed out"))
        #expect(model.issue == .tokenRevoked && model.issue?.needsPairing == true)
        #expect(model.waiting.count == 1 && model.tasks.count == 1, "the list and the change are both still here")

        await model.unpair(erasingData: false) // "Pair Again"
        #expect(model.phase == .unpaired && model.tasks.isEmpty)
        #expect(try keychain.load() == nil)

        mac.tokenRevoked = false
        #expect(await model.pair(credentials) == nil)
        #expect(model.waiting.isEmpty)
        #expect(mac.task(1)?.title == "Changed while signed out")
    }

    @Test("unpairing removes the token, the copy of the list and anything still waiting")
    func unpairing() async throws {
        defer { cleanUp() }
        mac.add("Renew passport")
        let model = await paired()
        mac.isUnreachable = true
        await model.capture("Lost on purpose")
        await model.unpair(erasingData: true)
        #expect(model.phase == .unpaired && model.tasks.isEmpty && model.changes.isEmpty)
        #expect(try keychain.load() == nil)

        let relaunched = launch()
        await relaunched.start()
        #expect(relaunched.phase == .unpaired)
        mac.isUnreachable = false
        #expect(await relaunched.pair(credentials) == nil)
        #expect(relaunched.changes.isEmpty && mac.all.map(\.title) == ["Renew passport"], "nothing left over was sent")
    }

    // MARK: From outside the app

    @Test("a task added by a Shortcut is saved at once, and the answer says whether it reached the Mac")
    func shortcut() async throws {
        defer { cleanUp() }
        _ = await paired()

        // A Shortcut can run when the app isn't open: a fresh launch, in the background.
        let background = launch()
        #expect(await { if case .added = await background.captureFromOutside("Buy milk tomorrow") { true } else { false } }())
        #expect(mac.all.map(\.title) == ["Buy milk tomorrow"])

        mac.isUnreachable = true
        #expect(await { if case .waiting = await background.captureFromOutside("Buy eggs", waitingAtMost: 1) { true } else { false } }())
        #expect(background.waitingAdditions.map(\.capturedLine) == ["Buy eggs"], "kept for when the Mac is back")

        mac.isUnreachable = false
        await background.retry()
        #expect(mac.all.map(\.title).sorted() == ["Buy eggs", "Buy milk tomorrow"])
    }

    @Test("a Shortcut run before pairing says so, and saves nothing")
    func shortcutUnpaired() async throws {
        defer { cleanUp() }
        let model = launch()
        #expect(await { if case .notPaired = await model.captureFromOutside("Too early") { true } else { false } }())
        #expect(model.changes.isEmpty && mac.all.isEmpty)
    }

    @Test("a task added from the share sheet while the app was away is found and sent when the app returns")
    func sharedWhileAway() async throws {
        defer { cleanUp() }
        let model = await paired()
        // The share extension is another process writing to the same folder.
        let folder = try #require(SharedContainer.currentHubDirectory(in: directory))
        let extensionStore = LocalStore(directory: folder)
        await extensionStore.add(.add(title: "An article to read", notes: "https://example.com/article"))
        #expect(model.changes.isEmpty, "the app hasn't looked yet")

        await model.activate()
        #expect(model.changes.isEmpty)
        #expect(mac.all.map(\.title) == ["An article to read"] && mac.all.first?.notes == "https://example.com/article")
        #expect(model.tasks.map(\.title) == ["An article to read"])
    }

    @Test("whatever is on screen is handed on for reminders and the widget, and the widget can find the list")
    func handsOn() async throws {
        defer { cleanUp() }
        mac.add("Call back") { $0.remindAt = Date().addingTimeInterval(3600) }
        let model = launch()
        var handed: [[TodoTask]] = []
        model.didReload = { tasks, _ in handed.append(tasks) }
        #expect(await model.pair(credentials) == nil)
        #expect(handed.last?.map(\.title) == ["Call back"])
        #expect(ReminderPlan.plan(for: handed.last ?? []).map(\.title) == ["Call back"])

        // The widget reads the same folder the app writes.
        let folder = try #require(SharedContainer.currentHubDirectory(in: directory))
        #expect(LocalStore.read(directory: folder).list.tasks.map(\.title) == ["Call back"])

        await model.unpair(erasingData: true)
        #expect(handed.last?.isEmpty == true, "unpairing clears reminders and the widget")
        #expect(SharedContainer.currentHubDirectory(in: directory) == nil)
    }

    @Test("a different Mac never sees the first one's list or waiting changes")
    func separateMacs() async throws {
        defer { cleanUp() }
        mac.add("On the first Mac")
        let model = await paired()
        mac.isUnreachable = true
        await model.capture("For the first Mac")
        await model.unpair(erasingData: false)

        let other = FakeMac()
        other.add("On the second Mac")
        let second = AppModel(credentials: keychain, makeClient: { other.client($0) }, liveStates: { [channel] _ in channel.stream }, dataDirectory: directory)
        await second.start()
        #expect(await second.pair(try HubCredentials(address: HubAddress("other-mac.tail1234.ts.net"), token: "another-token")) == nil)
        #expect(second.tasks.map(\.title) == ["On the second Mac"])
        #expect(second.changes.isEmpty && other.all.count == 1)
    }
}
