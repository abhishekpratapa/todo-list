// The app's state: whether this iPhone is paired, the task list, the connection to
// the Mac, and every change the screens can make.
//
// The list on screen is what the Mac last sent (kept on disk, so the app opens at
// once and can be read offline) with this iPhone's own changes on top. Every
// change is saved first and sent second: if the Mac can't be reached it waits, and
// if the task changed on the Mac meanwhile the two are merged or set aside for
// the user to decide. TodosKit's LocalStore and SyncEngine do that work.

import Foundation
import Observation
import OSLog
import TodosKit

@MainActor
@Observable
final class AppModel {
    enum Phase {
        case launching, unpaired, paired
    }

    /// A short message shown over the screen for a few seconds.
    struct Notice: Identifiable, Equatable {
        let id = UUID()
        var text: String
        var isError = false
    }

    private(set) var phase = Phase.launching
    private(set) var address: HubAddress?
    /// The version of Todos running on the Mac, once it has said.
    private(set) var macVersion: String?

    /// The list as shown: what the Mac last sent, with this iPhone's waiting changes on top.
    private(set) var tasks: [TodoTask] = []
    /// Changes made here that the Mac hasn't accepted yet, in the order they were made.
    private(set) var changes: [PendingChange] = []
    /// False until there is a list to show: fetched just now, or kept from last time.
    private(set) var hasLoaded = false
    /// When the list last came from the Mac.
    private(set) var lastSynced: Date?
    /// True while the live-update connection is open.
    private(set) var isLive = false
    /// True while waiting changes are being sent.
    private(set) var isSending = false
    /// Why the Mac can't be reached right now, if it can't.
    private(set) var issue: ConnectionIssue?

    var query = TaskQuery()
    var notice: Notice?
    /// Set by any screen to show the Sync screen: what is waiting, and what needs a decision.
    var isShowingSync = false
    /// A task to open: set when a reminder or the widget is tapped.
    var requestedTask: Int?

    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let makeClient: (HubCredentials) -> HubClient
    @ObservationIgnored private let liveStates: (HubClient) -> AsyncStream<LiveState>
    @ObservationIgnored private let dataDirectory: URL
    @ObservationIgnored private var client: HubClient?
    @ObservationIgnored private var store: LocalStore?
    @ObservationIgnored private var engine: SyncEngine?
    @ObservationIgnored private var list = CachedList()
    @ObservationIgnored private var live: Task<Void, Never>?
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var sendAgain = false
    @ObservationIgnored private var compatibilityChecked = false
    @ObservationIgnored private var isRefreshing = false
    @ObservationIgnored private var refreshQueued = false
    // Logs say what happened, never what a task says or what the token is.
    @ObservationIgnored private let log = Logger(subsystem: "com.abhishekpratapa.todos.ios", category: "sync")

    /// The defaults are the real thing: the Keychain, the network, the Mac's event stream
    /// and the shared container. Tests replace them.
    init(
        credentials: any CredentialStore = KeychainCredentialStore(),
        makeClient: @escaping (HubCredentials) -> HubClient = { HubClient(credentials: $0) },
        liveStates: @escaping (HubClient) -> AsyncStream<LiveState> = { LiveUpdates(client: $0).states() },
        dataDirectory: URL = SharedContainer.directory
    ) {
        self.credentials = credentials
        self.makeClient = makeClient
        self.liveStates = liveStates
        self.dataDirectory = dataDirectory
    }

    /// Called whenever what is on screen has been worked out afresh, with the tasks as shown.
    /// The app uses it to reschedule reminders and refresh the widget.
    @ObservationIgnored var didReload: (@MainActor ([TodoTask]) async -> Void)?

    // MARK: Pairing

    /// Loads the pairing and the list kept on this iPhone. It does not connect: `activate` does,
    /// when the app is on screen. Safe to call more than once.
    func start() async {
        guard phase == .launching else { return }
        let saved: HubCredentials?
        do {
            saved = try credentials.load()
        } catch {
            log.error("could not read the Keychain")
            saved = nil
        }
        guard let saved else {
            phase = .unpaired
            return
        }
        await adopt(saved, makeClient(saved))
    }

    /// Tries an address and token against the Mac, and keeps them only if they work.
    /// Returns what went wrong, or nil.
    func pair(_ new: HubCredentials) async -> ConnectionIssue? {
        let candidate = makeClient(new)
        do {
            let check = try await candidate.checkCompatibility()
            guard check.result == .compatible else { return ConnectionIssue(check.result) }
            try credentials.save(new)
            macVersion = check.meta?.app?.version
        } catch let error as HubError {
            log.error("pairing failed: \(error.logName, privacy: .public)")
            return ConnectionIssue(error, tailscaleConnected: Tailscale.isConnected())
        } catch {
            log.error("pairing failed: could not save to the Keychain")
            return .other("The token couldn’t be saved on this iPhone.")
        }
        await adopt(new, candidate)
        compatibilityChecked = true
        await activate()
        return nil
    }

