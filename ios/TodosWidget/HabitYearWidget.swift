// The year widget: a dot for every day of the year, lit on the days every habit
// was done, fainter on the days some of it was, and dim where none of it was.
// Today is the orange dot: a ring while there is still something to do, filled
// once it is all done. The days to come are dim.
//
// On the Lock Screen: the run of days with everything done (round), the last
// weeks as a small calendar beside it (rectangular), and both in a line (inline).
//
// It reads what the app keeps in the shared container: how each day went, as the
// Mac said when the app last asked (once a day), and the habits as they stand
// now, with this iPhone's waiting check-ins, for today and yesterday.

import SwiftUI
import TodosKit
import WidgetKit

struct HabitYearEntry: TimelineEntry, Sendable {
    enum State: Sendable, Equatable {
        case notPaired
        /// The Todos on the Mac is older than habits.
        case unsupported
        case noHabits
        case year(HabitYear)
    }

    var date: Date
    var state: State

    /// A year that looks lived in, for the widget gallery.
    static let sample: HabitYearEntry = {
        let calendar = Calendar.current
        let length = calendar.range(of: .day, in: .year, for: Date())?.count ?? 365
        let now = (calendar.ordinality(of: .day, in: .year, for: Date()) ?? 1) - 1
        let marks: [HabitYear.Mark] = (0..<length).map { day in
            if day > now { return .future }
            if day == now { return .open }
            if day < 30 { return .none }
            switch (day * 37 + 11) % 23 { // a steady pattern that looks like a person's year
            case 0: return .missed
            case 1, 2, 3: return .partial
            default: return .complete
            }
        }
        return HabitYearEntry(date: Date(), state: .year(HabitYear(year: calendar.component(.year, from: Date()), marks: marks, today: now)))
    }()

    /// The year as the habits on this iPhone say, as of `date`.
    static func current(at date: Date) -> HabitYearEntry {
        guard let folder = SharedContainer.currentHubDirectory() else { return HabitYearEntry(date: date, state: .notPaired) }
        let kept = LocalStore.readHabits(directory: folder)
        guard kept.supported != false else { return HabitYearEntry(date: date, state: .unsupported) }
        let habits = kept.habits.reckoned(with: LocalStore.read(directory: folder).changes, now: date)
        guard let today = habits.map(\.today.day).max() else { return HabitYearEntry(date: date, state: .noHabits) }
        return HabitYearEntry(date: date, state: .year(HabitYear(calendar: kept.calendar, habits: habits, today: today)))
    }

    /// When "today" next becomes another day: the habits' day start, 3 AM unless changed.
    static func nextDay(after date: Date) -> Date? {
        guard let folder = SharedContainer.currentHubDirectory() else { return nil }
        let habits = LocalStore.readHabits(directory: folder).habits
        return habits.compactMap { HabitClock.end(of: HabitClock.day(of: date, zone: .current, dayStart: $0.dayStart), zone: .current, dayStart: $0.dayStart) }
            .filter { $0 > date }.min()
    }
}

struct HabitYearProvider: TimelineProvider {
    func placeholder(in context: Context) -> HabitYearEntry {
        .sample
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (HabitYearEntry) -> Void) {
        completion(context.isPreview ? .sample : .current(at: Date()))
    }

    /// Drawn now and again when the day turns over. The app reloads it whenever a habit changes.
    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<HabitYearEntry>) -> Void) {
        let now = Date()
        var entries = [HabitYearEntry.current(at: now)]
        if let turn = HabitYearEntry.nextDay(after: now) {
            entries.append(.current(at: turn.addingTimeInterval(1)))
        }
        let next = entries.last.map(\.date) ?? now
        completion(Timeline(entries: entries, policy: .after(max(next, now.addingTimeInterval(6 * 3600)).addingTimeInterval(60))))
    }
}

struct HabitYearView: View {
    @Environment(\.widgetFamily) private var family
    var entry: HabitYearEntry

    var body: some View {
        Group {
            switch entry.state {
            case .notPaired:
                message("Open Todos to connect it to your Mac.")
            case .unsupported:
                message("Habits need a newer Todos on your Mac.")
            case .noHabits:
                message("No habits yet. Add one in Todos.")
            case .year(let year):
                switch family {
                case .accessoryCircular: streak(year)
                case .accessoryRectangular: weeks(year)
                case .accessoryInline: inline(year)
                default: grid(year)
                }
            }
        }
        .widgetURL(AppLinks.habits)
    }

    private var isLockScreen: Bool {
        [.accessoryCircular, .accessoryRectangular, .accessoryInline].contains(family)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(isLockScreen ? .caption2 : .footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    private func grid(_ year: HabitYear) -> some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 12 : 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: String(year.year))
                Spacer(minLength: 8)
                if year.counted > 0 {
                    Text(verbatim: "\(year.completed)/\(year.counted) days")
                }
            }
            .font(.system(family == .systemLarge ? .subheadline : .caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(year.year): every habit done on \(year.completed) of \(year.counted) days")

            GeometryReader { proxy in
                Dots(year: year, size: proxy.size)
            }
            .accessibilityHidden(true)
        }
    }
}

extension HabitYearView {
    // MARK: Lock Screen

