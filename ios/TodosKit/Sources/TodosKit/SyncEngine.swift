// Sends this iPhone's waiting changes to the Mac, in order, and brings the list up to date.
//
// For each change, one of four things happens:
//   - the Mac accepts it, and it is done;
//   - the Mac can't be reached (or refuses everything, as with a revoked token):
//     the change stays waiting and sending stops until next time;
//   - the task changed on the Mac first: the two are merged field by field, and
//     only what truly overlaps is kept aside for the user to decide;
//   - the Mac refuses this particular change: it is kept aside with the reason.
// A change is never discarded without the user having chosen that.

import Foundation

public enum ReplayOutcome: Sendable, Equatable {
    /// Every waiting change was dealt with: accepted, merged, or set aside for the user.
    case finished
    /// The Mac couldn't be reached, or refused everything. What was left is still waiting.
    case interrupted(HubError)
}

public struct SyncEngine: Sendable {
    public let client: HubClient
    public let store: LocalStore

    public init(client: HubClient, store: LocalStore) {
        self.client = client
        self.store = store
    }

    // MARK: Sending

    /// Sends waiting changes in the order they were made. A task that has a change
    /// set aside for the user keeps its later changes waiting behind it, so they are
    /// never applied out of order; other tasks carry on.
    public func replay() async -> ReplayOutcome {
        while true {
            let changes = await store.changes
            let held = Set(changes.filter(\.needsAttention).compactMap(\.taskID))
            guard let next = changes.first(where: { $0.isWaiting && !($0.taskID.map(held.contains) ?? false) }) else { return .finished }
            do {
                try await send(next)
            } catch HubError.rateLimited(let retryAfter) {
                // The Mac takes 120 changes a minute. Wait as long as it says, then carry on.
                do {
                    try await Task.sleep(for: .seconds(min(max(retryAfter ?? 5, 1), 60)))
                } catch {
                    return .interrupted(.rateLimited(retryAfter: retryAfter))
                }
            } catch let error as HubError {
                return .interrupted(error)
            } catch {
                return .interrupted(.transport(.cancelled))
            }
        }
    }

    /// Sends one change. Returns once it is done or set aside; throws if the Mac couldn't be asked.
    private func send(_ change: PendingChange) async throws {
        switch change.kind {
        case .capture(let line):
            do {
                await finish(change, try await client.capture(line, typedAt: change.createdAt, key: change.id).task)
            } catch let error as HubError where error.isAboutThisChange {
                await setAside(change, error)
            }

        case .restore(let task):
            do {
                await finish(change, try await client.create(like: task, key: change.id))
            } catch let error as HubError where error.isAboutThisChange {
                await setAside(change, error)
            }

        case .add(let title, let notes):
            do {
                await finish(change, try await client.create(like: TodoTask(id: 0, title: title, notes: notes), key: change.id))
            } catch let error as HubError where error.isAboutThisChange {
                await setAside(change, error)
            }

        case .update(let task, let baseRev, let base, let patch):
            try await sendUpdate(change, task: task, baseRev: baseRev, base: base, patch: patch)

        case .delete(let task, let baseRev):
            do {
                try await client.delete(task, rev: baseRev)
                await store.forget(task: task)
                await store.remove(change: change.id)
            } catch HubError.notFound {
                await store.forget(task: task) // already gone, which is what was wanted
                await store.remove(change: change.id)
            } catch HubError.conflict(let theirs) {
                await store.keep(theirs)
                _ = await store.replace(change, with: .delete(task: task, baseRev: theirs.rev), state: .conflict(theirs: theirs))
            }

        case .complete(let task):
            try await sendAdditive(change, task: task) { try await client.complete(task, key: change.id) }

        case .comment(let task, let text):
            try await sendAdditive(change, task: task) { TaskResult(try await client.addComment(task, text: text, key: change.id)) }

        case .addSubtask(let task, let title, let localID):
            let known = Set(await store.task(task)?.subtasks.map(\.id) ?? [])
            try await sendAdditive(change, task: task) {
                let updated = try await client.addSubtask(task, title: title, key: change.id)
                // The Mac gave the new subtask an id; changes made to it while it was only here now use that.
                if let real = updated.subtasks.last(where: { !known.contains($0.id) && $0.title == title })?.id ?? updated.subtasks.last?.id {
                    await store.renumber(subtask: localID, of: task, to: real)
                }
                return TaskResult(updated)
            }

        case .setSubtask(let task, let subtask, let done):
            try await sendSubtask(change, task: task) { try await client.setSubtask(task, subtask: subtask, done: done, key: change.id) }

        case .renameSubtask(let task, let subtask, let title):
            try await sendSubtask(change, task: task) { try await client.renameSubtask(task, subtask: subtask, title: title, key: change.id) }

        case .removeSubtask(let task, let subtask):
            try await sendSubtask(change, task: task) { try await client.removeSubtask(task, subtask: subtask, key: change.id) }

        // Habits. The Mac is told when and where each was tapped, and judges it as of
        // then. A day is only named when it is yesterday being logged late.
        case .checkIn(let habit, _, let slot, let day, let at, let zone, let source, let backfilled):
            try await sendHabit(change) { try await client.checkIn(habit, slot: slot, at: at, zone: zone, day: backfilled ? day : nil, source: source, key: change.id).habit }

        case .undoCheckIn(let habit, _, _, _, let checkins, let keys, let at):
            try await sendHabit(change) { try await client.undoCheckIns(habit, checkins: checkins, keys: keys, at: at, key: change.id) }

        case .skipHabit(let habit, _, let day, let at, let zone, let reason):
            try await sendHabit(change) { try await client.skip(habit, day: day, at: at, zone: zone, reason: reason, key: change.id).habit }

        case .undoSkip(let habit, _, let day, let at, let zone):
            try await sendHabit(change) { try await client.undoSkip(habit, day: day, at: at, zone: zone, key: change.id) }
        }
    }