    /// Each Mac has a folder of its own, named after its address. Pairing again with
    /// the same Mac (after its token was rotated, say) finds the list and any waiting
    /// changes still there; pairing with a different Mac never sees them.
    private func adopt(_ new: HubCredentials, _ client: HubClient) async {
        let store = LocalStore(directory: SharedContainer.hubDirectory(for: new.address, in: dataDirectory))
        SharedContainer.setCurrentHub(new.address, in: dataDirectory)
        self.client = client
        self.store = store
        engine = SyncEngine(client: client, store: store)
        address = new.address
        issue = nil
        await reload()
        phase = .paired
    }

    /// Forgets the Mac's token. With `erasingData`, also removes the list kept here and any
    /// changes still waiting; without it they stay for when this Mac is paired again.
    func unpair(erasingData: Bool) async {
        stopLive()
        sending?.cancel()
        do {
            try credentials.clear()
        } catch {
            log.error("could not clear the Keychain")
        }
        if erasingData { await store?.erase() }
        SharedContainer.setCurrentHub(nil, in: dataDirectory)
        client = nil
        store = nil
        engine = nil
        address = nil
        macVersion = nil
        list = CachedList()
        changes = []
        tasks = []
        hasLoaded = false
        lastSynced = nil
        issue = nil
        query = TaskQuery()
        compatibilityChecked = false
        phase = .unpaired
        await didReload?([])
    }

    // MARK: Connection

    /// The app came to the front: connect for live updates, send what is waiting, load the list.
    func activate() async {
        guard phase == .paired else { return }
        await store?.reloadChanges() // the share sheet may have added some while the app was away
        await reload()
        startLive()
        await sync()
    }

    /// A background refresh from iOS: bring the list up to date (and with it the reminders
    /// and the widget) without opening a live connection.
    func refreshInBackground() async {
        await start()
        guard phase == .paired else { return }
        await store?.reloadChanges()
        compatibilityChecked = false
        await sync()
    }

    /// The app went to the background, where iOS would cut the connection anyway.
    func deactivate() {
        stopLive()
        compatibilityChecked = false
    }

    /// Checks the Mac speaks a version this app understands (once each time the app comes
    /// to the front), sends waiting changes, then loads the list.
    func sync() async {
        guard let client else { return }
        if !compatibilityChecked {
            do {
                let check = try await client.checkCompatibility()
                macVersion = check.meta?.app?.version ?? macVersion
                guard check.result == .compatible else {
                    issue = ConnectionIssue(check.result)
                    stopLive()
                    return
                }
                compatibilityChecked = true
            } catch {
                report(error)
                return
            }
        }
        await send()
        await refresh()
    }

    /// Fetches the whole list. If a refresh is already running, one more runs after it.
    func refresh() async {
        guard let engine else { return }
        if isRefreshing {
            refreshQueued = true
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshQueued = false
            do {
                let fetched = try await engine.refresh()
                guard self.engine?.client.address == engine.client.address else { return } // unpaired meanwhile
                if issue?.mayClearByItself == true { issue = nil }
                log.info("list loaded: \(fetched.tasks.count, privacy: .public) tasks")
                await reload()
            } catch {
                await reload()
                report(error)
                return
            }
        } while refreshQueued
    }

    /// "Try Again": for when the problem may have been fixed outside the app.
    func retry() async {
        guard phase == .paired else { return }
        stopLive()
        startLive()
        await sync()
    }

    private func startLive() {
        guard live == nil, let client else { return }
        let states = liveStates(client)
        live = Task { [weak self] in
            for await state in states {
                await self?.handle(state)
            }
        }
    }

    private func stopLive() {
        live?.cancel()
        live = nil
        isLive = false
    }

    private func handle(_ state: LiveState) async {
        switch state {
        case .connecting:
            break
        case .live(let version):
            isLive = true
            if issue?.mayClearByItself == true { issue = nil }
            if !compatibilityChecked || !hasLoaded || version != list.version || changes.contains(where: \.isWaiting) { await sync() }
        case .changed(let version):
            if version != list.version { await refresh() }
        case .waiting(let error, _):
            isLive = false
            log.info("live updates waiting: \(error.logName, privacy: .public)")
            issue = ConnectionIssue(error, tailscaleConnected: Tailscale.isConnected())
        case .stopped(let error):
            isLive = false
            log.error("live updates stopped: \(error.logName, privacy: .public)")
            issue = ConnectionIssue(error, tailscaleConnected: Tailscale.isConnected())
        }
    }

