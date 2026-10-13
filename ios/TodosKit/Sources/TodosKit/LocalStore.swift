// What this iPhone keeps on disk: the list as the Mac last sent it, so the app
// opens at once and can be read offline, and the changes made here that the Mac
// has not accepted yet.
//
// Everything is plain JSON, written whole and atomically. The list is one file.
// Each waiting change is a file of its own, so that an extension can add one
// without rewriting anything the app has open.

import Foundation

/// The list as the Mac last sent it.
public struct CachedList: Codable, Sendable, Equatable {
    /// A task here carries its history once that has been fetched; `historyRevisions` says how fresh it is.
    public var tasks: [TodoTask] = []
    /// The Mac's version of the whole list when it was fetched.
    public var version: Int?
    public var syncedAt: Date?
    /// Task id to the revision its history was fetched at.
    public var historyRevisions: [Int: Int] = [:]

    public init() {}

    /// Open tasks first, whose history is missing or out of date.
    public var tasksNeedingHistory: [Int] {
        tasks.filter { historyRevisions[$0.id] != $0.rev }
            .sorted { ($0.status.isOpen ? 0 : 1, $1.updatedAt) < ($1.status.isOpen ? 0 : 1, $0.updatedAt) }
            .map(\.id)
    }
}

public actor LocalStore {
    private struct CacheFile: Codable {
        var schema: Int
        var list: CachedList
    }

    /// Raised whenever the cache's shape changes. An older cache is thrown away and fetched again; waiting changes are never thrown away.
    static let schema = 1

    private let directory: URL
    private let outbox: URL
    private let cacheFile: URL

    public private(set) var list = CachedList()
    /// Waiting changes, in the order they were made.
    public private(set) var changes: [PendingChange] = []
    /// Where each waiting change is on disk.
    private var files: [UUID: URL] = [:]

    /// Opens (or creates) the store in `directory` and reads what is there.
    public init(directory: URL) {
        self.directory = directory
        outbox = directory.appendingPathComponent("outbox", isDirectory: true)
        cacheFile = directory.appendingPathComponent("list.json")
        try? FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: cacheFile), let file = try? HubJSON.decoder().decode(CacheFile.self, from: data), file.schema == Self.schema {
            list = file.list
        }
        (changes, files) = Self.readChanges(in: outbox)
    }

    // MARK: The list

    /// Replaces the list with a fresh one from the Mac. Lists come without histories, so
    /// the histories already here are kept until a newer one is fetched.
    public func replaceList(_ tasks: [TodoTask], version: Int?, syncedAt: Date = Date()) {
        let known = Dictionary(list.tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        list.tasks = tasks.map { fresh in
            var task = fresh
            if task.activity == nil, let history = known[task.id]?.activity {
                task.activity = history
                // An up-to-date history says how many comments there are; a stale one doesn't, so the list's count stays.
                if list.historyRevisions[task.id] == task.rev { task.comments = nil }
            }
            return task
        }
        let ids = Set(tasks.map(\.id))
        list.historyRevisions = list.historyRevisions.filter { ids.contains($0.key) }
        list.version = version
        list.syncedAt = syncedAt
        saveList()
    }

    /// Stores one task as the Mac just returned it (after a change, or fetched for its history).
    public func keep(_ fresh: TodoTask) {
        var task = fresh
        if let index = list.tasks.firstIndex(where: { $0.id == task.id }) {
            if task.activity == nil { task.activity = list.tasks[index].activity }
            list.tasks[index] = task
        } else {
            list.tasks.append(task)
        }
        if fresh.activity != nil { list.historyRevisions[task.id] = task.rev }
        list.tasks = list.tasks.inListOrder()
        saveList()
    }

    public func forget(task id: Int) {
        list.tasks.removeAll { $0.id == id }
        list.historyRevisions[id] = nil
        saveList()
    }

    public func task(_ id: Int) -> TodoTask? {
        list.tasks.first { $0.id == id }
    }

    private func saveList() {
        guard let data = try? HubJSON.encoder().encode(CacheFile(schema: Self.schema, list: list)) else { return }
        try? data.write(to: cacheFile, options: Self.writing)
    }

    // MARK: Waiting changes

    /// Saves a new change. It goes after every change already waiting.
    @discardableResult
    public func add(_ kind: PendingChange.Kind, at date: Date = Date()) -> PendingChange {
        // Strictly later than the last one, so the order survives two changes in the same millisecond.
        let after = changes.last.map { $0.createdAt.addingTimeInterval(0.001) } ?? .distantPast
        // Whole milliseconds, which is what is written to disk and sent to the Mac.
        let millis = (max(date, after).timeIntervalSince1970 * 1000).rounded()
        let change = PendingChange(createdAt: Date(timeIntervalSince1970: millis / 1000), kind: kind)
        changes.append(change)
        write(change)
        return change
    }

    /// Saves a change that already exists, with a new state or contents.
    public func put(_ change: PendingChange) {
        if let index = changes.firstIndex(where: { $0.id == change.id }) {
            changes[index] = change
        } else {
            changes.append(change)
            changes.sort { ($0.createdAt, $0.id.uuidString) < ($1.createdAt, $1.id.uuidString) }
        }
        write(change)
    }

    public func remove(change id: UUID) {
        guard let index = changes.firstIndex(where: { $0.id == id }) else { return }
        if let file = files.removeValue(forKey: id) { try? FileManager.default.removeItem(at: file) }
        changes.remove(at: index)
    }

    /// Swaps one change for another in the same place in the order (same time, new identity).
    public func replace(_ old: PendingChange, with kind: PendingChange.Kind, state: PendingChange.State) -> PendingChange {
        remove(change: old.id)
        let new = PendingChange(createdAt: old.createdAt, kind: kind, state: state)
        put(new)
        return new
    }

    /// Reads the waiting changes again from disk, to pick up ones another process added.
    public func reloadChanges() {
        (changes, files) = Self.readChanges(in: outbox)
    }

    /// After a change to a task was accepted and moved it from one revision to the next:
    /// later edits based on the old revision are now based on the new one, since the
    /// only thing that happened in between was this iPhone's own change.
    public func advance(task: Int, from old: Int, to new: Int) {
        for change in changes where change.isWaiting {
            switch change.kind {
            case .update(task, old, let base, let patch):
                put(PendingChange(id: change.id, createdAt: change.createdAt, kind: .update(task: task, baseRev: new, base: base, patch: patch)))
            case .delete(task, old):
                put(PendingChange(id: change.id, createdAt: change.createdAt, kind: .delete(task: task, baseRev: new)))
            default:
                break
            }
        }
    }

    /// A subtask added here was given its real id by the Mac: later changes to it now use that.
    public func renumber(subtask localID: Int, of task: Int, to id: Int) {
        for change in changes {
            var kind: PendingChange.Kind?
            switch change.kind {
            case .setSubtask(task, localID, let done): kind = .setSubtask(task: task, subtask: id, done: done)
            case .renameSubtask(task, localID, let title): kind = .renameSubtask(task: task, subtask: id, title: title)
            case .removeSubtask(task, localID): kind = .removeSubtask(task: task, subtask: id)
            default: break
            }
            if let kind { put(PendingChange(id: change.id, createdAt: change.createdAt, kind: kind, state: change.state)) }
        }
    }

    /// Removes everything: the list and every waiting change. For unpairing.
    public func erase() {
        try? FileManager.default.removeItem(at: cacheFile)
        try? FileManager.default.removeItem(at: outbox)
        try? FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        list = CachedList()
        changes = []
        files = [:]
    }

    // MARK: Files

    /// Atomic, and readable once the iPhone has been unlocked after a restart (so a widget or
    /// background refresh can read it while the screen is locked).
    private static let writing: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    /// A change keeps the file it was first written to. New ones are named so that sorting
    /// by name is sorting by time: "000001791854321123-<uuid>.json".
    private func write(_ change: PendingChange) {
        guard let data = try? HubJSON.encoder().encode(change) else { return }
        let millis = Int((change.createdAt.timeIntervalSince1970 * 1000).rounded())
        let file = files[change.id] ?? outbox.appendingPathComponent(String(format: "%018d-%@.json", max(millis, 0), change.id.uuidString))
        files[change.id] = file
        try? data.write(to: file, options: Self.writing)
    }

    private static func readChanges(in outbox: URL) -> (changes: [PendingChange], files: [UUID: URL]) {
        let found = (try? FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)) ?? []
        var changes: [PendingChange] = []
        var files: [UUID: URL] = [:]
        for file in found.filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            if let data = try? Data(contentsOf: file), let change = try? HubJSON.decoder().decode(PendingChange.self, from: data) {
                changes.append(change)
                files[change.id] = file
            } else {
                // Something this version can't read. Set it aside rather than delete it: it was the user's change.
                let aside = outbox.appendingPathComponent("unreadable", isDirectory: true)
                try? FileManager.default.createDirectory(at: aside, withIntermediateDirectories: true)
                try? FileManager.default.moveItem(at: file, to: aside.appendingPathComponent(file.lastPathComponent))
            }
        }
        return (changes.sorted { ($0.createdAt, $0.id.uuidString) < ($1.createdAt, $1.id.uuidString) }, files)
    }
}

