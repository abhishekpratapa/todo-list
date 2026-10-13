// The app's state: whether this iPhone is paired, the task list, the connection to
// the Mac, and every change the screens can make.
//
// In this phase the app works only while the Mac is reachable. A change is shown
// straight away, sent, and put back if the Mac doesn't accept it.

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

    /// A change of mine that the Mac refused because the task had changed there first.
    struct Conflict: Identifiable {
        enum Mine {
            case edit(TaskPatch)
            case delete
        }

        let id = UUID()
        var mine: Mine
        /// The task as it is on the Mac now.
        var current: TodoTask
    }

    private(set) var phase = Phase.launching
    private(set) var address: HubAddress?
    /// The version of Todos running on the Mac, once it has said.
    private(set) var macVersion: String?

    private(set) var tasks: [TodoTask] = []
    /// False until the list has arrived from the Mac at least once.
    private(set) var hasLoaded = false
    private(set) var lastSynced: Date?
    /// True while the live-update connection is open.
    private(set) var isLive = false
    /// Why the Mac can't be reached right now, if it can't.
    private(set) var issue: ConnectionIssue?

    var query = TaskQuery()
    var notice: Notice?
    var conflict: Conflict?

    /// Tasks fetched one at a time, which come with their history. Lists come without.
    private var details: [Int: TodoTask] = [:]

    @ObservationIgnored private let store: any CredentialStore
    @ObservationIgnored private let makeClient: (HubCredentials) -> HubClient
    @ObservationIgnored private let liveStates: (HubClient) -> AsyncStream<LiveState>
    @ObservationIgnored private var client: HubClient?
    @ObservationIgnored private var live: Task<Void, Never>?
    @ObservationIgnored private var changes: Task<Void, Never>?
    @ObservationIgnored private var listVersion: Int?
    @ObservationIgnored private var compatibilityChecked = false
    @ObservationIgnored private var isRefreshing = false
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var openDetails: [Int: Int] = [:]
    // Logs say what happened, never what a task says or what the token is.
    @ObservationIgnored private let log = Logger(subsystem: "com.abhishekpratapa.todos.ios", category: "sync")

    /// The defaults are the real thing: the Keychain, the network, and the Mac's event stream. Tests replace them.
    init(
        store: any CredentialStore = KeychainCredentialStore(),
        makeClient: @escaping (HubCredentials) -> HubClient = { HubClient(credentials: $0) },
        liveStates: @escaping (HubClient) -> AsyncStream<LiveState> = { LiveUpdates(client: $0).states() }
    ) {
        self.store = store
        self.makeClient = makeClient
        self.liveStates = liveStates
    }

    // MARK: Pairing

    func start() async {
        guard phase == .launching else { return }
        let saved: HubCredentials?
        do {
            saved = try store.load()
        } catch {
            log.error("could not read the Keychain")
            saved = nil
        }
        guard let saved else {
            phase = .unpaired
            return
        }
        adopt(saved, makeClient(saved))
        await activate()
    }

    /// Tries an address and token against the Mac, and keeps them only if they work.
    /// Returns what went wrong, or nil.
    func pair(_ credentials: HubCredentials) async -> ConnectionIssue? {
        let candidate = makeClient(credentials)
        do {
            let check = try await candidate.checkCompatibility()
            guard check.result == .compatible else { return ConnectionIssue(check.result) }
            try store.save(credentials)
            macVersion = check.meta?.app?.version
        } catch let error as HubError {
            log.error("pairing failed: \(error.logName, privacy: .public)")
            return ConnectionIssue(error, tailscaleConnected: Tailscale.isConnected())
        } catch {
            log.error("pairing failed: could not save to the Keychain")
            return .other("The token couldn’t be saved on this iPhone.")
        }
        adopt(credentials, candidate)
        compatibilityChecked = true
        await activate()
        return nil
    }

    private func adopt(_ credentials: HubCredentials, _ client: HubClient) {
        self.client = client
        address = credentials.address
        phase = .paired
    }

    /// Forgets the Mac: removes the token from the Keychain and everything shown.
    func unpair() {
        stopLive()
        do {
            try store.clear()
        } catch {
            log.error("could not clear the Keychain")
        }
        client = nil
        address = nil
        macVersion = nil
        tasks = []
        details = [:]
        hasLoaded = false
        lastSynced = nil
        listVersion = nil
        issue = nil
        conflict = nil
        query = TaskQuery()
        compatibilityChecked = false
        phase = .unpaired
    }

    // MARK: Connection

    /// The app came to the front: connect for live updates and load the list.
    func activate() async {
        guard phase == .paired else { return }
        startLive()
        await sync()
    }

    /// The app went to the background, where iOS would cut the connection anyway.
    func deactivate() {
        stopLive()
        compatibilityChecked = false
    }

    /// Checks the Mac speaks a version this app understands (once each time the app
    /// comes to the front), then loads the list.
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
        await refresh()
    }

    /// Fetches the whole list. If a refresh is already running, one more runs after it.
    func refresh() async {
        guard let client else { return }
        if isRefreshing {
            refreshQueued = true
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshQueued = false
            do {
                let snapshot = try await client.allTasks()
                guard self.client?.address == client.address else { return } // unpaired meanwhile
                tasks = snapshot.tasks
                listVersion = snapshot.version
                lastSynced = Date()
                hasLoaded = true
                if issue?.mayClearByItself == true { issue = nil }
                log.info("list loaded: \(snapshot.tasks.count, privacy: .public) tasks")
                await refreshDetails()
            } catch {
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
            if !compatibilityChecked || !hasLoaded || version != listVersion { await sync() }
        case .changed(let version):
            if version != listVersion { await refresh() }
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

    /// Turns a failure into what the user sees: a banner for connection problems, a notice for the rest.
    private func report(_ error: Error) {
        guard let error = error as? HubError else { return } // cancellation
        log.error("request failed: \(error.logName, privacy: .public)")
        switch error {
        case .notFound:
            notice = Notice(text: "That task is no longer on your Mac.", isError: true)
        case .invalid(_, let message):
            notice = Notice(text: message, isError: true)
        case .conflict, .preconditionRequired:
            break // handled where the change was made
        case .rateLimited(let retryAfter) where hasLoaded:
            let wait = retryAfter.map { " Try again in \(Int($0.rounded(.up))) seconds." } ?? " Try again shortly."
            notice = Notice(text: "Your Mac is getting changes too quickly." + wait, isError: true)
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

    /// A task, with its history if that has been fetched.
    func task(_ id: Int) -> TodoTask? {
        details[id] ?? tasks.first { $0.id == id }
    }

    /// A detail screen opened: fetch the task's history and keep it current while open.
    func open(_ id: Int) async {
        openDetails[id, default: 0] += 1
        await loadDetail(id)
    }

    func close(_ id: Int) {
        openDetails[id] = (openDetails[id] ?? 1) - 1
        if openDetails[id] == 0 { openDetails[id] = nil }
    }

    private func loadDetail(_ id: Int) async {
        guard let client else { return }
        do {
            keep(try await client.task(id))
        } catch HubError.notFound {
            forget(id)
        } catch {
            report(error)
        }
    }

    /// After the list reloads: drop histories that are now out of date, and refetch the ones on screen.
    private func refreshDetails() async {
        let revisions = Dictionary(tasks.map { ($0.id, $0.rev) }, uniquingKeysWith: { first, _ in first })
        let stale = details.filter { revisions[$0.key] != $0.value.rev }.map(\.key)
        for id in stale where openDetails[id] == nil { details[id] = nil }
        for id in stale where openDetails[id] != nil {
            if revisions[id] == nil { details[id] = nil } else { await loadDetail(id) }
        }
    }

    // MARK: Local copies

    private func keep(_ task: TodoTask) {
        details[task.id] = task
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.append(task)
        }
        tasks = tasks.inListOrder()
    }

    private func forget(_ id: Int) {
        details[id] = nil
        tasks.removeAll { $0.id == id }
    }

    private func change(_ id: Int, _ edit: (inout TodoTask) -> Void) {
        if var detail = details[id] {
            edit(&detail)
            details[id] = detail
        }
        if let index = tasks.firstIndex(where: { $0.id == id }) {
            edit(&tasks[index])
            tasks = tasks.inListOrder()
        }
    }

    // MARK: Changes

    /// Changes run one at a time, in the order they were made, so each one is based
    /// on the revision the one before it produced.
    private func inOrder<T: Sendable>(_ work: @escaping @MainActor () async -> T) async -> T {
        let previous = changes
        let next = Task { @MainActor in
            await previous?.value
            return await work()
        }
        changes = Task { _ = await next.value }
        return await next.value
    }

    /// Shows a change straight away, sends it, and puts things back if the Mac doesn't accept it.
    /// `request` returns the task as the Mac now has it, or nil if it was deleted.
    @discardableResult
    private func send(
        _ id: Int,
        showing edit: ((inout TodoTask) -> Void)? = nil,
        ifChangedOnMac: Conflict.Mine? = nil,
        _ request: @escaping @MainActor (HubClient, TodoTask) async throws -> TodoTask?
    ) async -> Bool {
        await inOrder { [self] in
            guard let client, let base = task(id) else { return false }
            let before = (list: tasks.first { $0.id == id }, detail: details[id])
            if let edit { change(id, edit) }
            do {
                if let updated = try await request(client, base) { keep(updated) } else { forget(id) }
                return true
            } catch HubError.conflict(let current) {
                keep(current)
                if let mine = ifChangedOnMac { conflict = Conflict(mine: mine, current: current) }
                return false
            } catch {
                // Put back what was showing, unless something newer has arrived in the meantime.
                if task(id)?.rev == base.rev {
                    if let list = before.list, let index = tasks.firstIndex(where: { $0.id == id }) { tasks[index] = list }
                    details[id] = before.detail
                    tasks = tasks.inListOrder()
                }
                report(error)
                if issue != nil, case HubError.transport = error {
                    notice = Notice(text: "Not saved: your Mac can’t be reached.", isError: true)
                }
                return false
            }
        }
    }

    /// Edits a task's fields.
    func update(_ id: Int, _ patch: TaskPatch) async {
        guard !patch.isEmpty else { return }
        await send(id, showing: { $0 = patch.applied(to: $0) }, ifChangedOnMac: .edit(patch)) { client, base in
            let result = try await client.update(id, rev: base.rev, patch)
            if let next = result.next { self.keep(next) }
            return result.task
        }
    }

    func complete(_ id: Int) async {
        await send(id, showing: { $0.status = .done }) { client, _ in
            let result = try await client.complete(id)
            if let next = result.next {
                self.keep(next)
                self.announce("Done. The next one is due \(next.due?.label(relativeTo: .today()).lowercased() ?? "later").")
            }
            return result.task
        }
    }

    func delete(_ id: Int) async {
        await send(id, ifChangedOnMac: .delete) { client, base in
            try await client.delete(id, rev: base.rev)
            return nil
        }
    }

    func addComment(_ id: Int, _ text: String) async -> Bool {
        await send(id) { client, _ in try await client.addComment(id, text: text) }
    }

    func addSubtask(_ id: Int, _ title: String) async -> Bool {
        await send(id) { client, _ in try await client.addSubtask(id, title: title) }
    }

    func setSubtask(_ id: Int, _ subtask: Int, done: Bool) async {
        await send(id, showing: { task in
            if let index = task.subtasks.firstIndex(where: { $0.id == subtask }) { task.subtasks[index].done = done }
        }) { client, _ in try await client.setSubtask(id, subtask: subtask, done: done) }
    }

    func renameSubtask(_ id: Int, _ subtask: Int, _ title: String) async {
        await send(id) { client, _ in try await client.renameSubtask(id, subtask: subtask, title: title) }
    }

    func removeSubtask(_ id: Int, _ subtask: Int) async {
        await send(id, showing: { $0.subtasks.removeAll { $0.id == subtask } }) { client, _ in try await client.removeSubtask(id, subtask: subtask) }
    }

    /// Applies or drops a change the Mac refused because the task had changed there.
    func resolve(_ conflict: Conflict, applyMine: Bool) async {
        self.conflict = nil
        guard applyMine else { return }
        switch conflict.mine {
        case .edit(let patch): await update(conflict.current.id, patch)
        case .delete: await delete(conflict.current.id)
        }
    }

    // MARK: Quick capture

    /// Adds a task from one line, read by the Mac. Returns whether it was added.
    func capture(_ line: String) async -> Bool {
        guard let client else { return false }
        do {
            let captured = try await client.capture(line)
            keep(captured.task)
            announce("Added “\(captured.task.title)”")
            return true
        } catch {
            report(error)
            if issue != nil, case HubError.transport = error {
                notice = Notice(text: "Not added: your Mac can’t be reached.", isError: true)
            }
            return false
        }
    }

    /// How the Mac would read a line, for showing while typing. Nil if it can't be asked.
    func preview(_ line: String) async -> ParsedCapture? {
        try? await client?.preview(line)
    }

    private func announce(_ text: String) {
        notice = Notice(text: text)
    }
}
