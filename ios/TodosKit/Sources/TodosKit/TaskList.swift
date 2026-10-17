// Turning the task list into what the phone shows: the Mac's four columns become
// sections, filtered and sorted by the same rules as everywhere else (ListRules.swift).

import Foundation

/// The segmented control at the top of the list.
public enum TaskFilter: String, Sendable, Codable, CaseIterable, Identifiable {
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

/// The narrower views the Mac's stat tiles offer. Several can be picked: a task in any of them shows.
public enum TaskFocus: String, Sendable, Codable, CaseIterable, Identifiable {
    case dueToday, overdue, withClaude

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .dueToday: "Due today"
        case .overdue: "Overdue"
        case .withClaude: "With Claude"
        }
    }

    /// The filter this view is, as the Mac's tile has it.
    public var rule: ListFilter {
        switch self {
        case .dueToday: ListFilter(statuses: Set(TaskStatus.allCases.filter(\.isOpen)), due: "today")
        case .overdue: ListFilter(due: "overdue")
        case .withClaude: ListFilter(assignees: [.claude])
        }
    }
}

/// What the list shows, and in what order. Kept on this iPhone between launches, all
/// but the search.
public struct TaskQuery: Sendable, Equatable, Codable {
    public var filter: TaskFilter
    public var focus: Set<TaskFocus>
    /// Project names as the menu shows them; "" is tasks with no project. Case doesn't matter.
    public var projects: Set<String>
    public var priorities: Set<TaskPriority>
    public var tags: Set<String>
    public var tagMode: ListFilter.TagMode
    /// Within each section: sections are the statuses already.
    public var sort: TaskSort
    public var search: String

    public init(filter: TaskFilter = .open, focus: Set<TaskFocus> = [], projects: Set<String> = [], priorities: Set<TaskPriority> = [],
                tags: Set<String> = [], tagMode: ListFilter.TagMode = .any, sort: TaskSort = .default, search: String = "") {
        self.filter = filter
        self.focus = focus
        self.projects = projects
        self.priorities = priorities
        self.tags = tags
        self.tagMode = tagMode
        self.sort = sort
        self.search = search
    }

    /// True when something beyond the status filter is narrowing the list.
    public var isNarrowed: Bool {
        !focus.isEmpty || isFiltered || !search.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// True when the Filter menu has narrowed the list: the views, projects, priorities or tags.
    public var isFiltered: Bool {
        !focus.isEmpty || !projects.isEmpty || !priorities.isEmpty || !tags.isEmpty
    }

    /// The projects, priorities, tags and search, as the app's rules have them (see ListFilter).
    public var rule: ListFilter {
        ListFilter(priorities: priorities.isEmpty ? nil : priorities, projects: projects.isEmpty ? nil : projects,
                   tags: tags.isEmpty ? nil : tags, tagMode: tagMode, search: search)
    }

    public func matches(_ task: TodoTask, today: Day) -> Bool {
        guard filter.statuses.contains(task.status) else { return false }
        guard focus.isEmpty || focus.contains(where: { $0.rule.matches(task, today: today) }) else { return false }
        return rule.matches(task, today: today)
    }

    // What is kept between launches. Each field is read on its own, so one that can't be
    // read any more (a sort key this version doesn't know) leaves the rest as they were.
    enum CodingKeys: String, CodingKey {
        case filter, focus, projects, priorities, tags, tagMode, sort
    }

    public init(from decoder: Decoder) throws {
        let saved = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        filter = (try? saved.decode(TaskFilter.self, forKey: .filter)) ?? filter
        focus = (try? saved.decode(Set<TaskFocus>.self, forKey: .focus)) ?? focus
        projects = (try? saved.decode(Set<String>.self, forKey: .projects)) ?? projects
        priorities = (try? saved.decode(Set<TaskPriority>.self, forKey: .priorities)) ?? priorities
        tags = (try? saved.decode(Set<String>.self, forKey: .tags)) ?? tags
        tagMode = (try? saved.decode(ListFilter.TagMode.self, forKey: .tagMode)) ?? tagMode
        sort = (try? saved.decode(TaskSort.self, forKey: .sort)) ?? sort
    }

    public func encode(to encoder: Encoder) throws {
        var saved = encoder.container(keyedBy: CodingKeys.self)
        try saved.encode(filter, forKey: .filter)
        try saved.encode(focus.map(\.rawValue).sorted(), forKey: .focus)
        try saved.encode(projects.sorted(), forKey: .projects)
        try saved.encode(priorities.map(\.rawValue).sorted(), forKey: .priorities)
        try saved.encode(tags.sorted(), forKey: .tags)
        try saved.encode(tagMode, forKey: .tagMode)
        try saved.encode(sort, forKey: .sort)
    }
}

public struct TaskSection: Sendable, Equatable, Identifiable {
    public var status: TaskStatus
    public var tasks: [TodoTask]