// MARK: - Deciding what happens to a change that was set aside

extension LocalStore {
    /// A conflicted edit, decided: `mine` holds the fields to send after all (as they
    /// were, or reworded), on top of the Mac's version. Fields left out are given up.
    @discardableResult
    public func resolveEdit(_ id: UUID, keeping mine: TaskPatch) -> Bool {
        guard let change = changes.first(where: { $0.id == id }), case .update(let task, _, _, _) = change.kind,
              case .conflict(let theirs) = change.state else { return false }
        if mine.isEmpty {
            remove(change: id)
        } else {
            _ = replace(change, with: .update(task: task, baseRev: theirs.rev, base: TaskPatch(of: theirs, fields: mine.fields), patch: mine), state: .waiting)
        }
        return true
    }

    /// A delete the Mac refused because the task had changed, decided: delete it as it is now, or keep it.
    @discardableResult
    public func resolveDelete(_ id: UUID, deleteAnyway: Bool) -> Bool {
        guard let change = changes.first(where: { $0.id == id }), case .delete(let task, _) = change.kind,
              case .conflict(let theirs) = change.state else { return false }
        if deleteAnyway {
            _ = replace(change, with: .delete(task: task, baseRev: theirs.rev), state: .waiting)
        } else {
            remove(change: id)
        }
        return true
    }

