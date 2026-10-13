// The habits widget: what is still to do today, each with a button that checks
// off its next slot, and its streak. On the lock screen, what is left today.
//
// It reads the habits the app keeps in the shared container, with this iPhone's
// waiting check-ins on top and the day worked out for the moment it is drawn, so
// it shows what the app shows. Its button saves a check-in in the app's queue
// and then tries for a few seconds to send it to the Mac, which is why this
// extension may read the Mac's token. If that doesn't work the check-in still
// shows, and the app sends it later.

import AppIntents
import SwiftUI
import TodosKit
import UserNotifications
import WidgetKit

// MARK: Checking in

/// The button on the widget. It is not offered in Shortcuts: "Log Habit" in the app is.
struct CheckInHabitIntent: AppIntent {
    static let title: LocalizedStringResource = "Check In"
    static let description = IntentDescription("Checks in a habit from the Todos widget.")
    static let isDiscoverable = false

    @Parameter(title: "Habit")
    var habit: Int
    /// Empty for a habit counted in weeks, which has no slots.
    @Parameter(title: "Time of Day")
    var slot: String
    /// The habit day the widget was showing.
    @Parameter(title: "Day")
    var day: String

    init() {}

    init(habit: Int, slot: String?, day: Day) {
        self.habit = habit
        self.slot = slot ?? ""
        self.day = day.description
    }

    func perform() async throws -> some IntentResult {
        let client = (try? KeychainCredentialStore.shared.load()).map { HubClient(credentials: $0) }
        let result = await WidgetCheckIn.perform(habit: habit, slot: slot.isEmpty ? nil : slot, day: Day(day), in: SharedContainer.currentHubDirectory(), client: client)
        // It is done, so nothing should remind about it. The app does this too when it next runs.
        if let day = result.day {
            let ids = WidgetCheckIn.notifications(habit: habit, slot: result.slot, day: day)
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
        return .result()
    }
}

// MARK: What it shows

struct HabitsEntry: TimelineEntry, Sendable {
    enum State: Sendable, Equatable {
        case notPaired
        /// The Todos on the Mac is older than habits.
        case unsupported
        case habits([Habit])
    }

    var date: Date
    var state: State

    var habits: [Habit] {
        if case .habits(let habits) = state { return habits }
        return []
    }

    static let sample: HabitsEntry = {
        let today = HabitClock.day(of: Date(), zone: .current, dayStart: .defaultDayStart)
        func twice(_ id: Int, _ name: String, _ icon: String, _ color: HabitColor, streak: Int, morning: Bool) -> Habit {
            let slots = [HabitSlot(id: "morning", name: "Morning", remind: ClockTime("07:30")), HabitSlot(id: "evening", name: "Evening", remind: ClockTime("21:30"))]
            return Habit(id: id, name: name, icon: icon, color: color, schedule: .daily(slots: slots),
                         today: HabitDay(day: today, state: .open, slots: [.init(id: "morning", done: morning), .init(id: "evening")]),
                         yesterday: HabitDay(day: today.adding(days: -1), state: .done), streak: HabitStreak(current: streak, best: streak, unit: .days))
        }
        let gym = Habit(id: 3, name: "Gym", icon: "🏋️", color: .orange, schedule: .weekly(target: 3, remind: nil),
                        today: HabitDay(day: today, state: .open, isSession: true), yesterday: HabitDay(day: today.adding(days: -1), state: .open, isSession: true),
                        week: HabitWeek(start: today.weekStart, state: .open, count: 1, target: 3, days: []), streak: HabitStreak(current: 4, best: 6, unit: .weeks))
        return HabitsEntry(date: Date(), state: .habits([twice(1, "Brush teeth", "🪥", .blue, streak: 12, morning: true), twice(2, "Floss", "🧵", .mint, streak: 5, morning: false), gym]))
    }()

