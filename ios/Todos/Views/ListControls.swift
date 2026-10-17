// What the list shows and in what order: the Sort and Filter menus in the toolbar,
// and the bar under the segmented control that says what is filtered. What each
// choice means is up to TodosKit's ListRules, the rules the Mac and the command line
// follow too; this only collects the choices.

import SwiftUI
import TodosKit

extension TaskSort.Key {
    /// The keys the list can be sorted by. Not status: the sections already are.
    static let choices: [TaskSort.Key] = [.default, .due, .priority, .created, .updated, .completed, .title, .project]

    var label: String {
        switch self {
        case .default: "Default"
        case .due: "Due Date"
        case .priority: "Priority"
        case .created: "Created"
        case .updated: "Updated"
        case .completed: "Completed"
        case .title: "Title"
        case .project: "Project"
        case .status: "Status"
        case .id: "Number"
        }
    }

    /// Each direction in words: ascending, then descending.
    var directions: (up: String, down: String) {
        switch self {
        case .due: ("Earliest First", "Latest First")
        case .priority: ("High First", "Low First")
        case .created, .updated, .completed: ("Oldest First", "Newest First")
        case .title, .project: ("A to Z", "Z to A")
        default: ("Ascending", "Descending")
        }
    }

    /// The direction a key starts in when it is picked: newest first, for dates of things done.
    var startsDescending: Bool { [.created, .updated, .completed].contains(self) }
}

struct SortMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let sort = model.query.sort
        Menu {
            Picker("Sort By", selection: key(0)) {
                ForEach(TaskSort.Key.choices, id: \.self) { Text($0.label).tag(Optional($0)) }
            }
            if !sort.isDefault {
                order(0)
                Menu {
                    Picker("Then By", selection: key(1)) {
                        Text("Nothing").tag(TaskSort.Key?.none)
                        ForEach(TaskSort.Key.choices.filter { $0 != .default && $0 != sort.items[0].key }, id: \.self) { Text($0.label).tag(Optional($0)) }
                    }
                    if sort.items.count > 1 { order(1) }
                } label: {
                    Label(sort.items.count > 1 ? "Then By: \(sort.items[1].key.label)" : "Then By", systemImage: "arrow.turn.down.right")
                }
            }
        } label: {
            Image(systemName: sort.isDefault ? "arrow.up.arrow.down.circle" : "arrow.up.arrow.down.circle.fill")
        }
        .accessibilityLabel("Sort")
        .accessibilityValue(sort.isDefault ? "Default" : sort.items.map(\.key.label).joined(separator: ", then "))
    }

    /// The key at a position: picking one there replaces it, in its usual direction.
    private func key(_ index: Int) -> Binding<TaskSort.Key?> {
        Binding {
            model.query.sort.items.indices.contains(index) ? model.query.sort.items[index].key : nil
        } set: { key in
            var items = Array(model.query.sort.items.prefix(index))
            if let key {
                items.append(TaskSort.Item(key, descending: key.startsDescending))
                // What came after stays, unless it is the key now picked here.
                items += model.query.sort.items.dropFirst(index + 1).filter { $0.key != key }
            }
            model.query.sort = items.first?.key == .default ? .default : TaskSort(items)
        }
    }

    /// Which way the key at a position runs.
    private func order(_ index: Int) -> some View {
        let key = model.query.sort.items[index].key
        return Picker("Order", selection: Binding {
            model.query.sort.items[index].descending
        } set: { descending in
            model.query.sort.items[index].descending = descending
        }) {
            Text(key.directions.up).tag(false)
            Text(key.directions.down).tag(true)
        }
    }
}

