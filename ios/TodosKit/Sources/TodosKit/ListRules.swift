// Which tasks a list shows and in what order: the Todos app's rules (src/query.js on
// the Mac), in Swift. The Mac, the command-line client (cli/internal/query) and this
// all pass the same cases, test/fixtures/query-cases.json in the repository, so a
// change to a rule goes there first.
//
// A sort is a list of keys, each ascending or descending; as text, "due,-priority,created".
// A filter is a set of fields: values within a field are OR'ed, different fields AND'ed.

import Foundation

/// A sort or a filter the rules don't accept. The message is the Mac's own.
public struct ListRuleError: Error, Equatable, CustomStringConvertible {
    public var description: String
}

// MARK: - Sorting

/// An ordered list of keys, each ascending or descending.
public struct TaskSort: Sendable, Hashable, Codable, CustomStringConvertible {
    public enum Key: String, Sendable, Hashable, CaseIterable {
        /// The order every list had before sorting could be chosen: in progress, blocked,
        /// to do, then done. Open tasks by priority, then due date (undated last); done
        /// tasks by most recently finished.
        case `default`
        case status, priority, due, created, updated, completed, title, project, id
    }

    public struct Item: Sendable, Hashable {
        public var key: Key
        public var descending: Bool

        public init(_ key: Key, descending: Bool = false) {
            self.key = key
            self.descending = descending
        }
    }

    public var items: [Item]

    public init(_ items: [Item]) {
        self.items = items.isEmpty ? [Item(.default)] : items
    }

    /// The order lists have unless another is picked.
    public static let `default` = TaskSort([Item(.default)])
    /// The Today view's: most important first, then oldest first.
    public static let today = TaskSort([Item(.priority), Item(.due)])

    /// Reads "due,-priority". Nothing at all is the default order. A key that isn't one
    /// is refused, naming the ones there are.
    public init(_ text: String) throws {
        var items: [Item] = []
        for part in text.split(separator: ",", omittingEmptySubsequences: false) {
            let part = part.trimmingCharacters(in: .whitespaces).lowercased()
            if part.isEmpty { continue }
            let descending = part.hasPrefix("-")
            let name = descending ? String(part.dropFirst()).trimmingCharacters(in: .whitespaces) : part
            guard let key = Key(rawValue: name) else {
                throw ListRuleError(description: "Unknown sort key \"\(name)\". Sort by any of: \(Key.allCases.map(\.rawValue).joined(separator: ", ")). Separate keys with commas, and put - in front of one to reverse it, as in \"due,-priority\".")
            }
            if descending, key == .default {
                throw ListRuleError(description: "The default order can't be reversed. Name the keys to sort by instead, as in \"-due\".")
            }
            items.append(Item(key, descending: descending))
        }
        self.init(items)
    }

    /// The text form, as `init(_:)` reads it.
    public var description: String {
        items.map { ($0.descending ? "-" : "") + $0.key.rawValue }.joined(separator: ",")
    }

    public var isDefault: Bool { items == [Item(.default)] }

