// The Today tab: what is overdue, then what is due today, each most important first
// and then oldest first, as the Mac's Today view has them. The tasks are the widget's
// (TodosKit's DueOverview), so the tab's badge is the number the widget and the Mac's
// Dock badge show.

import SwiftUI
import TodosKit

struct TodayView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let sections = model.due.todaySections
        List {
            ForEach(sections) { section in
                Section {
                    ForEach(section.tasks) { task in
                        NavigationLink(value: task.id) {
                            TaskRow(task: task, isWaiting: model.hasWaitingChanges(task.id), needsAttention: model.needsAttention(task.id))
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button { Task { await model.complete(task.id) } } label: { Label("Done", systemImage: "checkmark") }
                                .tint(.green)
                        }
                    }
                } header: {
                    Text("\(section.kind.label) · \(section.tasks.count)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if !model.hasLoaded {
                ProgressView("Loading from your Mac…")
            } else if sections.isEmpty {
                ContentUnavailableView("Nothing Due Today", systemImage: "sun.max", description: Text("Nothing is overdue, and nothing is due today."))
            }
        }
        .navigationTitle("Today")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.retry() }
    }
}