    /// A check-in, a skip, or one of them taken back. None can conflict: they are only
    /// ever added. What can go wrong for good is the habit being gone, or a rule
    /// refusing it (too late, too many skips), and then the Mac's own words are kept
    /// with the change for the user to read.
    private func sendHabit(_ change: PendingChange, _ request: () async throws -> Habit) async throws {
        do {
            await store.keep(try await request())
            await store.remove(change: change.id)
        } catch HubError.notFound {
            if let habit = change.habitID { await store.forget(habit: habit) }
            _ = await store.replace(change, with: change.kind, state: .rejected(message: "“\(change.habitName ?? "That habit")” was deleted on your Mac."))
        } catch let error as HubError where error.isAboutThisChange {
            await setAside(change, error)
        }
    }

    private typealias TaskResult = HubClient.TaskResult

    /// An edit. If the task changed on the Mac first, merge and try again on top of
    /// the Mac's version; whatever truly conflicts is set aside for the user.
    private func sendUpdate(_ change: PendingChange, task: Int, baseRev: Int, base: TaskPatch, patch: TaskPatch) async throws {
        var rev = baseRev
        var sending = patch
        for _ in 0..<5 {
            do {
                let result = try await client.update(task, rev: rev, sending, key: change.id)
                await finish(change, result.task, next: result.next)
                return
            } catch HubError.conflict(let theirs) {
                await store.keep(theirs)
                let merged = ThreeWayMerge.merge(base: base, mine: patch, theirs: theirs)
                if merged.isClean {
                    if merged.apply.isEmpty { // the Mac already has everything this edit wanted
                        await store.remove(change: change.id)
                        return
                    }
                    rev = theirs.rev
                    sending = merged.apply
                    continue
                }
                // Part of the edit overlaps. Send the part that doesn't, and keep the rest for the user.
                var latest = theirs
                if !merged.apply.isEmpty {
                    do {
                        latest = try await client.update(task, rev: theirs.rev, merged.apply).task
                        await store.keep(latest)
                    } catch HubError.conflict {
                        continue // it moved again; merge afresh
                    }
                }
                let kind = PendingChange.Kind.update(task: task, baseRev: latest.rev, base: base.only(merged.conflicts), patch: patch.only(merged.conflicts))
                _ = await store.replace(change, with: kind, state: .conflict(theirs: latest))
                return
            } catch HubError.notFound {
                _ = await store.replace(change, with: change.kind, state: .taskDeleted(last: await store.task(task)))
                await store.forget(task: task)
                return
            } catch let error as HubError where error.isAboutThisChange {
                await setAside(change, error)
                return
            }
        }
        throw HubError.server(status: 409, code: "conflict", message: nil) // still moving after five tries: leave it waiting
    }

    /// A change that can't conflict (complete, comment, add a subtask). The only way it fails
    /// for good is the task having been deleted.
    private func sendAdditive(_ change: PendingChange, task: Int, _ request: () async throws -> TaskResult) async throws {
        do {
            let result = try await request()
            await finish(change, result.task, next: result.next)
        } catch HubError.notFound {
            _ = await store.replace(change, with: change.kind, state: .taskDeleted(last: await store.task(task)))
            await store.forget(task: task)
        } catch let error as HubError where error.isAboutThisChange {
            await setAside(change, error)
        }
    }