    /// What the habits on this iPhone say, worked out for `date`.
    static func current(at date: Date) -> HabitsEntry {
        guard let folder = SharedContainer.currentHubDirectory() else { return HabitsEntry(date: date, state: .notPaired) }
        let kept = LocalStore.readHabits(directory: folder)
        guard kept.supported != false else { return HabitsEntry(date: date, state: .unsupported) }
        let changes = LocalStore.read(directory: folder).changes
        return HabitsEntry(date: date, state: .habits(kept.habits.reckoned(with: changes, now: date)))
    }
}

struct HabitsProvider: TimelineProvider {
    func placeholder(in context: Context) -> HabitsEntry {
        .sample
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (HabitsEntry) -> Void) {
        completion(context.isPreview ? .sample : .current(at: Date()))
    }

    /// Drawn now, and again when each habit's day turns over (3 AM unless changed), when
    /// what is "today" becomes another day. The app reloads it whenever anything changes.
    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<HabitsEntry>) -> Void) {
        let now = Date()
        let first = HabitsEntry.current(at: now)
        let turns = Set(first.habits.compactMap { HabitClock.end(of: $0.today.day, zone: .current, dayStart: $0.dayStart) }.filter { $0 > now }).sorted()
        let entries = [first] + turns.map { HabitsEntry.current(at: $0.addingTimeInterval(1)) }
        completion(Timeline(entries: entries, policy: .after((turns.last ?? now.addingTimeInterval(6 * 3600)).addingTimeInterval(60))))
    }
}

// MARK: Views

