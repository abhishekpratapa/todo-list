// One task in the list.

import SwiftUI
import TodosKit

struct TaskRow: View {
    @Environment(AppModel.self) private var model
    var task: TodoTask

    var body: some View {
        let today = Day.today()
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button {
                Task {
                    if task.status == .done { await model.update(task.id, TaskPatch(status: .todo)) } else { await model.complete(task.id) }
                }
            } label: {
                Image(systemName: task.status.symbol)
                    .font(.title3)
                    .foregroundStyle(task.status.tint)
            }
            .buttonStyle(.borderless)
            .accessibilityHidden(true) // VoiceOver gets "Done" as an action on the row instead

            VStack(alignment: .leading, spacing: 4) {
                Text(task.title)
                    .font(.body)
                    .strikethrough(task.status == .done)
                    .foregroundStyle(task.status == .done ? .secondary : .primary)
                if let details = details(today) {
                    details
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if task.priority == .high, task.status.isOpen {
                Image(systemName: "exclamationmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.red)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TaskSpeech.summary(task, today: today))
    }

    /// The small print under the title, as one piece of text so it wraps at large type sizes.
    private func details(_ today: Day) -> Text? {
        var parts: [Text] = []
        if let due = task.due {
            let text = Text("\(Image(systemName: "calendar")) \(due.label(relativeTo: today))")
            parts.append(task.isOverdue(on: today) ? text.foregroundStyle(.red) : text)
        }
        if task.remindAt != nil, task.remindedAt == nil, task.status.isOpen { parts.append(Text(Image(systemName: "bell"))) }
        if task.repeats != nil { parts.append(Text(Image(systemName: "repeat"))) }
        if let project = task.project { parts.append(Text("#\(project)")) }
        if !task.subtasks.isEmpty { parts.append(Text("\(Image(systemName: "checklist")) \(task.subtasksDone)/\(task.subtasks.count)")) }
        if task.commentCount > 0 { parts.append(Text("\(Image(systemName: "bubble")) \(task.commentCount)")) }
        if task.assignee == .claude { parts.append(Text("\(Image(systemName: "sparkles")) Claude").foregroundStyle(Color.accentColor)) }
        guard var line = parts.first else { return nil }
        for part in parts.dropFirst() { line = Text("\(line)  ·  \(part)") }
        return line
    }
}

enum TaskSpeech {
    /// What VoiceOver reads for a task in the list.
    static func summary(_ task: TodoTask, today: Day) -> String {
        var parts = [task.title, task.status.label]
        if task.priority != .medium { parts.append("\(task.priority.label) priority") }
        if let due = task.due {
            parts.append((task.isOverdue(on: today) ? "overdue, was due " : "due ") + due.label(relativeTo: today))
        }
        if let project = task.project { parts.append("project \(project)") }
        if !task.subtasks.isEmpty { parts.append("\(task.subtasksDone) of \(task.subtasks.count) subtasks done") }
        if task.commentCount > 0 { parts.append(task.commentCount == 1 ? "1 comment" : "\(task.commentCount) comments") }
        if task.repeats != nil { parts.append("repeats") }
        if task.assignee == .claude { parts.append("assigned to Claude") }
        return parts.joined(separator: ", ")
    }
}
