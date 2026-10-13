// The home screen and lock screen widget: what is due today and what is overdue.
// The large size also shows what is coming up in the next week and, where there
// is still room, the rest of the open tasks.
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
    var due = DueOverview()

    static let sample = DueEntry(
        date: Date(),
        due: DueOverview(
            overdue: [TodoTask(id: 1, title: "Pay electricity bill", due: Day(Date().addingTimeInterval(-2 * 86_400)))],
            today: [TodoTask(id: 2, title: "Renew passport", priority: .high, due: .today()), TodoTask(id: 3, title: "Water the plants", due: .today())],
            upcoming: [TodoTask(id: 4, title: "Book flights", due: Day(Date().addingTimeInterval(2 * 86_400))), TodoTask(id: 5, title: "Call the bank", due: Day(Date().addingTimeInterval(4 * 86_400)))],
            later: [TodoTask(id: 6, title: "Plan the garden"), TodoTask(id: 7, title: "Sort old photos")]
        )
    )

    /// What the list on this iPhone says is due, as of `date`.
    static func current(at date: Date) -> DueEntry {
        guard let folder = SharedContainer.currentHubDirectory() else { return DueEntry(date: date, isPaired: false) }
        let stored = LocalStore.read(directory: folder)
        return DueEntry(date: date, due: DueOverview(tasks: stored.list.tasks.applying(stored.changes), on: Day(date)))
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
    private var due: DueOverview { entry.due }

    var body: some View {
        Group {
            if !entry.isPaired {
                Text("Open Todos to connect it to your Mac.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                switch family {
                case .accessoryRectangular:
                    lockScreen
                case .systemLarge:
                    // As many lines as fit at the current text size.
                    ViewThatFits(in: .vertical) {
                        ForEach(Array((2...16).reversed()), id: \.self) { large(rows: $0) }
                    }
                case .systemSmall:
                    compact(showing: 3)
                default:
                    compact(showing: 4)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Lock screen

    private var lockScreen: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(due.summary).font(.headline).widgetAccentable()
            ForEach(due.dueNow.prefix(2)) { task in
                Text(task.title).font(.footnote).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Small and medium

    private func compact(showing limit: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            count
            if due.dueNow.isEmpty {
                Text("Nothing due today.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(due.dueNow.prefix(limit)) { task in
                row(task, due.overdue.contains(task) ? .overdue : .today, detail: false)
            }
            if due.dueNow.count > limit {
                more(due.dueNow.count - limit)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Large

    /// Overdue, today, the week ahead and the rest, each under its heading, in `rows` lines.
    private func large(rows: Int) -> some View {
        let plan = due.sections(fitting: rows)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                count
                Text(entry.date, format: .dateTime.weekday(.wide).month().day())
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if plan.sections.isEmpty {
                Text(plan.hidden == 0 ? "Nothing left to do." : "Open Todos to see what is due.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
            ForEach(plan.sections) { section in
                Text(section.kind.label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(section.kind == .overdue ? Color.red : Color.secondary)
                    .padding(.top, 2)
                    .accessibilityAddTraits(.isHeader)
                ForEach(section.tasks) { task in
                    row(task, section.kind, detail: true)
                }
            }
            if plan.hidden > 0 {
                more(plan.hidden)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: Pieces

    /// The big number: how much is due now.
    private var count: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("\(due.dueNow.count)")
                .font(.title.weight(.bold))
                .foregroundStyle(due.overdue.isEmpty ? Self.accent : Color.red)
            Text(due.overdue.isEmpty ? "due today" : due.today.isEmpty ? "overdue" : "due · \(due.overdue.count) overdue")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(due.summary)
    }

    /// One task. Tapping it opens it in the app. `detail` adds its date and priority, where there is room.
    private func row(_ task: TodoTask, _ kind: DueOverview.Kind, detail: Bool) -> some View {
        let today = Day(entry.date)
        let when = task.due.map { $0.label(relativeTo: today) } ?? ""
        return Link(destination: AppLinks.task(task.id)) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: kind == .overdue ? "exclamationmark.circle.fill" : "circle")
                    .font(.caption2)
                    .foregroundStyle(kind == .overdue ? Color.red : Color.secondary)
                Text(task.title)
                    .font(detail ? .subheadline : .footnote)
                    .lineLimit(1)
                if detail {
                    if task.priority == .high {
                        Image(systemName: "exclamationmark")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.red)
                    }
                    Spacer(minLength: 4)
                    if kind != .today, !when.isEmpty {
                        Text(when)
                            .font(.caption)
                            .foregroundStyle(kind == .overdue ? Color.red : Color.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
            }
        }
        .accessibilityLabel([task.title, spoken(kind, when)].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    private func spoken(_ kind: DueOverview.Kind, _ when: String) -> String {
        switch kind {
        case .overdue: "overdue since \(when)"
        case .today: "due today"
        case .upcoming, .later: when.isEmpty ? "" : "due \(when)"
        }
    }

    private func more(_ count: Int) -> some View {
        Text("and \(count) more")
            .font(.caption2)
            .foregroundStyle(.secondary)
    }
}

struct DueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DueWidget", provider: DueProvider()) { entry in
            DueWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Due Today")
        .description("Tasks due today and overdue. The large size adds the week ahead and your other open tasks.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

@main
struct TodosWidgets: WidgetBundle {
    var body: some Widget {
        DueWidget()
    }
}
