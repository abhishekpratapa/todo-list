// What this iPhone still owes the Mac: changes waiting to be sent, and changes that
// can't go further until the user decides (a conflict, a task deleted on the Mac,
// something the Mac refused). Nothing leaves this screen without a choice being made.

import SwiftUI
import TodosKit

struct SyncView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var sending = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Status", value: SyncText.status(model))
                    if let issue = model.issue {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(issue.title).font(.subheadline.weight(.semibold))
                            Text("\(issue.explanation) \(issue.action)").font(.footnote).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                if !model.needingAttention.isEmpty {
                    Section {
                        ForEach(model.needingAttention) { AttentionRow(change: $0) }
                    } header: {
                        Text("Needs your decision")
                    } footer: {
                        Text("Later changes to the same task wait until you decide.")
                    }
                }

                if !model.waiting.isEmpty {
                    Section {
                        ForEach(model.waiting) { change in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(change.summary)
                                if let title = model.title(for: change) {
                                    Text(title).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { Task { await model.discard(change) } } label: { Label("Discard", systemImage: "trash") }
                            }
                        }
                    } header: {
                        Text("Waiting to be sent · \(model.waiting.count)")
                    } footer: {
                        Text("Saved on this iPhone. They are sent in this order as soon as your Mac can be reached.")
                    }
                }

                if model.changes.isEmpty {
                    Section {
                        Label("Everything you’ve done here is on your Mac.", systemImage: "checkmark.circle")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task {
                            sending = true
                            await model.retry()
                            sending = false
                        }
                    } label: {
                        if sending || model.isSending { ProgressView() } else { Text("Sync Now") }
                    }
                    .disabled(sending || model.isSending)
                }
            }
            .navigationDestination(for: PendingChange.ID.self) { id in
                if let change = model.changes.first(where: { $0.id == id }), case .conflict(let theirs) = change.state, case .update(_, _, _, let mine) = change.kind {
                    EditConflictView(change: change, mine: mine, theirs: theirs)
                } else {
                    ContentUnavailableView("Already Settled", systemImage: "checkmark.circle")
                }
            }
        }
    }
}

/// One change that needs a decision, with the choices for its situation.
private struct AttentionRow: View {
    @Environment(AppModel.self) private var model
    var change: PendingChange

    var body: some View {
        switch (change.state, change.kind) {
        case (.conflict(let theirs), .update(_, _, _, let mine)):
            NavigationLink(value: change.id) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(theirs.title).font(.subheadline.weight(.semibold))
                    Text("\(ConflictText.who(theirs)) changed the \(ConflictText.fields(mine)) while your change was waiting.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("Choose which to keep").font(.footnote).foregroundStyle(Color.accentColor)
                }
            }

        case (.conflict(let theirs), _):
            VStack(alignment: .leading, spacing: 8) {
                Text(theirs.title).font(.subheadline.weight(.semibold))
                Text("You deleted this task, but \(ConflictText.who(theirs).lowercasedFirst) changed it on your Mac in the meantime.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Delete Anyway", role: .destructive) { Task { await model.resolveDelete(change, deleteAnyway: true) } }
                    Spacer()
                    Button("Keep It") { Task { await model.resolveDelete(change, deleteAnyway: false) } }
                }
                .buttonStyle(.bordered)
            }
            .padding(.vertical, 2)

        case (.taskDeleted(let last), _):
            VStack(alignment: .leading, spacing: 8) {
                Text(last?.title ?? "A task").font(.subheadline.weight(.semibold))
                Text("This task was deleted on your Mac. Your change is still here: \(change.summary.lowercasedFirst).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if case .comment(_, let text) = change.kind {
                    Text(text).font(.footnote).textSelection(.enabled)
                }
                HStack {
                    if last != nil, change.capturedLine == nil, !change.isComment {
                        Button("Put the Task Back") { Task { await model.restoreTask(for: change) } }
                        Spacer()
                    }
                    Button("Discard My Change", role: .destructive) { Task { await model.discard(change) } }
                }
                .buttonStyle(.bordered)
            }
            .padding(.vertical, 2)

        case (.rejected(let message), _):
            VStack(alignment: .leading, spacing: 8) {
                Text(change.summary).font(.subheadline.weight(.semibold))
                Text("Your Mac refused this: \(message)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Try Again") { Task { await model.tryAgain(change) } }
                    Spacer()
                    Button("Discard", role: .destructive) { Task { await model.discard(change) } }
                }
                .buttonStyle(.bordered)
            }
            .padding(.vertical, 2)

        case (.waiting, _):
            EmptyView()
        }
    }
}

