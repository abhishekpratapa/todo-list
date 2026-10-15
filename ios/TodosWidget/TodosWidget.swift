// The home screen and lock screen widget: what is due today and what is overdue.
// The large size also shows what is coming up in the next week and, where there
// is still room, the rest of the open tasks. It uses the room it has: with a
// short list each title is shown in full, with its small print; only a long
// list goes down to a line a task.
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
            upcoming: [TodoTask(id: 4, title: "Book flights", due: Day(Date().addingTimeInterval(2 * 86_400))), TodoTask(id: 5, title: "Call the bank about the standing order", status: .inProgress, due: Day(Date().addingTimeInterval(4 * 86_400)), project: "money")],
            later: [TodoTask(id: 6, title: "Plan the garden", project: "home"), TodoTask(id: 7, title: "Sort old photos")]
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
                    // The first of these that fits. (One list, numbered, so that each
                    // has an identity of its own: ViewThatFits stops on two children alike.)
                    ViewThatFits(in: .vertical) {
                        ForEach(Array(fits.enumerated()), id: \.offset) { _, fit in
                            large(rows: fit.rows, fit.density, wrapping: fit.wrapping)
                        }
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
                row(task, due.overdue.contains(task) ? .overdue : .today)
            }
            if due.dueNow.count > limit {
                more(due.dueNow.count - limit)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Large

    private static let mostRows = 16

    /// One way of laying the large size out.
    private struct Fit {
        var density: Density
        var rows: Int
        var wrapping = 0
    }

    /// The layouts to try, best first: the roomiest form that shows every task;
    /// failing that, a line a task with as many of the first ones on two lines as
    /// there is room for; and for a long list, as many tasks as fit at the current
    /// text size.
    private var fits: [Fit] {
        let most = Self.mostRows
        return [Density.roomy, .full, .wrapped].map { Fit(density: $0, rows: most) }
            + stride(from: min(due.count, most) - 1, to: 0, by: -1).map { Fit(density: .compact, rows: most, wrapping: $0) }
            + stride(from: most, to: 1, by: -1).map { Fit(density: .compact, rows: $0) }
    }

    /// How much room a task is given in the large size.
    private struct Density {
        var title: Font
        /// How many lines a title may run to.
        var lines: Int
        /// Whether the small print goes under the title: status, project, checklist.
        var detail: Bool
        var spacing: CGFloat

        static let roomy = Density(title: .body, lines: 3, detail: true, spacing: 12)
        static let full = Density(title: .subheadline, lines: 3, detail: true, spacing: 9)
        static let wrapped = Density(title: .subheadline, lines: 2, detail: false, spacing: 7)
        static let compact = Density(title: .subheadline, lines: 1, detail: false, spacing: 6)
    }

    /// Overdue, today, the week ahead and the rest, each under its heading: `rows` of
    /// them at most, counting the headings. The first `wrapping` tasks may run to a
    /// line more than the density gives: what is most pressing gets the spare room.
    private func large(rows: Int, _ density: Density, wrapping: Int = 0) -> some View {
        let plan = due.sections(fitting: rows)
        let favoured = Set(plan.sections.flatMap(\.tasks).prefix(wrapping).map(\.id))
        return VStack(alignment: .leading, spacing: density.spacing) {
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
                    largeRow(task, section.kind, density, lines: density.lines + (favoured.contains(task.id) ? 1 : 0))
                }
            }
            if plan.hidden > 0 {
                more(plan.hidden)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// One task in the large size: its title on as many lines as the density allows,
    /// its small print under it, and when it is due at the end of the first line.
    private func largeRow(_ task: TodoTask, _ kind: DueOverview.Kind, _ density: Density, lines: Int) -> some View {
        let when = task.due.map { $0.label(relativeTo: Day(entry.date)) } ?? ""
        let detail = density.detail ? task.widgetDetail : ""
        return Link(destination: AppLinks.task(task.id)) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: kind == .overdue ? "exclamationmark.circle.fill" : "circle")
                    .font(.caption2)
                    .foregroundStyle(kind == .overdue ? Color.red : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(task.title)
                        .font(density.title)
                        .lineLimit(lines)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
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
        .accessibilityLabel([task.title, detail, spoken(kind, when)].filter { !$0.isEmpty }.joined(separator: ", "))
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

    /// One task in the small and medium sizes: its title, on one line. Tapping it opens it in the app.
    private func row(_ task: TodoTask, _ kind: DueOverview.Kind) -> some View {
        Link(destination: AppLinks.task(task.id)) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: kind == .overdue ? "exclamationmark.circle.fill" : "circle")
                    .font(.caption2)
                    .foregroundStyle(kind == .overdue ? Color.red : Color.secondary)
                Text(task.title)
                    .font(.footnote)
                    .lineLimit(1)
            }
        }
        .accessibilityLabel([task.title, spoken(kind, task.due.map { $0.label(relativeTo: Day(entry.date)) } ?? "")].filter { !$0.isEmpty }.joined(separator: ", "))
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
        HabitsWidget()
        HabitYearWidget()
    }
}