struct HabitsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: HabitsEntry

    private static let accent = Color(red: 0x55 / 255, green: 0x50 / 255, blue: 0xD8 / 255)

    var body: some View {
        Group {
            switch entry.state {
            case .notPaired:
                message("Open Todos to connect it to your Mac.")
            case .unsupported:
                message("Habits need a newer Todos on your Mac.")
            case .habits(let habits) where habits.isEmpty:
                message("No habits yet. Add one in Todos.")
            case .habits(let habits):
                let today = habits.forToday()
                switch family {
                case .accessoryInline: inline(habits)
                case .accessoryCircular: circular(habits)
                case .accessoryRectangular: lockScreen(habits, today.due)
                case .systemSmall: small(habits, today.due)
                case .systemLarge: rows(habits, today.due + today.done, showing: 7)
                default: rows(habits, today.due + today.done, showing: 3)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    private func left(_ habits: [Habit]) -> String {
        let count = habits.leftToday
        return count == 0 ? "All done today" : "\(count) left today"
    }

    // MARK: Lock screen

    private func inline(_ habits: [Habit]) -> some View {
        Label(left(habits), systemImage: habits.leftToday == 0 ? "checkmark.circle" : "flame")
    }

    private func circular(_ habits: [Habit]) -> some View {
        let expected = habits.filter { $0.isDueToday || $0.isDoneToday }
        let total = expected.reduce(0) { $0 + $1.today.total }
        let done = expected.reduce(0) { $0 + $1.today.done }
        return Gauge(value: Double(done), in: 0...Double(max(total, 1))) {
            Image(systemName: "flame.fill")
        } currentValueLabel: {
            Text("\(habits.leftToday)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .accessibilityLabel(left(habits))
    }

    private func lockScreen(_ habits: [Habit], _ due: [Habit]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(left(habits)).font(.headline).widgetAccentable()
            ForEach(due.prefix(2)) { habit in
                Text("\(habit.name)\(next(habit).map { " · \($0)" } ?? "")").font(.footnote).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The slot a habit's button would check off, by name. Nil when it has one unnamed slot or none.
    private func next(_ habit: Habit) -> String? {
        guard let slot = habit.slotToCheckIn(at: entry.date), let name = habit.slot(slot)?.name, !name.isEmpty else { return nil }
        return name
    }

    // MARK: Home screen

    /// The next thing to do, large, with its button.
    private func small(_ habits: [Habit], _ due: [Habit]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let habit = due.first {
                HStack(alignment: .top) {
                    icon(habit, size: 30)
                    Spacer(minLength: 0)
                    if habit.streak.current > 0 { streak(habit) }
                }
                Text(habit.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(next(habit) ?? HabitText.progress(habit)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
                HStack {
                    Text(due.count > 1 ? "+\(due.count - 1) more" : "").font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    check(habit, size: .title)
                }
            } else {
                Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
                Text("All done today").font(.subheadline.weight(.semibold))
                if let best = habits.map(\.streak.current).max(), best > 0 {
                    Text("Longest streak: \(best)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(due.first.map { AppLinks.habit($0.id) })
    }

    /// A row a habit: its name, how today stands, its streak, and its button.
    private func rows(_ habits: [Habit], _ listed: [Habit], showing limit: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(left(habits)).font(.subheadline.weight(.bold)).foregroundStyle(habits.leftToday == 0 ? Color.green : Self.accent)
                Spacer(minLength: 0)
                if family == .systemLarge {
                    Text(entry.date, format: .dateTime.weekday(.wide).month().day()).font(.footnote).foregroundStyle(.secondary)
                }
            }
            ForEach(listed.prefix(limit)) { habit in
                HStack(spacing: 8) {
                    Link(destination: AppLinks.habit(habit.id)) {
                        HStack(spacing: 8) {
                            icon(habit, size: 26)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(habit.name).font(.subheadline).lineLimit(1)
                                Text(HabitText.progress(habit)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            if habit.streak.current > 0 { streak(habit) }
                        }
                    }
                    check(habit, size: .title2)
                }
            }
            if listed.count > limit {
                Text("and \(listed.count - limit) more").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Pieces

    private func icon(_ habit: Habit, size: CGFloat) -> some View {
        ZStack {
            Circle().fill(habit.color.tint.opacity(0.2))
            if let icon = habit.icon, !icon.isEmpty {
                Text(verbatim: icon).font(.system(size: size * 0.52))
            } else {
                Image(systemName: "flame.fill").font(.system(size: size * 0.45)).foregroundStyle(habit.color.tint)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func streak(_ habit: Habit) -> some View {
        HStack(spacing: 1) {
            Image(systemName: "flame.fill")
            Text("\(habit.streak.current)").monospacedDigit()
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(habit.streak.atRisk == nil ? Color.orange : Color.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Streak: \(HabitText.length(habit.streak.current, habit.streak.unit))")
    }

    /// The button that checks off the habit's next slot, or a tick when today asks no more of it.
    @ViewBuilder
    private func check(_ habit: Habit, size: Font) -> some View {
        if habit.isDueToday {
            Button(intent: CheckInHabitIntent(habit: habit.id, slot: habit.slotToCheckIn(at: entry.date), day: habit.today.day)) {
                Image(systemName: "circle")
                    .font(size)
                    .foregroundStyle(habit.color.tint)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Check in \(habit.name)\(next(habit).map { ", \($0)" } ?? "")")
        } else {
            Image(systemName: habit.isDoneToday ? "checkmark.circle.fill" : "minus.circle")
                .font(size)
                .foregroundStyle(habit.isDoneToday ? habit.color.tint : Color.secondary)
                .accessibilityLabel(habit.isDoneToday ? "Done" : "Not today")
        }
    }
}

extension HabitColor {
    var tint: Color {
        switch self {
        case .red: .red
        case .orange: .orange
        case .yellow: .yellow
        case .green: .green
        case .mint: .mint
        case .teal: .teal
        case .blue: .blue
        case .indigo: .indigo
        case .purple: .purple
        case .pink: .pink
        case .gray: .gray
        }
    }
}

struct HabitsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HabitsWidget", provider: HabitsProvider()) { entry in
            HabitsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Habits")
        .description("What is left today, with a button to check each off, and your streaks.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}
