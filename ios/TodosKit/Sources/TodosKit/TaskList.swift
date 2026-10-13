// Turning the task list into what the phone shows: the Mac's four columns become
// sections, with a filter and search.

import Foundation

/// The segmented control at the top of the list.
public enum TaskFilter: String, Sendable, CaseIterable, Identifiable {
    case open, todo, inProgress, blocked, done

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .open: "Open"
        case .todo: "To do"
        case .inProgress: "Doing"
        case .blocked: "Blocked"
        case .done: "Done"
        }
    }

    /// The statuses shown, in the order their sections appear: what is under way first.
    public var statuses: [TaskStatus] {
        switch self {
        case .open: [.inProgress, .blocked, .todo]
        case .todo: [.todo]
        case .inProgress: [.inProgress]
        case .blocked: [.blocked]
        case .done: [.done]
        }
    }
}

/// The narrower views the Mac's stat tiles offer.
public enum TaskFocus: String, Sendable, CaseIterable, Identifiable {
    case dueToday, overdue, withClaude

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .dueToday: "Due today"
        case .overdue: "Overdue"
        case .withClaude: "With Claude"
        }
    }
}

public struct TaskQuery: Sendable, Equatable {
    public var filter: TaskFilter
    public var focus: TaskFocus?
    public var project: String?
    public var search: String

    public init(filter: TaskFilter = .open, focus: TaskFocus? = nil, project: String? = nil, search: String = "") {
        self.filter = filter
        self.focus = focus
        self.project = project
        self.search = search
    }

    /// True when something beyond the status filter is narrowing the list.
    public var isNarrowed: Bool {
        focus != nil || project != nil || !search.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public func matches(_ task: TodoTask, today: Day) -> Bool {
        guard filter.statuses.contains(task.status) else { return false }
        switch focus {
        case .dueToday: guard task.isDueToday(today) else { return false }
        case .overdue: guard task.isOverdue(on: today) else { return false }
        case .withClaude: guard task.assignee == .claude else { return false }
        case nil: break
        }
        if let project, (task.project ?? "").caseInsensitiveCompare(project) != .orderedSame { return false }
        let words = search.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        // The same text the Mac searches: title, notes, project, tags and subtask titles.
        let haystack = ([task.title, task.notes, task.project ?? ""] + task.tags + task.subtasks.map(\.title)).joined(separator: "\n").lowercased()
        return words.allSatisfy { haystack.contains($0) }
    }
}

public struct TaskSection: Sendable, Equatable, Identifiable {
    public var status: TaskStatus
    public var tasks: [TodoTask]

    public var id: TaskStatus { status }
}

extension [TodoTask] {
    /// The Mac's order (store.js sortTodos): in progress, blocked, to do, then done.
    /// Open tasks go by priority, then due date (undated last), then age; done tasks by most recently finished.
    public func inListOrder() -> [TodoTask] {
        let statusRank: [TaskStatus: Int] = [.inProgress: 0, .blocked: 1, .todo: 2, .done: 3]
        let priorityRank: [TaskPriority: Int] = [.high: 0, .medium: 1, .low: 2]
        return sorted { a, b in
            if a.status != b.status { return statusRank[a.status]! < statusRank[b.status]! }
            if a.status == .done {
                if a.completedAt != b.completedAt { return (a.completedAt ?? .distantPast) > (b.completedAt ?? .distantPast) }
                return a.id < b.id
            }
            if a.priority != b.priority { return priorityRank[a.priority]! < priorityRank[b.priority]! }
            if a.due != b.due {
                guard let x = a.due else { return false }
                guard let y = b.due else { return true }
                return x < y
            }
            return a.id < b.id
        }
    }

    /// The sections to show for a query. Empty sections are left out.
    public func sections(for query: TaskQuery, today: Day) -> [TaskSection] {
        let matching = filter { query.matches($0, today: today) }.inListOrder()
        return query.filter.statuses.compactMap { status in
            let tasks = matching.filter { $0.status == status }
            return tasks.isEmpty ? nil : TaskSection(status: status, tasks: tasks)
        }
    }

    /// Project names in use, for the filter menu.
    public var projects: [String] {
        var seen = Set<String>()
        return compactMap(\.project)
            .filter { seen.insert($0.lowercased()).inserted }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// The same counts as the Mac's tiles, worked out from the tasks on hand.
    public func counts(today: Day, now: Date = Date()) -> Counts {
        let open = filter(\.status.isOpen)
        let weekAgo = now.addingTimeInterval(-7 * 86_400)
        return Counts(
            open: open.count,
            inProgress: open.filter { $0.status == .inProgress }.count,
            blocked: open.filter { $0.status == .blocked }.count,
            overdue: open.filter { $0.isOverdue(on: today) }.count,
            dueToday: open.filter { $0.isDueToday(today) }.count,
            claude: open.filter { $0.assignee == .claude }.count,
            doneThisWeek: filter { $0.status == .done && ($0.completedAt ?? .distantPast) >= weekAgo }.count
        )
    }
}
