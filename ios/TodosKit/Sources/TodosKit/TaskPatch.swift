// A set of edits to a task: only the fields that change. Encodes to the body of
// PATCH /tasks/{id}, where a missing field means "leave alone" and null means "clear".

import Foundation

/// A new value for a field that can also be emptied.
public enum Clearable<Value: Sendable & Equatable>: Sendable, Equatable {
    case clear
    case set(Value)

    public init(_ value: Value?) {
        self = value.map(Clearable.set) ?? .clear
    }

    public var value: Value? {
        if case .set(let value) = self { return value }
        return nil
    }
}

/// The fields of a task that can be edited.
public enum TaskField: String, Sendable, CaseIterable, Codable {
    case title, notes, status, priority, assignee, tags, due, project
    case repeats = "repeat"
    case remindAt

    public var label: String {
        switch self {
        case .title: "Title"
        case .notes: "Notes"
        case .status: "Status"
        case .priority: "Priority"
        case .assignee: "Assignee"
        case .tags: "Tags"
        case .due: "Due date"
        case .project: "Project"
        case .repeats: "Repeat"
        case .remindAt: "Reminder"
        }
    }
}

public struct TaskPatch: Sendable, Equatable {
    public var title: String?
    public var notes: String?
    public var status: TaskStatus?
    public var priority: TaskPriority?
    public var assignee: TaskAssignee?
    public var tags: [String]?
    public var due: Clearable<Day>?
    public var project: Clearable<String>?
    public var repeats: Clearable<TaskRepeat>?
    public var remindAt: Clearable<Date>?

    public init(
        title: String? = nil, notes: String? = nil, status: TaskStatus? = nil, priority: TaskPriority? = nil,
        assignee: TaskAssignee? = nil, tags: [String]? = nil, due: Clearable<Day>? = nil, project: Clearable<String>? = nil,
        repeats: Clearable<TaskRepeat>? = nil, remindAt: Clearable<Date>? = nil
    ) {
        self.title = title
        self.notes = notes
        self.status = status
        self.priority = priority
        self.assignee = assignee
        self.tags = tags
        self.due = due
        self.project = project
        self.repeats = repeats
        self.remindAt = remindAt
    }

    /// The edits that turn `old` into `new`. Fields that are equal are left out.
    public init(from old: TodoTask, to new: TodoTask) {
        if new.title != old.title { title = new.title }
        if new.notes != old.notes { notes = new.notes }
        if new.status != old.status { status = new.status }
        if new.priority != old.priority { priority = new.priority }
        if new.assignee != old.assignee { assignee = new.assignee }
        if new.tags != old.tags { tags = new.tags }
        if new.due != old.due { due = Clearable(new.due) }
        if new.project != old.project { project = Clearable(new.project) }
        if new.repeats != old.repeats { repeats = Clearable(new.repeats) }
        if new.remindAt != old.remindAt { remindAt = Clearable(new.remindAt) }
    }

    public var fields: [TaskField] {
        var out: [TaskField] = []
        if title != nil { out.append(.title) }
        if notes != nil { out.append(.notes) }
        if status != nil { out.append(.status) }
        if priority != nil { out.append(.priority) }
        if assignee != nil { out.append(.assignee) }
        if tags != nil { out.append(.tags) }
        if due != nil { out.append(.due) }
        if project != nil { out.append(.project) }
        if repeats != nil { out.append(.repeats) }
        if remindAt != nil { out.append(.remindAt) }
        return out
    }

    public var isEmpty: Bool { fields.isEmpty }

    /// The task as it will look once these edits are applied, for showing them straight away.
    /// `rev`, the history and the completion time are the Mac's to set and are left alone.
    public func applied(to task: TodoTask) -> TodoTask {
        var t = task
        if let title { t.title = title }
        if let notes { t.notes = notes }
        if let status { t.status = status }
        if let priority { t.priority = priority }
        if let assignee { t.assignee = assignee }
        if let tags { t.tags = tags }
        if let due { t.due = due.value }
        if let project { t.project = project.value }
        if let repeats { t.repeats = repeats.value }
        if let remindAt { t.remindAt = remindAt.value }
        return t
    }
}

extension TaskPatch: Codable {
    private typealias Key = TaskField

    private struct Keys: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ field: TaskField) { stringValue = field.rawValue }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(title, forKey: Keys(.title))
        try c.encodeIfPresent(notes, forKey: Keys(.notes))
        try c.encodeIfPresent(status, forKey: Keys(.status))
        try c.encodeIfPresent(priority, forKey: Keys(.priority))
        try c.encodeIfPresent(assignee, forKey: Keys(.assignee))
        try c.encodeIfPresent(tags, forKey: Keys(.tags))
        try Self.encode(due, .due, into: &c)
        try Self.encode(project, .project, into: &c)
        try Self.encode(repeats, .repeats, into: &c)
        try Self.encode(remindAt, .remindAt, into: &c)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        title = try c.decodeIfPresent(String.self, forKey: Keys(.title))
        notes = try c.decodeIfPresent(String.self, forKey: Keys(.notes))
        status = try c.decodeIfPresent(TaskStatus.self, forKey: Keys(.status))
        priority = try c.decodeIfPresent(TaskPriority.self, forKey: Keys(.priority))
        assignee = try c.decodeIfPresent(TaskAssignee.self, forKey: Keys(.assignee))
        tags = try c.decodeIfPresent([String].self, forKey: Keys(.tags))
        due = try Self.decode(Day.self, .due, from: c)
        project = try Self.decode(String.self, .project, from: c)
        repeats = try Self.decode(TaskRepeat.self, .repeats, from: c)
        remindAt = try Self.decode(Date.self, .remindAt, from: c)
    }

    private static func encode<V: Encodable>(_ value: Clearable<V>?, _ field: TaskField, into c: inout KeyedEncodingContainer<Keys>) throws {
        switch value {
        case nil: break
        case .clear: try c.encodeNil(forKey: Keys(field))
        case .set(let v): try c.encode(v, forKey: Keys(field))
        }
    }

    private static func decode<V: Decodable>(_ type: V.Type, _ field: TaskField, from c: KeyedDecodingContainer<Keys>) throws -> Clearable<V>? {
        let key = Keys(field)
        guard c.contains(key) else { return nil }
        return try c.decodeNil(forKey: key) ? .clear : .set(c.decode(V.self, forKey: key))
    }
}
