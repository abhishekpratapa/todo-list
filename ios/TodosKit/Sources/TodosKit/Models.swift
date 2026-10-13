// The task model, as the Todos app on the Mac sends it (docs/openapi.json).

import Foundation

public enum TaskStatus: String, Codable, Sendable, CaseIterable, Hashable {
    case todo
    case inProgress = "in_progress"
    case blocked
    case done

    public var label: String {
        switch self {
        case .todo: "To do"
        case .inProgress: "In progress"
        case .blocked: "Blocked"
        case .done: "Done"
        }
    }

    public var isOpen: Bool { self != .done }
}

public enum TaskPriority: String, Codable, Sendable, CaseIterable, Hashable {
    case high, medium, low

    public var label: String { rawValue.capitalized }
}

public enum TaskAssignee: String, Codable, Sendable, CaseIterable, Hashable {
    case me, claude

    public var label: String { self == .me ? "Me" : "Claude" }
}

public enum TaskRepeat: String, Codable, Sendable, CaseIterable, Hashable {
    case daily, weekdays, weekly, biweekly, monthly, yearly

    public var label: String {
        switch self {
        case .daily: "Daily"
        case .weekdays: "Every weekday"
        case .weekly: "Weekly"
        case .biweekly: "Every 2 weeks"
        case .monthly: "Monthly"
        case .yearly: "Yearly"
        }
    }
}

public struct Subtask: Codable, Sendable, Hashable, Identifiable {
    public var id: Int
    public var title: String
    public var done: Bool

    public init(id: Int, title: String, done: Bool) {
        self.id = id
        self.title = title
        self.done = done
    }
}

/// One line of a task's history: a change ("event") or a comment.
public struct ActivityEntry: Codable, Sendable, Hashable {
    public enum Kind: String, Codable, Sendable {
        case event, comment
    }

    public var at: Date
    /// "me", or the Claude session that did it, e.g. "Claude Code · my-repo".
    public var by: String
    public var kind: Kind
    public var text: String
    /// The device or client, when the change did not come from the Mac app itself.
    public var via: String?

    public init(at: Date, by: String, kind: Kind, text: String, via: String? = nil) {
        self.at = at
        self.by = by
        self.kind = kind
        self.text = text
        self.via = via
    }

    /// "You", "You · iPhone", "Claude Code · my-repo".
    public var author: String {
        let who = by == "me" ? "You" : by
        return via.map { "\(who) · \($0)" } ?? who
    }
}

/// A task. Named TodoTask because Swift's own `Task` is taken.
public struct TodoTask: Codable, Sendable, Hashable, Identifiable {
    public var id: Int
    /// Goes up by one with every change to the task, whoever makes it.
    public var rev: Int
    public var title: String
    /// Markdown.
    public var notes: String
    public var status: TaskStatus
    public var priority: TaskPriority
    public var due: Day?
    public var project: String?
    public var tags: [String]
    public var assignee: TaskAssignee
    public var subtasks: [Subtask]
    public var repeats: TaskRepeat?
    public var remindAt: Date?
    public var remindedAt: Date?
    public var createdBy: String
    public var createdAt: Date
    public var updatedAt: Date
    public var completedAt: Date?
    /// The history. Lists leave it out and send `comments` instead.
    public var activity: [ActivityEntry]?
    /// How many comments there are. Only in lists.
    public var comments: Int?

    enum CodingKeys: String, CodingKey {
        case id, rev, title, notes, status, priority, due, project, tags, assignee, subtasks
        case repeats = "repeat"
        case remindAt, remindedAt, createdBy, createdAt, updatedAt, completedAt, activity, comments
    }

    public init(
        id: Int, rev: Int = 1, title: String, notes: String = "", status: TaskStatus = .todo, priority: TaskPriority = .medium,
        due: Day? = nil, project: String? = nil, tags: [String] = [], assignee: TaskAssignee = .me, subtasks: [Subtask] = [],
        repeats: TaskRepeat? = nil, remindAt: Date? = nil, remindedAt: Date? = nil, createdBy: String = "me",
        createdAt: Date = Date(timeIntervalSince1970: 0), updatedAt: Date = Date(timeIntervalSince1970: 0), completedAt: Date? = nil,
        activity: [ActivityEntry]? = nil, comments: Int? = nil
    ) {
        self.id = id
        self.rev = rev
        self.title = title
        self.notes = notes
        self.status = status
        self.priority = priority
        self.due = due
        self.project = project
        self.tags = tags
        self.assignee = assignee
        self.subtasks = subtasks
        self.repeats = repeats
        self.remindAt = remindAt
        self.remindedAt = remindedAt
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.activity = activity
        self.comments = comments
    }

    public var commentCount: Int {
        activity?.filter { $0.kind == .comment }.count ?? comments ?? 0
    }

    public var subtasksDone: Int { subtasks.filter(\.done).count }

    public func isOverdue(on today: Day) -> Bool {
        guard let due, status.isOpen else { return false }
        return due < today
    }

    public func isDueToday(_ today: Day) -> Bool {
        status.isOpen && due == today
    }
}

/// The counts on the Mac dashboard's tiles.
public struct Counts: Codable, Sendable, Equatable {
    public var open: Int
    public var inProgress: Int
    public var blocked: Int
    public var overdue: Int
    public var dueToday: Int
    public var claude: Int
    public var doneThisWeek: Int

    enum CodingKeys: String, CodingKey {
        case open, blocked, overdue, claude
        case inProgress = "in_progress"
        case dueToday = "due_today"
        case doneThisWeek = "done_7d"
    }

    public init(open: Int, inProgress: Int, blocked: Int, overdue: Int, dueToday: Int, claude: Int, doneThisWeek: Int) {
        self.open = open
        self.inProgress = inProgress
        self.blocked = blocked
        self.overdue = overdue
        self.dueToday = dueToday
        self.claude = claude
        self.doneThisWeek = doneThisWeek
    }
}

/// How the Mac read a line of quick capture: the title, and only the fields the line set.
public struct ParsedCapture: Codable, Sendable, Equatable {
    public struct Fields: Codable, Sendable, Equatable {
        public var due: Day?
        public var priority: TaskPriority?
        public var project: String?
        public var tags: [String]?
        public var assignee: TaskAssignee?
        public var repeats: TaskRepeat?
        public var remindAt: Date?

        enum CodingKeys: String, CodingKey {
            case due, priority, project, tags, assignee, remindAt
            case repeats = "repeat"
        }
    }

    public var title: String
    public var fields: Fields
}