struct FilterMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Menu {
            Section("Show") {
                ForEach(TaskFocus.allCases) { focus in
                    Toggle("\(focus.label) (\(count(focus)))", isOn: member(focus, of: \.focus))
                }
            }
            Menu("Priority") {
                ForEach(TaskPriority.allCases, id: \.self) { Toggle($0.label, isOn: member($0, of: \.priorities)) }
            }
            if !model.projects.isEmpty {
                Menu("Project") {
                    ForEach(model.projects, id: \.self) { Toggle($0, isOn: project($0)) }
                    Toggle("No Project", isOn: project(""))
                }
            }
            if !model.tags.isEmpty {
                Menu("Tag") {
                    ForEach(model.tags, id: \.self) { Toggle("@\($0)", isOn: member($0, of: \.tags)) }
                    if model.query.tags.count > 1 {
                        Picker("Match", selection: $model.query.tagMode) {
                            Text("Any of These").tag(ListFilter.TagMode.any)
                            Text("All of These").tag(ListFilter.TagMode.all)
                        }
                    }
                }
            }
            if model.query.isFiltered {
                Button("Clear Filters", systemImage: "xmark.circle", role: .destructive) { model.query.clearFilters() }
                    .menuActionDismissBehavior(.enabled)
            }
        } label: {
            Image(systemName: model.query.isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        // Several can be picked: the menu stays open while they are.
        .menuActionDismissBehavior(.disabled)
        .accessibilityLabel("Filter")
        .accessibilityValue(ActiveFilterBar.chips(model.query).map(\.label).joined(separator: ", "))
    }

    private func member<T: Hashable>(_ value: T, of field: WritableKeyPath<TaskQuery, Set<T>>) -> Binding<Bool> {
        Binding {
            model.query[keyPath: field].contains(value)
        } set: { on in
            if on { model.query[keyPath: field].insert(value) } else { model.query[keyPath: field].remove(value) }
        }
    }

    /// Projects are told apart without regard to case, as the rules do.
    private func project(_ name: String) -> Binding<Bool> {
        Binding {
            model.query.projects.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
        } set: { on in
            model.query.projects = model.query.projects.filter { $0.caseInsensitiveCompare(name) != .orderedSame }
            if on { model.query.projects.insert(name) }
        }
    }

    private func count(_ focus: TaskFocus) -> Int {
        let counts = model.counts
        switch focus {
        case .dueToday: return counts.dueToday
        case .overdue: return counts.overdue
        case .withClaude: return counts.claude
        }
    }
}

/// The filters in use, under the segmented control, each removed with a tap.
struct ActiveFilterBar: View {
    @Environment(AppModel.self) private var model

    struct Chip: Identifiable {
        var id: String
        var label: String
        var remove: (inout TaskQuery) -> Void
    }

    /// In the order the Filter menu has them.
    static func chips(_ query: TaskQuery) -> [Chip] {
        var chips = TaskFocus.allCases.filter(query.focus.contains).map { focus in
            Chip(id: "focus:\(focus.rawValue)", label: focus.label) { $0.focus.remove(focus) }
        }
        chips += TaskPriority.allCases.filter(query.priorities.contains).map { priority in
            Chip(id: "priority:\(priority.rawValue)", label: "\(priority.label) priority") { $0.priorities.remove(priority) }
        }
        chips += query.projects.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }.map { project in
            Chip(id: "project:\(project)", label: project.isEmpty ? "No project" : "#\(project)") { $0.projects.remove(project) }
        }
        chips += query.tags.sorted().map { tag in
            Chip(id: "tag:\(tag)", label: "@\(tag)") { $0.tags.remove(tag) }
        }
        if query.tags.count > 1, query.tagMode == .all {
            chips.append(Chip(id: "tagMode", label: "Every tag") { $0.tagMode = .any })
        }
        return chips
    }

    var body: some View {
        let chips = Self.chips(model.query)
        if !chips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chips) { chip in
                        Button {
                            chip.remove(&model.query)
                            if model.query.tags.count < 2 { model.query.tagMode = .any }
                        } label: {
                            HStack(spacing: 4) {
                                Text(chip.label)
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .accessibilityLabel("Remove filter: \(chip.label)")
                    }
                    Button("Clear") { model.query.clearFilters() }
                        .controlSize(.small)
                        .accessibilityLabel("Clear filters")
                }
                .padding(.horizontal)
            }
            .scrollClipDisabled()
        }
    }
}

extension TaskQuery {
    /// Back to every task in the chosen column. The search and the sort stay.
    mutating func clearFilters() {
        focus = []
        projects = []
        priorities = []
        tags = []
        tagMode = .any
    }
}