    /// Turns a failure to reach the Mac into what the user sees.
    private func report(_ error: Error) {
        guard let error = error as? HubError else { return } // cancellation
        log.error("request failed: \(error.logName, privacy: .public)")
        switch error {
        case .transport(.cancelled), .conflict, .preconditionRequired, .notFound, .invalid:
            break // not about the connection
        case .rateLimited where hasLoaded:
            break // the queue waits and carries on by itself
        default:
            issue = ConnectionIssue(error, tailscaleConnected: Tailscale.isConnected())
            if error == .unauthorized { stopLive() }
        }
    }

    // MARK: Reading

    var sections: [TaskSection] {
        tasks.sections(for: query, today: .today())
    }

    var counts: Counts {
        tasks.counts(today: .today())
    }

    var projects: [String] {
        tasks.projects
    }

    /// A task as shown, with its history if that has been fetched.
    func task(_ id: Int) -> TodoTask? {
        tasks.first { $0.id == id }
    }

    /// Changes not sent yet, or that the Mac couldn't be reached for.
    var waiting: [PendingChange] {
        changes.filter(\.isWaiting)
    }

    /// Changes that can't go any further until the user decides something.
    var needingAttention: [PendingChange] {
        changes.filter(\.needsAttention)
    }

    /// New tasks on their way to the Mac: captured lines, and tasks being put back.
    var waitingAdditions: [PendingChange] {
        waiting.filter { $0.taskID == nil }
    }

    func hasWaitingChanges(_ task: Int) -> Bool {
        changes.contains { $0.taskID == task && $0.isWaiting }
    }

    func needsAttention(_ task: Int) -> Bool {
        changes.contains { $0.taskID == task && $0.needsAttention }
    }

    /// The title of the task a change is for, as this iPhone knows it.
    func title(for change: PendingChange) -> String? {
        if case .taskDeleted(let last?) = change.state { return last.title }
        if case .conflict(let theirs) = change.state { return theirs.title }
        return change.taskID.flatMap { id in list.tasks.first { $0.id == id }?.title }
    }

    /// A detail screen opened: fetch the task's history if the Mac can be reached.
    func open(_ id: Int) async {
        guard let engine, issue == nil else { return }
        _ = try? await engine.fetch(id)
        await reload()
    }

    /// Reads the list and waiting changes back from the store and works out what to show.
    private func reload() async {
        guard let store else { return }
        list = await store.list
        changes = await store.changes
        tasks = list.tasks.applying(changes).inListOrder()
        lastSynced = list.syncedAt
        hasLoaded = list.syncedAt != nil
        await didReload?(tasks)
    }

    // MARK: Changes

    /// Saves a change, shows it, and sends it if the Mac can be reached.
    @discardableResult
    private func make(_ kind: PendingChange.Kind) async -> PendingChange? {
        guard let store else { return nil }
        let change = await store.add(kind)
        await reload()
        await send()
        return change
    }

    /// Sends waiting changes in order. If a send is already running, one more runs after it,
    /// and this call waits for that too.
    func send() async {
        if let sending {
            sendAgain = true
            await sending.value
            return
        }
        let run = Task { await self.runSend() }
        sending = run
        await run.value
        sending = nil
    }

    private func runSend() async {
        guard let engine else { return }
        repeat {
            sendAgain = false
            guard await engine.store.changes.contains(where: \.isWaiting) else { break }
            isSending = true
            let before = Set(changes.filter(\.needsAttention).map(\.id))
            let outcome = await engine.replay()
            isSending = false
            await reload()
            if case .interrupted(let error) = outcome {
                report(error)
                break
            }
            if issue?.mayClearByItself == true { issue = nil }
            let setAside = changes.filter { $0.needsAttention && !before.contains($0.id) }
            if let first = setAside.first {
                notice = Notice(text: setAside.count == 1 ? Self.attentionText(first) : "\(setAside.count) changes need your decision.", isError: true)
            }
        } while sendAgain
    }

    private static func attentionText(_ change: PendingChange) -> String {
        switch change.state {
        case .conflict: "This task changed on your Mac too. Choose which version to keep."
        case .taskDeleted: "This task was deleted on your Mac. Your change is kept."
        case .rejected(let message): message
        case .waiting: ""
        }
    }

