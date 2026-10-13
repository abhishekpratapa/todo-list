// The home screen and lock screen widget: what is due today and what is overdue.
//
// It reads the list the app keeps in the shared container, with this iPhone's
// waiting changes on top, so it shows what the app shows. It never contacts the
// Mac itself. The app reloads it whenever the list changes; it also redraws at
// midnight, when "today" becomes a different day.

import SwiftUI
import TodosKit
import WidgetKit

struct DueEntry: TimelineEntry, Sendable {
    var date: Date
    var isPaired = true
    var overdue: [TodoTask] = []
    var today: [TodoTask] = []

    var tasks: [TodoTask] { overdue + today }

    /// "2 due today · 1 overdue"
    var summary: String {
        var parts: [String] = []
        if !today.isEmpty { parts.append("\(today.count) due today") }
        if !overdue.isEmpty { parts.append("\(overdue.count) overdue") }
        return parts.isEmpty ? "Nothing due today" : parts.joined(separator: " · ")
    }

    static let sample = DueEntry(
        date: Date(),
        overdue: [TodoTask(id: 1, title: "Pay electricity bill")],
        today: [TodoTask(id: 2, title: "Renew passport", priority: .high), TodoTask(id: 3, title: "Water the plants")]
    )

    /// What the list on this iPhone says is due, as of `date`.
    static func current(at date: Date) -> DueEntry {
        guard let folder = SharedContainer.currentHubDirectory() else { return DueEntry(date: date, isPaired: false) }
        let stored = LocalStore.read(directory: folder)
        let day = Day(date)
        let open = stored.list.tasks.applying(stored.changes).inListOrder().filter(\.status.isOpen)
        return DueEntry(date: date, overdue: open.filter { $0.isOverdue(on: day) }, today: open.filter { $0.isDueToday(day) })
    }
}

struct DueProvider: TimelineProvider {
    func placeholder(in context: Context) -> DueEntry {
        .sample
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (DueEntry) -> Void) {
        completion(context.isPreview ? .sample : .current(at: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<DueEntry>) -> Void) {
        let now = Date()
        let midnight = Calendar.current.startOfDay(for: now.addingTimeInterval(86_400))
        completion(Timeline(entries: [.current(at: now), .current(at: midnight)], policy: .after(midnight.addingTimeInterval(60))))
    }
}

struct DueWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: DueEntry

    private static let accent = Color(red: 0x55 / 255, green: 0x50 / 255, blue: 0xD8 / 255)

    var body: some View {
        Group {
            if !entry.isPaired {
                Text("Open Todos to connect it to your Mac.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                switch family {
                case .accessoryRectangular: lockScreen
                case .systemSmall: list(showing: 3)
                default: list(showing: 4)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var lockScreen: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.summary).font(.headline).widgetAccentable()
            ForEach(entry.tasks.prefix(2)) { task in
                Text(task.title).font(.footnote).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func list(showing limit: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(entry.tasks.count)")
                    .font(.title.weight(.bold))
                    .foregroundStyle(entry.overdue.isEmpty ? Self.accent : Color.red)
                Text(entry.overdue.isEmpty ? "due today" : entry.today.isEmpty ? "overdue" : "due · \(entry.overdue.count) overdue")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(entry.summary)

            if entry.tasks.isEmpty {
                Text("Nothing due today.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(entry.tasks.prefix(limit)) { task in
                Link(destination: AppLinks.task(task.id)) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: entry.overdue.contains(task) ? "exclamationmark.circle.fill" : "circle")
                            .font(.caption2)
                            .foregroundStyle(entry.overdue.contains(task) ? Color.red : Color.secondary)
                        Text(task.title)
                            .font(.footnote)
                            .lineLimit(1)
                    }
                }
                .accessibilityLabel("\(task.title), \(entry.overdue.contains(task) ? "overdue" : "due today")")
            }
            if entry.tasks.count > limit {
                Text("and \(entry.tasks.count - limit) more")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct DueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DueWidget", provider: DueProvider()) { entry in
            DueWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Due Today")
        .description("Tasks due today and overdue, from the list on this iPhone.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@main
struct TodosWidgets: WidgetBundle {
    var body: some Widget {
        DueWidget()
    }
}