    // Kept as its text form, so a key added later reads back as an error rather than nonsense.
    public init(from decoder: Decoder) throws {
        try self.init(decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    /// Whether `a` goes before `b`. The id breaks every remaining tie, so the same tasks
    /// come out in the same order on every client.
    public func inOrder(_ a: TodoTask, _ b: TodoTask) -> Bool {
        for item in items {
            let order = item.key == .default ? Self.byDefault(a, b) : Self.compare(item.key, item.descending, a, b)
            if order != .orderedSame { return order == .orderedAscending }
        }
        return a.id < b.id
    }

    private static let statusRank: [TaskStatus: Int] = [.inProgress: 0, .blocked: 1, .todo: 2, .done: 3]
    private static let priorityRank: [TaskPriority: Int] = [.high: 0, .medium: 1, .low: 2] // so "priority" ascending is most important first

    private static func byDefault(_ a: TodoTask, _ b: TodoTask) -> ComparisonResult {
        let status = compare(.status, false, a, b)
        if status != .orderedSame { return status }
        if a.status == .done { return compare(.completed, true, a, b) }
        let priority = compare(.priority, false, a, b)
        return priority != .orderedSame ? priority : compare(.due, false, a, b)
    }

    /// One key. A task with nothing to compare goes last whichever way the key runs:
    /// undated tasks stay at the bottom of "due" and of "-due" alike.
    private static func compare(_ key: Key, _ descending: Bool, _ a: TodoTask, _ b: TodoTask) -> ComparisonResult {
        func values<T: Comparable>(_ x: T?, _ y: T?) -> ComparisonResult {
            switch (x, y) {
            case (nil, nil): return .orderedSame
            case (nil, _): return .orderedDescending
            case (_, nil): return .orderedAscending
            case let (x?, y?): return x == y ? .orderedSame : (x < y) != descending ? .orderedAscending : .orderedDescending
            }
        }
        // Titles and project names compare the way a reader expects: ignoring case, in
        // their own language's alphabetical order.
        func texts(_ x: String?, _ y: String?) -> ComparisonResult {
            switch (x, y) {
            case (nil, nil): return .orderedSame
            case (nil, _): return .orderedDescending
            case (_, nil): return .orderedAscending
            case let (x?, y?):
                let order = x.localizedCaseInsensitiveCompare(y)
                return descending && order != .orderedSame ? (order == .orderedAscending ? .orderedDescending : .orderedAscending) : order
            }
        }
        switch key {
        case .default, .id: return values(a.id, b.id)
        case .status: return values(statusRank[a.status], statusRank[b.status])
        case .priority: return values(priorityRank[a.priority], priorityRank[b.priority])
        case .due: return values(a.due, b.due)
        case .created: return values(a.createdAt, b.createdAt)
        case .updated: return values(a.updatedAt, b.updatedAt)
        case .completed: return values(a.completedAt, b.completedAt)
        case .title: return texts(a.title, b.title)
        case .project: return texts(a.project.flatMap { $0.isEmpty ? nil : $0 }, b.project.flatMap { $0.isEmpty ? nil : $0 })
        }
    }
}

extension [TodoTask] {
    /// The tasks in a sort's order.
    public func sorted(by sort: TaskSort) -> [TodoTask] {
        sorted(by: sort.inOrder)
    }
}

// MARK: - Filtering

/// A filter: values within a field are OR'ed, and different fields are AND'ed. A field
/// left nil doesn't narrow the list; an empty one matches nothing.
public struct ListFilter: Sendable, Hashable {
    /// Whether a task needs any of the tags, or every one of them.
    public enum TagMode: String, Sendable, Hashable, Codable, CaseIterable {
        case any, all
    }

    public var statuses: Set<TaskStatus>?
    public var priorities: Set<TaskPriority>?
    public var assignees: Set<TaskAssignee>?
    /// Lowercased project names. "" is no project.
    public var projects: Set<String>?
    public var tags: Set<String>?
    public var tagMode: TagMode
    /// overdue (open, and due before today), today, tomorrow, week (today through 7 days
    /// out), none, any, before:YYYY-MM-DD and after:YYYY-MM-DD (leaving that day out), or
    /// a bare date (due on or before it).
    public var due: String?
    /// Words that must all appear in the title, notes, project, tags or subtasks.
    public var words: [String]

    public static let dueValues = ["overdue", "today", "tomorrow", "week", "none", "any"]

    public init(statuses: Set<TaskStatus>? = nil, priorities: Set<TaskPriority>? = nil, assignees: Set<TaskAssignee>? = nil, projects: Set<String>? = nil,
                tags: Set<String>? = nil, tagMode: TagMode = .any, due: String? = nil, search: String = "") {
        self.statuses = statuses
        self.priorities = priorities
        self.assignees = assignees
        self.projects = projects.map { Set($0.map { $0.lowercased() }) }
        self.tags = tags.map { Set($0.map { $0.lowercased() }) }
        self.tagMode = tagMode
        self.due = due
        words = search.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// Reads a filter given as text, the way GET /api/v1/tasks takes it. A field that is
    /// missing, or empty, doesn't narrow the list, except project, where "" means no
    /// project. One that is given but names nothing (",") matches nothing.
    public init(text fields: [String: String]) throws {
        func given(_ name: String) -> String? {
            fields[name].flatMap { $0.isEmpty ? nil : $0 }
        }
        func values(_ text: String) -> [String] {
            text.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        }
        func oneOf<T>(_ field: String, _ text: String, _ allowed: [String], _ make: (String) -> [T]) throws -> [T] {
            try values(text).filter { !$0.isEmpty }.flatMap { value -> [T] in
                guard allowed.contains(value) else {
                    throw ListRuleError(description: "Invalid \(field) \"\(value)\". Expected one of: \(allowed.joined(separator: ", ")).")
                }
                return make(value)
            }
        }
        self.init()
        if let text = given("status") {
            statuses = Set(try oneOf("status", text, ["open", "all"] + TaskStatus.allCases.map(\.rawValue)) { value -> [TaskStatus] in
                switch value {
                case "all": TaskStatus.allCases
                case "open": TaskStatus.allCases.filter(\.isOpen)
                default: [TaskStatus(rawValue: value)!]
                }
            })
        }
        if let text = given("priority") {
            priorities = Set(try oneOf("priority", text, TaskPriority.allCases.map(\.rawValue)) { [TaskPriority(rawValue: $0)!] })
        }
        if let text = given("assignee") {
            assignees = Set(try oneOf("assignee", text, TaskAssignee.allCases.map(\.rawValue)) { [TaskAssignee(rawValue: $0)!] })
        }
        // A name with a comma in it still matches as a whole, as it did when this took one name.
        if let text = fields["project"] {
            projects = Set(values(text) + (text.contains(",") ? [text.trimmingCharacters(in: .whitespaces).lowercased()] : []))
        }
        if let text = given("tag") {
            tags = Set(values(text).map { $0.hasPrefix("#") || $0.hasPrefix("@") ? String($0.dropFirst()) : $0 }.filter { !$0.isEmpty })
        }
        if let text = given("tagMode") {
            guard let mode = TagMode(rawValue: text.trimmingCharacters(in: .whitespaces).lowercased()) else {
                throw ListRuleError(description: "Invalid tagMode \"\(text)\". Expected any or all.")
            }
            tagMode = mode
        }
        if let text = given("due") {
            let due = text.trimmingCharacters(in: .whitespaces).lowercased()
            let date = due.hasPrefix("before:") ? String(due.dropFirst(7)) : due.hasPrefix("after:") ? String(due.dropFirst(6)) : due
            guard Self.dueValues.contains(due) || date.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil else {
                throw ListRuleError(description: "Invalid due \"\(text)\". Expected overdue, today, tomorrow, week, none, any, before:YYYY-MM-DD, after:YYYY-MM-DD, or a date YYYY-MM-DD (due on or before it).")
            }
            self.due = due
        }
        if let text = given("q") {
            words = text.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        }
    }

    public func matches(_ task: TodoTask, today: Day) -> Bool {
        if let statuses, !statuses.contains(task.status) { return false }
        if let priorities, !priorities.contains(task.priority) { return false }
        if let assignees, !assignees.contains(task.assignee) { return false }
        if let projects, !projects.contains((task.project ?? "").lowercased()) { return false }
        if let tags {
            let has = { (tag: String) in task.tags.contains(tag) }
            if tagMode == .all ? !tags.allSatisfy(has) : !tags.contains(where: has) { return false }
        }
        if let due, !dueMatches(task, due, today) { return false }
        guard !words.isEmpty else { return true }
        let haystack = ([task.title, task.notes, task.project ?? ""] + task.tags + task.subtasks.map(\.title)).joined(separator: "\n").lowercased()
        return words.allSatisfy { haystack.contains($0) }
    }

    private func dueMatches(_ task: TodoTask, _ due: String, _ today: Day) -> Bool {
        switch due {
        case "overdue": return task.due.map { $0 < today } == true && task.status != .done
        case "today": return task.due == today
        case "tomorrow": return task.due == today.adding(days: 1)
        case "week": return task.due.map { $0 >= today && $0 <= today.adding(days: 7) } == true
        case "none": return task.due == nil
        case "any": return task.due != nil
        default:
            // As text, as the Mac compares them: "YYYY-MM-DD" sorts as the days do.
            guard let day = task.due?.description else { return false }
            if due.hasPrefix("before:") { return day < String(due.dropFirst(7)) }
            if due.hasPrefix("after:") { return day > String(due.dropFirst(6)) }
            return day <= due
        }
    }
}

// MARK: - The Today view

extension DueOverview {
    /// The Today view: overdue, then due today, each most important first and then oldest
    /// first. The same tasks as `dueNow`, which the widget shows, so its count is the one
    /// the Mac's Dock badge has too. Empty groups are left out.
    public var todaySections: [Section] {
        [(Kind.overdue, overdue), (.today, today)].compactMap { kind, tasks in
            tasks.isEmpty ? nil : Section(kind: kind, tasks: tasks.sorted(by: .today))
        }
    }
}