    /// The task was deleted on the Mac while changes for it were waiting here. Puts it
    /// back: the task as this iPhone last saw it, with those changes applied. Comments
    /// can't be recreated with a task, so they stay set aside, where their text can still be read.
    @discardableResult
    public func restoreTask(for id: UUID, clientName: String = HubClient.defaultClientName) -> Bool {
        guard let change = changes.first(where: { $0.id == id }), let task = change.taskID,
              case .taskDeleted(let last?) = change.state else { return false }
        var restored: TodoTask? = last
        var used: [UUID] = []
        for other in changes where other.taskID == task {
            if case .comment = other.kind { continue }
            var waiting = other
            waiting.state = .waiting
            restored = restored?.applying(waiting, clientName: clientName)
            used.append(other.id)
        }
        used.forEach { remove(change: $0) }
        if let restored { add(.restore(task: restored)) } // nil when one of the changes was a delete: it stays deleted
        return true
    }

    /// Gives a change up. Only ever called because the user chose to.
    public func discard(_ id: UUID) {
        remove(change: id)
    }

    /// Puts a refused change back in the queue to be tried again.
    public func retry(_ id: UUID) {
        guard var change = changes.first(where: { $0.id == id }), case .rejected = change.state else { return }
        change.state = .waiting
        put(change)
    }
}
