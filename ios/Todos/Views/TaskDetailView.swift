// One task: everything about it, and every way to change it. Each control saves as
// soon as it changes, like the drawer in the Mac app.

import SwiftUI
import TodosKit

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    var taskID: Int

    var body: some View {
        Group {
            if let task = model.task(taskID) {
                TaskDetailForm(task: task)
            } else {
                ContentUnavailableView("Task Not Found", systemImage: "questionmark.circle", description: Text("It may have been deleted on your Mac."))
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.open(taskID) }
        .onDisappear { model.close(taskID) }
    }
}

private struct TaskDetailForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var task: TodoTask

    @State private var editingNotes = false
    @State private var newSubtask = ""
    @State private var newComment = ""
    @State private var renaming: Subtask?
    @State private var renamedTitle = ""
    @State private var confirmingDelete = false
    @State private var showingHistory = false
    @FocusState private var commentFocused: Bool

    private func update(_ patch: TaskPatch) {
        Task { await model.update(task.id, patch) }
    }

    var body: some View {
        Form {
            Section {
                CommitField(prompt: "Title", value: task.title, axis: .vertical) { title in
                    if !title.isEmpty { update(TaskPatch(title: title)) }
                }
                .font(.title3.weight(.semibold))
                .accessibilityLabel("Title")

                Picker(selection: Binding(get: { task.status }, set: { update(TaskPatch(status: $0)) })) {
                    ForEach(TaskStatus.allCases, id: \.self) { Text($0.label).tag($0) }
                } label: {
                    Label("Status", systemImage: task.status.symbol)
                }
                Picker(selection: Binding(get: { task.priority }, set: { update(TaskPatch(priority: $0)) })) {
                    ForEach(TaskPriority.allCases, id: \.self) { Text($0.label).tag($0) }
                } label: {
                    Label("Priority", systemImage: "flag")
                }
                Picker(selection: Binding(get: { task.assignee }, set: { update(TaskPatch(assignee: $0)) })) {
                    ForEach(TaskAssignee.allCases, id: \.self) { Text($0.label).tag($0) }
                } label: {
                    Label("Assigned to", systemImage: "person")
                }
            }

            Section {
                OptionalDateRow(title: "Due Date", symbol: "calendar", date: task.due?.date(), components: .date, initial: { Date() }) { date in
                    update(TaskPatch(due: Clearable(date.map { Day($0) })))
                }
                OptionalDateRow(title: "Reminder", symbol: "bell", date: task.remindAt, components: [.date, .hourAndMinute], initial: { .tomorrowMorning }) { date in
                    update(TaskPatch(remindAt: Clearable(date)))
                }
                Picker(selection: Binding(get: { task.repeats }, set: { update(TaskPatch(repeats: Clearable($0))) })) {
                    Text("Never").tag(TaskRepeat?.none)
                    ForEach(TaskRepeat.allCases, id: \.self) { Text($0.label).tag(TaskRepeat?.some($0)) }
                } label: {
                    Label("Repeat", systemImage: "repeat")
                }
            } footer: {
                if task.remindAt != nil {
                    Text("Reminders appear on your Mac.")
                }
            }

            Section {
                LabeledContent {
                    CommitField(prompt: "None", value: task.project ?? "", autocapitalization: .never) { project in
                        update(TaskPatch(project: project.isEmpty ? .clear : .set(project)))
                    }
                    .multilineTextAlignment(.trailing)
                } label: {
                    Label("Project", systemImage: "number")
                }
                LabeledContent {
                    CommitField(prompt: "None", value: task.tags.joined(separator: ", "), autocapitalization: .never) { text in
                        update(TaskPatch(tags: TagText.tags(from: text)))
                    }
                    .multilineTextAlignment(.trailing)
                } label: {
                    Label("Tags", systemImage: "tag")
                }
            }

            notes
            subtasks
            comments
            history
        }
        .contentMargins(.bottom, 88, for: .scrollContent) // room for the capture button
        .navigationTitle("#\(task.id)")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if task.status == .done {
                        Button { update(TaskPatch(status: .todo)) } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
                    } else {
                        Button { Task { await model.complete(task.id) } } label: { Label("Mark as Done", systemImage: "checkmark.circle") }
                    }
                    Button(role: .destructive) { confirmingDelete = true } label: { Label("Delete", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
            }
        }
        .confirmationDialog("Delete “\(task.title)”?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete Task", role: .destructive) {
                Task {
                    await model.delete(task.id)
                    if model.task(task.id) == nil { dismiss() }
                }
            }
        } message: {
            Text("It will be deleted from your Mac too. This can’t be undone.")
        }
        .sheet(isPresented: $editingNotes) {
            NotesEditor(notes: task.notes) { update(TaskPatch(notes: $0)) }
        }
        .alert("Rename Subtask", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { subtask in
            TextField("Title", text: $renamedTitle)
            Button("Save") {
                let title = renamedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty, title != subtask.title { Task { await model.renameSubtask(task.id, subtask.id, title) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: Notes

    private var notes: some View {
        Section {
            if task.notes.isEmpty {
                Button { editingNotes = true } label: { Label("Add Notes", systemImage: "note.text") }
            } else {
                MarkdownView(task.notes)
                    .padding(.vertical, 2)
            }
        } header: {
            HStack {
                Text("Notes")
                Spacer()
                if !task.notes.isEmpty {
                    Button("Edit") { editingNotes = true }
                        .font(.footnote)
                        .textCase(nil)
                }
            }
        }
    }

    // MARK: Subtasks

    private var subtasks: some View {
        Section {
            if !task.subtasks.isEmpty {
                ProgressView(value: Double(task.subtasksDone), total: Double(task.subtasks.count)) {
                    Text("\(task.subtasksDone) of \(task.subtasks.count) done")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(task.subtasks) { subtask in
                Button {
                    Task { await model.setSubtask(task.id, subtask.id, done: !subtask.done) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: subtask.done ? "checkmark.square.fill" : "square")
                            .foregroundStyle(subtask.done ? Color.accentColor : Color.secondary)
                        // Explicit colours: inside a button, "primary" would mean the tint.
                        Text(subtask.title)
                            .strikethrough(subtask.done)
                            .foregroundStyle(subtask.done ? Color.secondary : Color.primary)
                            .multilineTextAlignment(.leading)
                    }
                }
                .accessibilityLabel(subtask.title)
                .accessibilityValue(subtask.done ? "Done" : "Not done")
                .accessibilityHint(subtask.done ? "Marks it not done" : "Marks it done")
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { Task { await model.removeSubtask(task.id, subtask.id) } } label: { Label("Remove", systemImage: "trash") }
                    Button {
                        renamedTitle = subtask.title
                        renaming = subtask
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                }
            }
            HStack {
                Image(systemName: "plus").foregroundStyle(.secondary)
                TextField("Add a subtask", text: $newSubtask)
                    .submitLabel(.done)
                    .onSubmit(addSubtask)
            }
        } header: {
            Text("Subtasks")
        }
    }

    private func addSubtask() {
        let title = newSubtask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        newSubtask = ""
        Task {
            if !(await model.addSubtask(task.id, title)) { newSubtask = title } // not saved: give it back
        }
    }

    // MARK: Comments and history

    private var activity: [ActivityEntry] { task.activity ?? [] }

    private var comments: some View {
        Section {
            ForEach(Array(activity.filter { $0.kind == .comment }.enumerated()), id: \.offset) { _, entry in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(entry.author).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(entry.at.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                    }
                    InlineMarkdown(text: entry.text)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
            if task.activity == nil, task.commentCount > 0 {
                ProgressView()
            }
            HStack(alignment: .bottom) {
                TextField("Add a comment", text: $newComment, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($commentFocused)
                Button(action: addComment) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.borderless)
                .disabled(newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Post comment")
            }
        } header: {
            Text("Comments")
        }
    }

    private func addComment() {
        let text = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        newComment = ""
        commentFocused = false
        Task {
            if !(await model.addComment(task.id, text)) { newComment = text } // not saved: give it back
        }
    }

    @ViewBuilder
    private var history: some View {
        let events = activity.filter { $0.kind == .event }
        if !events.isEmpty {
            Section {
                DisclosureGroup(isExpanded: $showingHistory) {
                    ForEach(Array(events.reversed().enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(entry.author) \(entry.text)").font(.footnote)
                            Text(entry.at.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } label: {
                    Label("History", systemImage: "clock.arrow.circlepath")
                }
            }
        }
    }
}

/// Plain-text editing of the Markdown notes.
private struct NotesEditor: View {
    @Environment(\.dismiss) private var dismiss
    var notes: String
    var onSave: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .focused($focused)
                .font(.body.monospaced())
                .padding(.horizontal, 12)
                .navigationTitle("Notes")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            if text != notes { onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
                            dismiss()
                        }
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    Text(verbatim: "Markdown: **bold**, *italic*, `code`, - lists, - [ ] tasks, links")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(8)
                }
        }
        .onAppear {
            text = notes
            focused = true
        }
    }
}
