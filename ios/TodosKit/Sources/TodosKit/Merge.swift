// What happens when the Mac refuses an edit because the task changed there first.
//
// The edit knows what its fields were before (base), what it set them to (mine),
// and the Mac says what the task is now (theirs). Field by field:
//   - theirs is still the base value: nobody else touched it, mine goes in.
//   - theirs already equals mine: nothing to do.
//   - tags: both sides' additions and removals are combined.
//   - anything else is a real conflict, and the user chooses.

import Foundation

extension TaskPatch {
    /// The fields of `task` as a patch: "set these fields to what this task has".
    public init(of task: TodoTask, fields: [TaskField]) {
        self.init()
        for field in fields {
            switch field {
            case .title: title = task.title
            case .notes: notes = task.notes
            case .status: status = task.status
            case .priority: priority = task.priority
            case .assignee: assignee = task.assignee
            case .tags: tags = task.tags
            case .due: due = Clearable(task.due)
            case .project: project = Clearable(task.project)
            case .repeats: repeats = Clearable(task.repeats)
            case .remindAt: remindAt = Clearable(task.remindAt)
            }
        }
    }

    /// Just these fields of the patch.
    public func only(_ wanted: [TaskField]) -> TaskPatch {
        var out = TaskPatch()
        for field in wanted {
            switch field {
            case .title: out.title = title
            case .notes: out.notes = notes
            case .status: out.status = status
            case .priority: out.priority = priority
            case .assignee: out.assignee = assignee
            case .tags: out.tags = tags
            case .due: out.due = due
            case .project: out.project = project
            case .repeats: out.repeats = repeats
            case .remindAt: out.remindAt = remindAt
            }
        }
        return out
    }

    /// The patch without these fields.
    public func without(_ unwanted: [TaskField]) -> TaskPatch {
        only(fields.filter { !unwanted.contains($0) })
    }

    /// This patch with another's fields added; where both set a field, `other` wins.
    public func merging(_ other: TaskPatch) -> TaskPatch {
        var out = self
        if let v = other.title { out.title = v }
        if let v = other.notes { out.notes = v }
        if let v = other.status { out.status = v }
        if let v = other.priority { out.priority = v }
        if let v = other.assignee { out.assignee = v }
        if let v = other.tags { out.tags = v }
        if let v = other.due { out.due = v }
        if let v = other.project { out.project = v }
        if let v = other.repeats { out.repeats = v }
        if let v = other.remindAt { out.remindAt = v }
        return out
    }
}

public struct MergeResult: Sendable, Equatable {
    /// What can go to the Mac now, on top of its current task. May be empty.
    public var apply: TaskPatch
    /// Fields where the Mac's change and mine disagree. The user has to choose.
    public var conflicts: [TaskField]

    public var isClean: Bool { conflicts.isEmpty }
}

public enum ThreeWayMerge {
    /// Merges an edit with the Mac's current task.
    /// - Parameters:
    ///   - base: the edited fields as they were before the edit.
    ///   - mine: the edit.
    ///   - theirs: the task as the Mac has it now.
    public static func merge(base: TaskPatch, mine: TaskPatch, theirs: TodoTask) -> MergeResult {
        var apply = TaskPatch()
        var conflicts: [TaskField] = []
        for field in mine.fields {
            let before = base.only([field])
            let wanted = mine.only([field])
            let now = TaskPatch(of: theirs, fields: [field])
            if now == wanted {
                continue // the Mac already has it
            } else if now == before {
                apply = apply.merging(wanted) // untouched on the Mac
            } else if field == .tags {
                let combined = tags(base: base.tags ?? [], mine: mine.tags ?? [], theirs: theirs.tags)
                if combined != theirs.tags { apply.tags = combined }
            } else {
                conflicts.append(field)
            }
        }
        return MergeResult(apply: apply, conflicts: conflicts)
    }

    /// Tags are a set, so two edits combine: the Mac's tags, plus the ones I added, minus the ones I removed.
    static func tags(base: [String], mine: [String], theirs: [String]) -> [String] {
        let added = mine.filter { !base.contains($0) }
        let removed = base.filter { !mine.contains($0) }
        return theirs.filter { !removed.contains($0) } + added.filter { !theirs.contains($0) }
    }
}