    /// "Every habit done 12 days in a row", in a circle.
    fileprivate func streak(_ year: HabitYear) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -1) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(verbatim: "\(year.streak)")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.5)
                Text("days")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(4)
        }
        .widgetAccentable()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Every habit done \(year.streak) days in a row")
    }

    /// The last weeks as a small calendar, and the run of days and the year's count beside it.
    fileprivate func weeks(_ year: HabitYear) -> some View {
        HStack(spacing: 8) {
            WeekDots(weeks: year.recent(weeks: 8), today: year.todayDay.days(since: year.todayDay.weekStart, calendar: .current))
            VStack(alignment: .leading, spacing: 1) {
                Label {
                    Text(verbatim: "\(year.streak)").font(.headline)
                } icon: {
                    Image(systemName: "flame.fill").font(.caption)
                }
                .widgetAccentable()
                Text("in a row").font(.caption2).foregroundStyle(.secondary)
                Text(verbatim: "\(year.completed) this year").font(.caption2).foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Every habit done \(year.streak) days in a row, and on \(year.completed) days this year")
    }

    fileprivate func inline(_ year: HabitYear) -> some View {
        Label {
            Text(verbatim: "\(year.streak) days in a row · \(year.completed) this year")
        } icon: {
            Image(systemName: "flame")
        }
    }
}

/// A few weeks as columns of seven dots, Monday at the top. Today is a ring until it is done.
private struct WeekDots: View {
    var weeks: [[HabitYear.Mark?]]
    /// Today's row in the last column: 0 for Monday.
    var today: Int

    var body: some View {
        GeometryReader { proxy in
            let cell = proxy.size.height / 7
            let diameter = cell * 0.6
            let dots = { (wanted: (HabitYear.Mark?) -> Bool) in
                Path { path in
                    for (column, week) in weeks.enumerated() {
                        for (row, mark) in week.enumerated() where wanted(mark) && !(column == weeks.count - 1 && row == today) {
                            path.addEllipse(in: CGRect(x: (CGFloat(column) + 0.5) * cell - diameter / 2, y: (CGFloat(row) + 0.5) * cell - diameter / 2, width: diameter, height: diameter))
                        }
                    }
                }
            }
            let done = weeks.last?[today] == .complete
            ZStack(alignment: .topLeading) {
                dots { $0 == HabitYear.Mark.none || $0 == .future }.fill(Color.primary.opacity(0.15))
                dots { $0 == .missed }.fill(Color.primary.opacity(0.3))
                dots { $0 == .partial || $0 == .open }.fill(Color.primary.opacity(0.6))
                dots { $0 == .complete }.fill(Color.primary)
                Group {
                    if done {
                        Circle().fill(Color.primary)
                    } else {
                        Circle().stroke(Color.primary, lineWidth: max(1, diameter * 0.22))
                    }
                }
                .frame(width: diameter * 1.1, height: diameter * 1.1)
                .position(x: (CGFloat(weeks.count - 1) + 0.5) * cell, y: (CGFloat(today) + 0.5) * cell)
                .widgetAccentable()
            }
        }
        .aspectRatio(CGFloat(weeks.count) / 7, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// The dots, as one shape for each kind of day, so a whole year is a handful of views.
private struct Dots: View {
    var year: HabitYear
    var size: CGSize

    /// As many columns as make the dots largest in this space: twenty on the large widget, as a calendar's year usually is drawn.
    private var columns: Int {
        let count = year.marks.count
        return (8...60).max { a, b in cell(columns: a, count: count) < cell(columns: b, count: count) } ?? 20
    }

    private func cell(columns: Int, count: Int) -> CGFloat {
        let rows = (count + columns - 1) / columns
        return min(size.width / CGFloat(columns), size.height / CGFloat(rows))
    }

    private var step: CGSize {
        let rows = (year.marks.count + columns - 1) / columns
        let across = size.width / CGFloat(columns)
        return CGSize(width: across, height: min(size.height / CGFloat(rows), across))
    }

    private var diameter: CGFloat { min(step.width, step.height) * 0.32 }

    private func center(_ index: Int) -> CGPoint {
        CGPoint(x: (CGFloat(index % columns) + 0.5) * step.width, y: (CGFloat(index / columns) + 0.5) * step.height)
    }

    private func dots(_ mark: HabitYear.Mark) -> Path {
        Path { path in
            for (index, each) in year.marks.enumerated() where each == mark && index != year.today {
                let c = center(index)
                path.addEllipse(in: CGRect(x: c.x - diameter / 2, y: c.y - diameter / 2, width: diameter, height: diameter))
            }
        }
    }

    var body: some View {
        let today = center(year.today)
        let done = year.marks.indices.contains(year.today) && year.marks[year.today] == .complete
        ZStack(alignment: .topLeading) {
            dots(.none).fill(Color.primary.opacity(0.1))
            dots(.future).fill(Color.primary.opacity(0.2))
            dots(.missed).fill(Color.primary.opacity(0.22))
            dots(.open).fill(Color.primary.opacity(0.45))
            dots(.partial).fill(Color.primary.opacity(0.5))
            dots(.complete).fill(Color.primary)
            if done {
                Circle().fill(Color.orange)
                    .frame(width: diameter * 1.25, height: diameter * 1.25)
                    .position(today)
            } else {
                Circle().stroke(Color.orange, lineWidth: max(1, diameter * 0.3))
                    .frame(width: diameter * 1.25, height: diameter * 1.25)
                    .position(today)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}

struct HabitYearWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HabitYearWidget", provider: HabitYearProvider()) { entry in
            HabitYearView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Habit Year")
        .description("A dot for every day of the year, lit on the days you did all your habits. On the Lock Screen, how many such days in a row, and the last weeks.")
        .supportedFamilies([.systemLarge, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