/// Both versions of each field the Mac and I changed differently, and a choice for each.
struct EditConflictView: View {
    enum Choice: Hashable {
        case mine, theirs, both
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var change: PendingChange
    var mine: TaskPatch
    var theirs: TodoTask
    @State private var choices: [TaskField: Choice] = [:]

    private var theirValues: TaskPatch { TaskPatch(of: theirs, fields: mine.fields) }

    var body: some View {
        Form {
            Section {
                Text("\(ConflictText.who(theirs)) changed this task on your Mac while your change was waiting. Nothing has been overwritten. Choose what to keep for each part.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(mine.fields, id: \.self) { field in
                Section(field.label) {
                    choice(field, .mine, "Yours", FieldText.value(field, in: mine))
                    choice(field, .theirs, "On your Mac", FieldText.value(field, in: theirValues))
                    if field == .notes {
                        choice(field, .both, "Both", "The Mac’s notes, then yours below them")
                    }
                }
            }
        }
        .navigationTitle(theirs.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Apply") {
                    Task {
                        await model.resolveEdit(change, keeping: ConflictText.resolved(mine: mine, theirs: theirs, choices: choices))
                        dismiss()
                    }
                }
                .disabled(choices.count < mine.fields.count)
            }
        }
    }

    private func choice(_ field: TaskField, _ value: Choice, _ label: String, _ text: String) -> some View {
        Button {
            choices[field] = value
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    // Explicit colours: inside a button, "secondary" would be a shade of the tint.
                    Text(label).font(.footnote.weight(.semibold)).foregroundStyle(Color.secondary)
                    Text(verbatim: text).foregroundStyle(Color.primary).multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: choices[field] == value ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(choices[field] == value ? Color.accentColor : Color.secondary)
            }
        }
        .accessibilityLabel("\(label): \(text)")
        .accessibilityAddTraits(choices[field] == value ? .isSelected : [])
    }
}

enum ConflictText {
    /// Who last changed the task on the Mac: "You", "Claude Code · repo", or "Someone" if the history isn't known.
    static func who(_ theirs: TodoTask) -> String {
        // The latest change that wasn't this iPhone's own (part of my edit may already have gone through).
        guard let last = theirs.activity?.last(where: { !($0.by == "me" && $0.via == HubClient.defaultClientName) }) else { return "Someone" }
        return last.by == "me" ? "You, on another device," : last.author
    }

    /// "title", "title and due date".
    static func fields(_ patch: TaskPatch) -> String {
        patch.fields.map { $0.label.lowercased() }.formatted(.list(type: .and))
    }

    /// What to send after the choices: the fields where mine was chosen, as they were;
    /// notes where both were chosen, as the Mac's followed by mine. Fields left to the Mac are not sent.
    static func resolved(mine: TaskPatch, theirs: TodoTask, choices: [TaskField: EditConflictView.Choice]) -> TaskPatch {
        var out = mine.only(mine.fields.filter { choices[$0] == .mine })
        if choices[.notes] == .both, let notes = mine.notes {
            out.notes = [theirs.notes, notes].filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        return out
    }
}

enum FieldText {
    /// A field's value in words, for showing two versions side by side.
    static func value(_ field: TaskField, in patch: TaskPatch) -> String {
        let none = "None"
        switch field {
        case .title: return patch.title ?? none
        case .notes: return patch.notes.flatMap { $0.isEmpty ? nil : $0 } ?? "No notes"
        case .status: return patch.status?.label ?? none
        case .priority: return patch.priority?.label ?? none
        case .assignee: return patch.assignee?.label ?? none
        case .tags: return patch.tags.flatMap { $0.isEmpty ? nil : $0.joined(separator: ", ") } ?? "No tags"
        case .due: return patch.due?.value.map { $0.date().formatted(date: .abbreviated, time: .omitted) } ?? "No due date"
        case .project: return patch.project?.value ?? "No project"
        case .repeats: return patch.repeats?.value?.label ?? "Never"
        case .remindAt: return patch.remindAt?.value.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "No reminder"
        }
    }
}

extension PendingChange {
    var isComment: Bool {
        if case .comment = kind { return true }
        return false
    }
}

extension String {
    /// "Edit the title" to "edit the title", for use mid-sentence.
    var lowercasedFirst: String {
        prefix(1).lowercased() + dropFirst()
    }
}
