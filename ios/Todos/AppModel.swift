// The app's state: whether this iPhone is paired, the task list, the habits, the
// connection to the Mac, and every change the screens can make.
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
    /// The habits as shown: what the Mac last sent, with this iPhone's waiting check-ins on
    /// top and the days since then reckoned here (see TodosKit's HabitReckoning).
    private(set) var habits: [Habit] = []
    /// False when the Todos on the Mac is too old to have habits. Nil until it has said.
    private(set) var habitsSupported: Bool?
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

    /// What the list shows and in what order. Kept on this iPhone between launches, all but
    /// the search (see TaskQuery's Codable conformance).
    var query = TaskQuery() {
        didSet {
            if query != oldValue { defaults.set(try? JSONEncoder().encode(query), forKey: Self.queryKey) }
        }
    }
    var notice: Notice?
    /// Set by any screen to show the Sync screen: what is waiting, and what needs a decision.
    var isShowingSync = false
    /// A task to open: set when a reminder or the widget is tapped.
    var requestedTask: Int?
    /// A habit to open, likewise.
    var requestedHabit: Int?
    /// The Habits tab to bring forward: set when the year widget is tapped.
    var requestedHabits = false

    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let makeClient: (HubCredentials) -> HubClient
    @ObservationIgnored private let liveStates: (HubClient) -> AsyncStream<LiveState>
    @ObservationIgnored private let dataDirectory: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var client: HubClient?
    @ObservationIgnored private var store: LocalStore?
    @ObservationIgnored private var engine: SyncEngine?
    @ObservationIgnored private var list = CachedList()
    @ObservationIgnored private var cachedHabits = CachedHabits()
    @ObservationIgnored private var live: Task<Void, Never>?
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var sendAgain = false
    @ObservationIgnored private var compatibilityChecked = false
    @ObservationIgnored private var isRefreshing = false
    @ObservationIgnored private var refreshQueued = false
    // Logs say what happened, never what a task says or what the token is.
    @ObservationIgnored private let log = Logger(subsystem: "com.abhishekpratapa.todos.ios", category: "sync")

    /// The defaults are the real thing: the Keychain, the network, the Mac's event stream,
    /// the shared container and this app's own settings. Tests replace them.
    init(
        credentials: any CredentialStore = KeychainCredentialStore(),
        makeClient: @escaping (HubCredentials) -> HubClient = { HubClient(credentials: $0) },
        liveStates: @escaping (HubClient) -> AsyncStream<LiveState> = { LiveUpdates(client: $0).states() },
        dataDirectory: URL = SharedContainer.directory,
        defaults: UserDefaults = .standard
    ) {
        self.credentials = credentials
        self.makeClient = makeClient
        self.liveStates = liveStates
        self.dataDirectory = dataDirectory
        self.defaults = defaults
        // Anything that can't be read any more (a sort from a later version) is left as it starts.
        query = defaults.data(forKey: Self.queryKey).flatMap { try? JSONDecoder().decode(TaskQuery.self, from: $0) } ?? TaskQuery()
    }

    private static let queryKey = "taskQuery"

    /// Called whenever what is on screen has been worked out afresh, with the tasks and
    /// habits as shown. The app uses it to reschedule reminders and refresh the widgets.
    @ObservationIgnored var didReload: (@MainActor ([TodoTask], [Habit]) async -> Void)?

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
        cachedHabits = CachedHabits()
        changes = []
        tasks = []
        habits = []
        habitsSupported = nil
        hasLoaded = false
        lastSynced = nil
        issue = nil
        query = TaskQuery()
        compatibilityChecked = false
        phase = .unpaired
        await didReload?([], [])
    }

    // MARK: Connection

    /// The app came to the front: connect for live updates, send what is waiting, load the list.
    func activate() async {
        guard phase == .paired else { return }
        await store?.reloadChanges() // the share sheet or a widget may have added some while the app was away
        await store?.reloadHabits() // and a widget keeps what the Mac answered its check-in with
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
        await store?.reloadHabits()
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
                try await loadHabits(with: engine)
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
        case .habitsChanged(let version):
            if version != cachedHabits.version { await refreshHabits() }
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
        case .transport(.cancelled), .conflict, .habitConflict, .preconditionRequired, .notFound, .invalid:
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

    var tags: [String] {
        tasks.tags
    }

    /// The open tasks by when they are due, as the widget has them. The Today tab shows the
    /// first two groups (`todaySections`), and its badge counts them (`dueNow`).
    var due: DueOverview {
        DueOverview(tasks: tasks, on: .today())
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
        waiting.filter { $0.taskID == nil && $0.habitID == nil }
    }

    func hasWaitingChanges(_ task: Int) -> Bool {
        changes.contains { $0.taskID == task && $0.isWaiting }
    }

    func needsAttention(_ task: Int) -> Bool {
        changes.contains { $0.taskID == task && $0.needsAttention }
    }

    /// The title of the task (or the name of the habit) a change is for, as this iPhone knows it.
    func title(for change: PendingChange) -> String? {
        if let name = change.habitName { return name }
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
        cachedHabits = await store.habits
        changes = await store.changes
        tasks = list.tasks.applying(changes).inListOrder()
        habits = cachedHabits.habits.reckoned(with: changes)
        habitsSupported = cachedHabits.supported
        lastSynced = list.syncedAt
        hasLoaded = list.syncedAt != nil
        await didReload?(tasks, habits)
    }

    // MARK: Habits

    /// Fetches the habits, and tells the Mac where this iPhone is if it has that wrong:
    /// "today" is told by the time zone the user is in.
    private func loadHabits(with engine: SyncEngine) async throws {
        var fetched = try await engine.refreshHabits()
        let here = TimeZone.current.identifier
        if fetched.supported == true, fetched.zone != here {
            try await engine.client.reportZone(here)
            fetched = try await engine.refreshHabits()
        }
        // The year so far, for the year widget: once a day. It is a picture of the past,
        // so if it can't be fetched the habits themselves are still fine.
        if fetched.supported == true, let today = fetched.habits.map(\.today.day).max() {
            try? await engine.refreshCalendar(today: today)
        }
    }

    /// Fetches just the habits: for when the Mac says they changed.
    func refreshHabits() async {
        guard let engine else { return }
        do {
            try await loadHabits(with: engine)
        } catch {
            report(error)
        }
        await reload()
    }

    /// Works the habits out again for the time it is now. A new day begins while the app
    /// is open, and nothing else would notice.
    func reckonHabits() {
        let now = cachedHabits.habits.reckoned(with: changes)
        if now != habits { habits = now }
    }

    func habit(_ id: Int) -> Habit? {
        habits.first { $0.id == id }
    }

    /// The day of a habit a change is for: today, or yesterday while it can still be logged.
    private func day(of habit: Habit, yesterday: Bool) -> Day {
        yesterday ? habit.yesterday.day : habit.today.day
    }

    /// Checks in a habit, or one slot of it. With no slot named it is the one still to do.
    /// It shows at once and is sent when the Mac can be reached.
    func checkIn(_ habit: Habit, slot: String? = nil, yesterday: Bool = false, source: HabitSource = .manual) async {
        let day = yesterday ? habit.yesterday : habit.today
        let chosen = habit.isWeekly ? nil : (slot ?? (yesterday ? day.remaining.first?.id : habit.slotToCheckIn()))
        guard habit.isWeekly ? day.state != .done : chosen != nil else { return } // nothing left to check in
        await make(.checkIn(habit: habit.id, name: habit.name, slot: chosen, day: day.day, at: Date(), zone: TimeZone.current.identifier, source: source, backfilled: yesterday))
    }

    /// Takes a check-in back: the ones the Mac has for that slot, and any made here that
    /// it may not have yet. Naming them means it can't remove one made somewhere else since.
    func undoCheckIn(_ habit: Habit, slot: String? = nil, yesterday: Bool = false) async {
        let day = day(of: habit, yesterday: yesterday)
        let onMac = cachedHabits.habits.first { $0.id == habit.id }.flatMap { [$0.today, $0.yesterday].first { $0.day == day } }
        let checkins = onMac.map { $0.isSession ? $0.checkins : $0.slots.filter { slot == nil || $0.id == slot }.flatMap(\.checkins) } ?? []
        // Leaving out whatever an undo that is still waiting has already named.
        var takenBack: Set<Int> = []
        var takenBackHere: Set<UUID> = []
        var keys: [UUID] = []
        for change in changes where change.habitID == habit.id && change.isWaiting {
            switch change.kind {
            case .undoCheckIn(_, _, _, _, let ids, let named, _):
                takenBack.formUnion(ids)
                takenBackHere.formUnion(named)
            case .checkIn(_, _, let itsSlot, day, _, _, _, _) where slot == nil || itsSlot == slot:
                keys.append(change.id)
            default:
                break
            }
        }
        let ids = checkins.filter { !takenBack.contains($0) }
        keys.removeAll(where: takenBackHere.contains)
        guard !ids.isEmpty || !keys.isEmpty else { return }
        await make(.undoCheckIn(habit: habit.id, name: habit.name, slot: slot, day: day, checkins: ids, keys: keys, at: Date()))
    }

    /// Marks today (or yesterday) as a rest day: it neither breaks the streak nor adds to it.
    func skip(_ habit: Habit, yesterday: Bool = false, reason: String? = nil) async {
        await make(.skipHabit(habit: habit.id, name: habit.name, day: day(of: habit, yesterday: yesterday), at: Date(), zone: TimeZone.current.identifier, reason: reason))
    }

    func undoSkip(_ habit: Habit, yesterday: Bool = false) async {
        await make(.undoSkip(habit: habit.id, name: habit.name, day: day(of: habit, yesterday: yesterday), at: Date(), zone: TimeZone.current.identifier))
    }

    enum OutsideCheckIn: Equatable {
        case checkedIn, alreadyDone, tooLate, notFound, notPaired
        /// The habit has no time of day by that name. These are the ones it has.
        case noSuchSlot([String])
    }

    /// A check-in from outside the app: the Done button on a reminder, a widget, a Shortcut.
    /// It goes through the same queue as one made in the app, so it is saved at once and
    /// waits if the Mac can't be reached. `day` is the habit day it is for; today, if nil.
    func checkInFromOutside(habit id: Int, slot: String?, day: Day? = nil, source: HabitSource) async -> OutsideCheckIn {
        await start()
        guard phase == .paired, let store else { return .notPaired }
        await store.reloadChanges() // a widget may have added some while the app was away
        await store.reloadHabits()
        await reload()
        guard let habit = habit(id) else { return .notFound }
        let day = day ?? habit.today.day
        guard day == habit.today.day || day == habit.yesterday.day else { return .tooLate }
        // A time of day may be given by its id or by its name ("Evening").
        var chosen = slot
        if let slot, !habit.isWeekly {
            let wanted = slot.trimmingCharacters(in: .whitespaces).lowercased()
            guard let match = habit.schedule.slots.first(where: { $0.id == wanted || $0.name.lowercased() == wanted }) else {
                return .noSuchSlot(habit.schedule.slots.map { $0.name.isEmpty ? $0.id : $0.name })
            }
            chosen = match.id
        } else if habit.isWeekly {
            chosen = nil
        }
        guard habit.isOpen(slot: chosen, on: day) else { return .alreadyDone }
        await checkIn(habit, slot: chosen, yesterday: day != habit.today.day, source: source)
        return .checkedIn
    }

    /// True while a change to this habit is waiting to be sent.
    func hasWaitingChanges(habit id: Int) -> Bool {
        changes.contains { $0.habitID == id && $0.isWaiting }
    }

    // Making and changing habits themselves needs the Mac: unlike a check-in, there is
    // nothing useful to show for a habit the Mac hasn't accepted. Each returns what
    // went wrong, in words for the user, or nil.

    /// Creates a habit, or saves an edit to one.
    func saveHabit(_ draft: HabitDraft, editing habit: Habit? = nil) async -> String? {
        await managing { client in
            if let habit {
                try await client.updateHabit(habit.id, rev: habit.rev, draft)
            } else {
                try await client.createHabit(draft, key: UUID())
            }
        }
    }

    func setHabit(_ habit: Habit, paused: Bool? = nil, archived: Bool? = nil) async -> String? {
        await managing { try await $0.setHabit(habit.id, paused: paused, archived: archived) }
    }

    func deleteHabit(_ habit: Habit) async -> String? {
        let failure = await managing { client in
            try await client.deleteHabit(habit.id)
            return nil
        }
        if failure == nil {
            await store?.forget(habit: habit.id)
            await reload()
        }
        return failure
    }

    private func managing(_ change: (HubClient) async throws -> Habit?) async -> String? {
        guard let client, let store else { return "This iPhone isn’t connected to a Mac." }
        do {
            if let habit = try await change(client) { await store.keep(habit) }
            await reload()
            return nil
        } catch HubError.habitConflict(let current) {
            await store.keep(current)
            await reload()
            return "“\(current.name)” was changed on your Mac while you were editing. It is shown as it is now; make your change again."
        } catch HubError.notFound {
            return "That habit is no longer on your Mac."
        } catch let error as HubError {
            if case .invalid(_, let message) = error { return message }
            report(error)
            return "Your Mac can’t be reached right now. Habits can be changed when it can; check-ins don’t need it."
        } catch {
            return nil // cancelled
        }
    }

    /// A habit's past for a calendar, if the Mac can be reached.
    func history(of habit: Habit) async -> HabitHistory? {
        try? await client?.habitHistory(habit.id)
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