    public var id: TaskStatus { status }
}

extension [TodoTask] {
    /// The Mac's usual order: in progress, blocked, to do, then done. Open tasks go by
    /// priority, then due date (undated last); done tasks by most recently finished.
    public func inListOrder() -> [TodoTask] {
        sorted(by: .default)
    }

    /// The sections to show for a query, each in the query's order. Empty sections are left out.
    public func sections(for query: TaskQuery, today: Day) -> [TaskSection] {
        let matching = filter { query.matches($0, today: today) }.sorted(by: query.sort)
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

    /// Tags in use, for the filter menu.
    public var tags: [String] {
        Set(flatMap(\.tags)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
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

// MARK: - What is due (for the widget)

extension TodoTask {
    /// The small print under a task's title, where the widget has room for it: where
    /// the task stands if it is under way or stuck, whether Claude has it, its project,
    /// and how far its checklist has got. Empty when there is nothing to add to the title.
    public var widgetDetail: String {
        var parts: [String] = []
        if status == .inProgress || status == .blocked { parts.append(status.label) }
        if assignee == .claude { parts.append("With Claude") }
        if let project, !project.isEmpty { parts.append("#\(project)") }
        if !subtasks.isEmpty { parts.append("\(subtasks.filter(\.done).count)/\(subtasks.count)") }
        return parts.joined(separator: " · ")
    }
}

/// The open tasks by how soon they are due: overdue, today, the days after, and the rest.
/// This is what the widget shows.
public struct DueOverview: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable, Hashable, Codable {
        case overdue, today, upcoming, later

        public var label: String {
            switch self {
            case .overdue: "Overdue"
            case .today: "Today"
            case .upcoming: "Coming up"
            case .later: "Also open"
            }
        }
    }

    public struct Section: Sendable, Equatable, Identifiable {
        public var kind: Kind
        public var tasks: [TodoTask]

        public var id: Kind { kind }
    }

    public var overdue: [TodoTask]
    public var today: [TodoTask]
    /// Due after today and within `upcomingDays`, soonest first.
    public var upcoming: [TodoTask]
    /// Every other open task: no date, or due further off. In the list's order.
    public var later: [TodoTask]

    public init(overdue: [TodoTask] = [], today: [TodoTask] = [], upcoming: [TodoTask] = [], later: [TodoTask] = []) {
        self.overdue = overdue
        self.today = today
        self.upcoming = upcoming
        self.later = later
    }

    public init(tasks: [TodoTask], on day: Day, calendar: Calendar = .current, upcomingDays: Int = 7) {
        let open = tasks.inListOrder().filter(\.status.isOpen)
        overdue = open.filter { $0.isOverdue(on: day) }.sorted { ($0.due ?? day) < ($1.due ?? day) }
        today = open.filter { $0.isDueToday(day) }
        upcoming = open
            .filter { task in task.due.map { $0 > day && $0.days(since: day, calendar: calendar) <= upcomingDays } ?? false }
            .sorted { ($0.due ?? day) < ($1.due ?? day) } // a stable sort: within a day, the list's own order
        let dated = Set((overdue + today + upcoming).map(\.id))
        later = open.filter { !dated.contains($0.id) }
    }

    /// Overdue and due today together: what needs doing now.
    public var dueNow: [TodoTask] { overdue + today }

    /// How many open tasks there are in all.
    public var count: Int { overdue.count + today.count + upcoming.count + later.count }

    /// "2 due today · 1 overdue"
    public var summary: String {
        var parts: [String] = []
        if !today.isEmpty { parts.append("\(today.count) due today") }
        if !overdue.isEmpty { parts.append("\(overdue.count) overdue") }
        return parts.isEmpty ? "Nothing due today" : parts.joined(separator: " · ")
    }

    /// The sections to draw in a space with room for `rows` lines, where each section's
    /// heading takes a line too. Overdue comes first, then today, then what is coming up,
    /// then the rest. `hidden` is how many tasks did not fit.
    public func sections(fitting rows: Int) -> (sections: [Section], hidden: Int) {
        var left = rows
        var out: [Section] = []
        for (kind, tasks) in [(Kind.overdue, overdue), (.today, today), (.upcoming, upcoming), (.later, later)] where !tasks.isEmpty {
            guard left >= 2 else { break } // a heading with nothing under it is worse than no heading
            let shown = Array(tasks.prefix(left - 1))
            out.append(Section(kind: kind, tasks: shown))
            left -= shown.count + 1
        }
        return (out, count - out.reduce(0) { $0 + $1.tasks.count })
    }
}
