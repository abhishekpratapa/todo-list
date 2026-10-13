// The list: the Mac's four columns as sections, with a segmented control to pick
// which ones show. Swipe a task to complete it, move it, or delete it.

import SwiftUI
import TodosKit

struct TaskListView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingSettings: Bool
    @State private var deleting: TodoTask?

    var body: some View {
        @Bindable var model = model
        let sections = model.sections
        List {
            if let issue = model.issue, model.hasLoaded {
                Section {
                    Button { showingSettings = true } label: { IssueBanner(issue: issue) }
                        .buttonStyle(.plain)
                }
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.tasks) { task in
                        NavigationLink(value: task.id) {
                            TaskRow(task: task)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) { leadingActions(task) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) { trailingActions(task) }
                        .contextMenu { contextMenu(task) }
                    }
                } header: {
                    Text("\(section.status.label) · \(section.tasks.count)")
                }
            }
            if model.hasLoaded, !sections.isEmpty {
                Section {
                } footer: {
                    SyncFooter()
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.bottom, 88, for: .scrollContent) // room for the capture button
        .overlay { emptyState(sections) }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("Show", selection: $model.query.filter) {
                ForEach(TaskFilter.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .navigationTitle("Todos")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.query.search, prompt: "Search tasks")
        .refreshable { await model.retry() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showingSettings = true } label: {
                    Image(systemName: model.issue != nil ? "exclamationmark.triangle.fill" : "gearshape")
                        .foregroundStyle(model.issue != nil ? Color.orange : Color.accentColor)
                }
                .accessibilityLabel("Settings")
                .accessibilityValue(model.issue?.title ?? (model.isLive ? "Connected to your Mac" : "Connecting to your Mac"))
            }
            ToolbarItem(placement: .topBarTrailing) { filterMenu }
        }
        .confirmationDialog(
            deleting.map { "Delete “\($0.title)”?" } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { task in
            Button("Delete Task", role: .destructive) { Task { await model.delete(task.id) } }
        } message: { _ in
            Text("It will be deleted from your Mac too. This can’t be undone.")
        }
    }

    // MARK: Actions

    @ViewBuilder
    private func leadingActions(_ task: TodoTask) -> some View {
        if task.status == .done {
            Button { Task { await model.update(task.id, TaskPatch(status: .todo)) } } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
                .tint(.orange)
        } else {
            Button { Task { await model.complete(task.id) } } label: { Label("Done", systemImage: "checkmark") }
                .tint(.green)
        }
    }

    @ViewBuilder
    private func trailingActions(_ task: TodoTask) -> some View {
        Button { deleting = task } label: { Label("Delete", systemImage: "trash") }
            .tint(.red)
        // The other open columns this task could move to.
        ForEach([TaskStatus.blocked, .inProgress, .todo].filter { $0 != task.status }.prefix(2), id: \.self) { status in
            Button { Task { await model.update(task.id, TaskPatch(status: status)) } } label: { Label(status.label, systemImage: status.symbol) }
                .tint(status.tint)
        }
    }

    @ViewBuilder
    private func contextMenu(_ task: TodoTask) -> some View {
        Menu("Status") {
            ForEach(TaskStatus.allCases, id: \.self) { status in
                Button { Task { await model.update(task.id, TaskPatch(status: status)) } } label: { Label(status.label, systemImage: status.symbol) }
                    .disabled(status == task.status)
            }
        }
        Menu("Priority") {
            ForEach(TaskPriority.allCases, id: \.self) { priority in
                Button(priority.label) { Task { await model.update(task.id, TaskPatch(priority: priority)) } }
                    .disabled(priority == task.priority)
            }
        }
        Menu("Due") {
            Button("Today") { Task { await model.update(task.id, TaskPatch(due: .set(.today()))) } }
            Button("Tomorrow") { Task { await model.update(task.id, TaskPatch(due: .set(Day(Date().addingTimeInterval(86_400))))) } }
            if task.due != nil {
                Button("No Due Date") { Task { await model.update(task.id, TaskPatch(due: .clear)) } }
            }
        }
        Button { Task { await model.update(task.id, TaskPatch(assignee: task.assignee == .me ? .claude : .me)) } } label: {
            Label(task.assignee == .me ? "Assign to Claude" : "Assign to Me", systemImage: "person")
        }
        Divider()
        Button(role: .destructive) { deleting = task } label: { Label("Delete", systemImage: "trash") }
    }

    private var filterMenu: some View {
        @Bindable var model = model
        return Menu {
            Picker("Focus", selection: $model.query.focus) {
                Text("All").tag(TaskFocus?.none)
                ForEach(TaskFocus.allCases) { focus in
                    Text("\(focus.label) (\(count(focus)))").tag(TaskFocus?.some(focus))
                }
            }
            if !model.projects.isEmpty {
                Picker("Project", selection: $model.query.project) {
                    Text("All Projects").tag(String?.none)
                    ForEach(model.projects, id: \.self) { Text($0).tag(String?.some($0)) }
                }
            }
        } label: {
            Image(systemName: model.query.focus != nil || model.query.project != nil ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter")
        .accessibilityValue([model.query.focus?.label, model.query.project].compactMap { $0 }.joined(separator: ", "))
    }

    private func count(_ focus: TaskFocus) -> Int {
        let counts = model.counts
        switch focus {
        case .dueToday: return counts.dueToday
        case .overdue: return counts.overdue
        case .withClaude: return counts.claude
        }
    }

    // MARK: Empty and error states

    @ViewBuilder
    private func emptyState(_ sections: [TaskSection]) -> some View {
        if !model.hasLoaded {
            if let issue = model.issue {
                IssueView(issue: issue)
            } else {
                ProgressView("Loading from your Mac…")
            }
        } else if sections.isEmpty {
            if model.query.isNarrowed {
                ContentUnavailableView.search
            } else {
                ContentUnavailableView(
                    model.query.filter == .done ? "Nothing Done Yet" : "Nothing Here",
                    systemImage: "checkmark.circle",
                    description: Text(model.query.filter == .open ? "Tap + to add a task." : "No tasks in this column.")
                )
            }
        }
    }
}

/// One line at the bottom of the list saying how fresh it is.
struct SyncFooter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 6) {
                Image(systemName: model.isLive ? "dot.radiowaves.left.and.right" : "clock")
                Text(text(at: context.date))
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
        }
    }

    private func text(at now: Date) -> String {
        guard let synced = model.lastSynced else { return "Not updated yet" }
        if model.isLive { return "Up to date · updates live" }
        return now.timeIntervalSince(synced) < 60 ? "Updated just now" : "Updated \(synced.formatted(.relative(presentation: .named)))"
    }
}

extension TaskStatus {
    var symbol: String {
        switch self {
        case .todo: "circle"
        case .inProgress: "play.circle"
        case .blocked: "pause.circle"
        case .done: "checkmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .todo: .gray
        case .inProgress: .blue
        case .blocked: .orange
        case .done: .green
        }
    }
}