    /// A change to one subtask. If the subtask (or its task) is gone on the Mac, there is
    /// nothing left to change, so the change is simply finished.
    private func sendSubtask(_ change: PendingChange, task: Int, _ request: () async throws -> TodoTask) async throws {
        do {
            await finish(change, try await request())
        } catch let error as HubError where error.isAboutThisChange {
            await store.remove(change: change.id)
        }
    }

    private func finish(_ change: PendingChange, _ task: TodoTask, next: TodoTask? = nil) async {
        await store.keep(task)
        if let next { await store.keep(next) }
        await store.remove(change: change.id)
        // Later edits to this task were based on the revision before this one.
        await store.advance(task: task.id, from: task.rev - 1, to: task.rev)
    }

    private func setAside(_ change: PendingChange, _ error: HubError) async {
        _ = await store.replace(change, with: change.kind, state: .rejected(message: error.serverMessage ?? "Your Mac refused this change."))
    }

    /// Sends waiting changes, but stops waiting after `seconds`: for an extension or a
    /// widget's button, which must not keep the user (or iOS) waiting on a Mac that
    /// can't be reached. Whatever was not sent stays in the queue for the app.
    public func replay(givingUpAfter seconds: Double) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = await replay() }
            group.addTask { try? await Task.sleep(for: .seconds(seconds)) }
            await group.next()
            group.cancelAll()
        }
    }

    // MARK: Fetching

    /// Fetches the whole list and stores it. Then fetches the histories (comments and
    /// activity) that are missing or out of date, a batch at a time, so tasks can be read offline.
    @discardableResult
    public func refresh(histories limit: Int = 40) async throws -> CachedList {
        let snapshot = try await client.allTasks()
        await store.replaceList(snapshot.tasks, version: snapshot.version)
        for id in await store.list.tasksNeedingHistory.prefix(limit) {
            do {
                await store.keep(try await client.task(id))
            } catch HubError.notFound {
                await store.forget(task: id)
            }
        }
        return await store.list
    }

    /// Fetches the habits and stores them. A Mac whose Todos is older than habits has
    /// none of this and answers 404: that is remembered, and is not an error.
    @discardableResult
    public func refreshHabits() async throws -> CachedHabits {
        do {
            let fresh = try await client.habits()
            await store.replaceHabits(fresh.habits, version: fresh.version, zone: fresh.zone)
        } catch HubError.notFound {
            await store.habitsUnsupported()
        }
        return await store.habits
    }

    /// Fetches how each habit went on each day of this year so far, for the year widget,
    /// and stores it. Days before yesterday no longer change, and today and yesterday are
    /// worked out on the phone, so this is only needed once a day, or when a habit is new.
    /// `today` is the habit day it is now.
    public func refreshCalendar(today: Day) async throws {
        let cached = await store.habits
        let ids = cached.habits.map(\.id)
        if let calendar = cached.calendar, calendar.asOf == today, Set(calendar.habits.map(\.habit)) == Set(ids) { return }
        let start = Day(year: today.year, month: 1, day: 1)!
        let client = self.client
        let marks = try await withThrowingTaskGroup(of: HabitCalendar.Marks?.self) { group in
            for id in ids {
                group.addTask {
                    do {
                        return HabitCalendar.Marks(habit: id, days: try await client.habitHistory(id, from: start, to: today).days)
                    } catch HubError.notFound {
                        return nil // deleted in the meantime
                    }
                }
            }
            var all: [HabitCalendar.Marks] = []
            for try await found in group {
                if let found { all.append(found) }
            }
            return all.sorted { $0.habit < $1.habit }
        }
        await store.replaceCalendar(HabitCalendar(year: today.year, asOf: today, habits: marks))
    }

    /// Fetches one task with its history and stores it.
    @discardableResult
    public func fetch(_ id: Int) async throws -> TodoTask? {
        do {
            let task = try await client.task(id)
            await store.keep(task)
            return task
        } catch HubError.notFound {
            await store.forget(task: id)
            return nil
        }
    }
}

extension HubClient.TaskResult {
    init(_ task: TodoTask) {
        self.init(task: task, next: nil)
    }
}

extension HubError {
    /// True when the Mac answered about this one change (refused it, or its task is gone),
    /// as opposed to not being reachable or refusing everything.
    var isAboutThisChange: Bool {
        switch self {
        case .notFound, .invalid, .preconditionRequired, .conflict, .habitConflict: true
        default: false
        }
    }
}