    /// Edits a task's fields. An edit made while an earlier one to the same task is still
    /// waiting joins it, so going offline and changing five things sends one change.
    func update(_ id: Int, _ patch: TaskPatch) async {
        guard !patch.isEmpty, let store, let shown = task(id), let cached = list.tasks.first(where: { $0.id == id }) else { return }
        let before = TaskPatch(of: shown, fields: patch.fields)
        if sending == nil, let last = changes.last(where: { $0.taskID == id }), last.isWaiting, case .update(_, let baseRev, let base, let earlier) = last.kind {
            let joined = PendingChange.Kind.update(task: id, baseRev: baseRev, base: before.merging(base), patch: earlier.merging(patch))
            await store.put(PendingChange(id: last.id, createdAt: last.createdAt, kind: joined))
            await reload()
            await send()
        } else {
            await make(.update(task: id, baseRev: cached.rev, base: before, patch: patch))
        }
    }

    func complete(_ id: Int) async {
        guard let task = task(id) else { return }
        await make(.complete(task: id))
        if task.repeats != nil, issue == nil, let next = tasks.first(where: { $0.title == task.title && $0.status == .todo && $0.repeats == task.repeats && $0.id > id }) {
            notice = Notice(text: "Done. The next one is due \(next.due?.label(relativeTo: .today()).lowercased() ?? "later").")
        }
    }

    func delete(_ id: Int) async {
        guard let cached = list.tasks.first(where: { $0.id == id }) else { return }
        await make(.delete(task: id, baseRev: cached.rev))
    }

    func addComment(_ id: Int, _ text: String) async {
        await make(.comment(task: id, text: text))
    }

    func addSubtask(_ id: Int, _ title: String) async {
        // A stand-in id, below any id this task's subtasks have, until the Mac assigns the real one.
        let localID = min(task(id)?.subtasks.map(\.id).min() ?? 0, 0) - 1
        await make(.addSubtask(task: id, title: title, localID: localID))
    }

    func setSubtask(_ id: Int, _ subtask: Int, done: Bool) async {
        await make(.setSubtask(task: id, subtask: subtask, done: done))
    }

    func renameSubtask(_ id: Int, _ subtask: Int, _ title: String) async {
        await make(.renameSubtask(task: id, subtask: subtask, title: title))
    }

    func removeSubtask(_ id: Int, _ subtask: Int) async {
        await make(.removeSubtask(task: id, subtask: subtask))
    }

    // MARK: Quick capture

    /// Adds a task from one line. The Mac reads the line, so offline it is kept as typed
    /// and shown as waiting until the Mac is reachable.
    func capture(_ line: String) async {
        guard let change = await make(.capture(line: line)) else { return }
        if let still = changes.first(where: { $0.id == change.id }) {
            if still.isWaiting { notice = Notice(text: "Saved. It will be added when your Mac can be reached.") }
        } else {
            notice = Notice(text: "Added")
        }
    }

    enum CaptureOutcome {
        case added, waiting, notPaired
        case refused(String)
    }

    /// Quick capture from outside the app (Shortcuts, Siri, the Action button). The line is
    /// saved at once; this then waits a few seconds to see whether it reached the Mac, so
    /// the answer can say which.
    func captureFromOutside(_ line: String, waitingAtMost seconds: Double = 8) async -> CaptureOutcome {
        await start()
        guard phase == .paired, let store else { return .notPaired }
        let change = await store.add(.capture(line: line))
        await reload()
        let sending = Task { await self.send() }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, changes.contains(where: { $0.id == change.id && $0.isWaiting }), issue == nil {
            try? await Task.sleep(for: .milliseconds(100))
        }
        _ = sending
        guard let still = changes.first(where: { $0.id == change.id }) else { return .added }
        if case .rejected(let message) = still.state { return .refused(message) }
        return .waiting
    }

    /// How the Mac would read a line, for showing while typing. Nil if it can't be asked.
    func preview(_ line: String) async -> ParsedCapture? {
        guard issue == nil else { return nil }
        return try? await client?.preview(line)
    }

    // MARK: Changes that were set aside

    /// A conflicted edit, decided: `mine` holds the fields to send after all, on top of the Mac's version.
    func resolveEdit(_ change: PendingChange, keeping mine: TaskPatch) async {
        await store?.resolveEdit(change.id, keeping: mine)
        await reload()
        await send()
    }

    func resolveDelete(_ change: PendingChange, deleteAnyway: Bool) async {
        await store?.resolveDelete(change.id, deleteAnyway: deleteAnyway)
        await reload()
        await send()
    }

    /// Puts back a task that was deleted on the Mac, with the changes that were waiting for it.
    func restoreTask(for change: PendingChange) async {
        await store?.restoreTask(for: change.id)
        await reload()
        await send()
    }

    /// Gives a change up. Only ever called because the user chose to.
    func discard(_ change: PendingChange) async {
        await store?.discard(change.id)
        await reload()
        await send() // changes that were waiting behind it can go now
    }

    /// Sends a refused change again.
    func tryAgain(_ change: PendingChange) async {
        await store?.retry(change.id)
        await reload()
        await send()
    }
}
