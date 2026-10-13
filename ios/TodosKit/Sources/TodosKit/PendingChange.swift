// A change made on this iPhone that the Mac has not accepted yet.
//
// Every change goes through here, online or not: it is saved, shown straight away
// on top of the last list the Mac sent, and then sent. If the Mac can't be
// reached it waits; nothing is ever dropped without the user deciding so.

import Foundation

public struct PendingChange: Codable, Sendable, Identifiable, Equatable {
    public enum Kind: Codable, Sendable, Equatable {
        /// A line of quick capture. The Mac reads it when it arrives, so there is one parser.
        case capture(line: String)
        /// Edited fields. `base` holds the same fields as they were before the edit, which
        /// is what lets a later conflict be told apart from an unrelated change.
        case update(task: Int, baseRev: Int, base: TaskPatch, patch: TaskPatch)
        case complete(task: Int)
        case delete(task: Int, baseRev: Int)
        case comment(task: Int, text: String)
        /// `localID` stands in for the subtask's id until the Mac assigns one. It is negative.
        case addSubtask(task: Int, title: String, localID: Int)
        case setSubtask(task: Int, subtask: Int, done: Bool)
        case renameSubtask(task: Int, subtask: Int, title: String)
        case removeSubtask(task: Int, subtask: Int)
        /// Put back a task that was deleted on the Mac while this iPhone had changes for it.
        case restore(task: TodoTask)
    }

    public enum State: Codable, Sendable, Equatable {
        /// Not sent yet, or the Mac couldn't be reached.
        case waiting
        /// The task changed on the Mac in a way that overlaps this change. `theirs` is the Mac's task.
        case conflict(theirs: TodoTask)
        /// The task was deleted on the Mac. `last` is the task as this iPhone last saw it.
        case taskDeleted(last: TodoTask?)
        /// The Mac refused the change. `message` is its explanation.
        case rejected(message: String)
    }

    /// Also the change's idempotency key: sending it twice changes things once.
    public let id: UUID
    /// When the change was made. Changes are sent in this order.
    public let createdAt: Date
    public var kind: Kind
    public var state: State

    public init(id: UUID = UUID(), createdAt: Date = Date(), kind: Kind, state: State = .waiting) {
        self.id = id
        self.createdAt = createdAt
        self.kind = kind
        self.state = state
    }

    /// The task this change is for. Nil for a capture, which makes a new one.
    public var taskID: Int? {
        switch kind {
        case .capture, .restore: nil
        case .update(let task, _, _, _), .complete(let task), .delete(let task, _), .comment(let task, _),
             .addSubtask(let task, _, _), .setSubtask(let task, _, _), .renameSubtask(let task, _, _), .removeSubtask(let task, _): task
        }
    }

    public var isWaiting: Bool { state == .waiting }

    /// True when it can't go any further until the user decides something.
    public var needsAttention: Bool { !isWaiting }

    /// The line of a capture.
    public var capturedLine: String? {
        if case .capture(let line) = kind { return line }
        return nil
    }

    /// What the change does, in a few words: "Edit title and due date", "Add a comment".
    public var summary: String {
        switch kind {
        case .capture(let line): "Add “\(line)”"
        case .update(_, _, _, let patch): "Edit " + patch.fields.map { $0.label.lowercased() }.formatted(.list(type: .and))
        case .complete: "Mark as done"
        case .delete: "Delete"
        case .comment: "Add a comment"
        case .addSubtask(_, let title, _): "Add subtask “\(title)”"
        case .setSubtask(_, _, let done): done ? "Check off a subtask" : "Uncheck a subtask"
        case .renameSubtask: "Rename a subtask"
        case .removeSubtask: "Remove a subtask"
        case .restore(let task): "Put back “\(task.title)”"
        }
    }
}

extension TodoTask {
    /// This task with a waiting change applied, the way it will look once the Mac accepts it.
    /// Returns nil if the change deletes the task.
    func applying(_ change: PendingChange, clientName: String) -> TodoTask? {
        var task = self
        switch change.kind {
        case .capture, .restore:
            break
        case .update(_, _, _, let patch):
            task = patch.applied(to: task)
        case .complete:
            task.status = .done
        case .delete:
            return nil
        case .comment(_, let text):
            task.activity?.append(ActivityEntry(at: change.createdAt, by: "me", kind: .comment, text: text, via: clientName))
            if task.comments != nil || task.activity == nil { task.comments = (task.comments ?? 0) + 1 }
        case .addSubtask(_, let title, let localID):
            task.subtasks.append(Subtask(id: localID, title: title, done: false))
        case .setSubtask(_, let subtask, let done):
            if let index = task.subtasks.firstIndex(where: { $0.id == subtask }) { task.subtasks[index].done = done }
        case .renameSubtask(_, let subtask, let title):
            if let index = task.subtasks.firstIndex(where: { $0.id == subtask }) { task.subtasks[index].title = title }
        case .removeSubtask(_, let subtask):
            task.subtasks.removeAll { $0.id == subtask }
        }
        return task
    }
}

extension [TodoTask] {
    /// The list as it should be shown: what the Mac last sent, with this iPhone's waiting
    /// changes on top. Changes that need attention (a conflict, a refusal) are left off,
    /// so the task shows the Mac's version until the user decides.
    public func applying(_ changes: [PendingChange], clientName: String = HubClient.defaultClientName) -> [TodoTask] {
        var byTask: [Int: [PendingChange]] = [:]
        for change in changes where change.isWaiting {
            if let id = change.taskID { byTask[id, default: []].append(change) }
        }
        guard !byTask.isEmpty else { return self }
        return compactMap { task in
            guard let mine = byTask[task.id] else { return task }
            var shown: TodoTask? = task
            for change in mine { shown = shown?.applying(change, clientName: clientName) }
            return shown
        }
    }
}

extension TodoTask {
    /// One task as it should be shown. Nil if a waiting change deletes it.
    public func applying(_ changes: [PendingChange], clientName: String = HubClient.defaultClientName) -> TodoTask? {
        [self].applying(changes, clientName: clientName).first
    }
}
