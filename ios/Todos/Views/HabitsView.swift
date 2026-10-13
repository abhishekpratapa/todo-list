// Habits: what is still to do today, soonest first, each checked in with one
// tap; then what is done; then what expects nothing today.

import SwiftUI
import TodosKit

struct HabitsView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingSettings: Bool
    @State private var adding: HabitDraft?
    @State private var path: [Int] = []

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Habits")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: Int.self) { HabitDetailView(habitID: $0) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showingSettings = true } label: {
                            Image(systemName: model.issue != nil ? "exclamationmark.triangle.fill" : "gearshape")
                                .foregroundStyle(model.issue != nil ? Color.orange : Color.accentColor)
                        }
                        .accessibilityLabel("Settings")
                    }
                    if model.habitsSupported == true {
                        ToolbarItem(placement: .topBarTrailing) { addMenu }
                    }
                }
        }
        .sheet(item: $adding) { HabitEditorView(draft: $0) }
        // Habits with reminder times need iOS's leave to remind. Asked once, when there are some.
        .task(id: model.habits.map(\.id)) { await Reminders.shared.askForHabits(model.habits, tasks: model.tasks) }
        // A new day can begin while this is on screen.
        .task {
            while !Task.isCancelled {
                model.reckonHabits()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        // A reminder or the widget was tapped: go to that habit.
        .onChange(of: model.requestedHabit, initial: true) { _, habit in
            guard let habit else { return }
            model.requestedHabit = nil
            adding = nil
            path = [habit]
        }
    }

    private var addMenu: some View {
        Menu {
            Button("Twice a Day") { adding = .twiceADay() }
            Button("Every Day") { adding = .everyDay() }
            Button("3 Times a Week") { adding = .timesAWeek(3) }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("New habit")
    }

    @ViewBuilder
    private var content: some View {
        if model.habitsSupported == false {
            ContentUnavailableView {
                Label("Update Todos on Your Mac", systemImage: "arrow.down.circle")
            } description: {
                Text("Habits need a newer version of Todos on your Mac than the one it is running\(model.macVersion.map { " (\($0))" } ?? ""). Your tasks work as before.")
            }
        } else if model.habits.isEmpty {
            ContentUnavailableView {
                Label(model.hasLoaded ? "No Habits Yet" : "Loading", systemImage: "flame")
            } description: {
                Text(model.hasLoaded ? "A habit is a routine to check in on, with a streak to keep. Start with one of these." : "Fetching your habits from your Mac.")
            } actions: {
                if model.habitsSupported == true {
                    Button("Twice a Day") { adding = .twiceADay() }.buttonStyle(.borderedProminent)
                    Button("Every Day") { adding = .everyDay() }
                    Button("3 Times a Week") { adding = .timesAWeek(3) }
                }
            }
        } else {
            list
        }
    }

    private var list: some View {
        let today = model.habits.forToday()
        let atRisk = model.habits.filter { $0.streak.atRisk != nil && $0.streak.current > 0 }
        return List {
            if let issue = model.issue, model.hasLoaded {
                Section {
                    Button { showingSettings = true } label: { IssueBanner(issue: issue) }
                        .buttonStyle(.plain)
                }
            }
            if !atRisk.isEmpty {
                Section {
                    ForEach(atRisk) { habit in
                        NavigationLink(value: habit.id) { HabitRow(habit: habit, day: .yesterday) }
                    }
                } header: {
                    Text("Still time for yesterday")
                } footer: {
                    Text("Yesterday can be logged until today ends.")
                }
            }
            if !today.due.isEmpty {
                Section("To do today · \(today.due.count)") {
                    ForEach(today.due) { habit in
                        NavigationLink(value: habit.id) { HabitRow(habit: habit) }
                    }
                }
            }
            if !today.done.isEmpty {
                Section("Done · \(today.done.count)") {
                    ForEach(today.done) { habit in
                        NavigationLink(value: habit.id) { HabitRow(habit: habit) }
                    }
                }
            }
            if !today.off.isEmpty {
                Section("Not today") {
                    ForEach(today.off) { habit in
                        NavigationLink(value: habit.id) { HabitRow(habit: habit) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.retry() }
    }
}

/// One habit in the list: its name, how the day stands, its streak, and a button
/// for each slot. A slot is checked in with one tap, and tapped again to take it back.
struct HabitRow: View {
    enum Which {
        case today, yesterday
    }

    @Environment(AppModel.self) private var model
    var habit: Habit
    var day: Which = .today

    var body: some View {
        HStack(spacing: 12) {
            HabitIcon(habit: habit)
            VStack(alignment: .leading, spacing: 3) {
                Text(habit.name)
                    .font(.body)
                    .foregroundStyle(.primary)
                Text(day == .yesterday ? (HabitText.atRisk(habit) ?? "Yesterday") : HabitText.progress(habit))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if model.hasWaitingChanges(habit: habit.id) {
                Image(systemName: "clock")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Waiting to be sent to your Mac")
            }
            if day == .today, habit.streak.current > 0 {
                StreakBadge(streak: habit.streak)
            }
            SlotButtons(habit: habit, day: day)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

/// The habit's emoji on its color, or a flame if it has none.
struct HabitIcon: View {
    var habit: Habit
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            Circle().fill(habit.color.tint.opacity(0.18))
            if let icon = habit.icon, !icon.isEmpty {
                Text(verbatim: icon).font(.system(size: size * 0.5))
            } else {
                Image(systemName: "flame.fill")
                    .font(.system(size: size * 0.42))
                    .foregroundStyle(habit.color.tint)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A flame and how long the streak is.
struct StreakBadge: View {
    var streak: HabitStreak

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "flame.fill")
            Text("\(streak.current)")
                .monospacedDigit()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(streak.atRisk == nil ? Color.orange : Color.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Streak: \(HabitText.length(streak.current, streak.unit))\(streak.atRisk == nil ? "" : ", at risk")")
    }
}

/// A round button for each slot of the day (one, for a habit counted in weeks).
/// Tap to check in; tap a checked one to take it back.
struct SlotButtons: View {
    @Environment(AppModel.self) private var model
    var habit: Habit
    var day: HabitRow.Which = .today
    var labelled = false

    private var shown: HabitDay { day == .today ? habit.today : habit.yesterday }
    private var isYesterday: Bool { day == .yesterday }

    var body: some View {
        HStack(spacing: labelled ? 16 : 6) {
            if shown.isSession {
                button(done: shown.state == .done, name: isYesterday ? "Yesterday" : "Today", slot: nil)
            } else {
                ForEach(shown.slots) { slot in
                    button(done: slot.done, name: habit.slotName(slot.id), slot: slot.id)
                }
            }
        }
    }

    private func button(done: Bool, name: String, slot: String?) -> some View {
        Button {
            Task {
                if done {
                    await model.undoCheckIn(habit, slot: slot, yesterday: isYesterday)
                } else {
                    await model.checkIn(habit, slot: slot, yesterday: isYesterday)
                }
            }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(labelled ? .largeTitle : .title2)
                    .foregroundStyle(done ? habit.color.tint : Color.secondary)
                    .contentTransition(.symbolEffect(.replace))
                if labelled {
                    Text(name).font(.caption).foregroundStyle(Color.secondary)
                }
            }
            .frame(minWidth: 34, minHeight: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .sensoryFeedback(.success, trigger: done) { _, now in now }
        .accessibilityLabel("\(habit.name)\(shown.isSession || shown.slots.count == 1 ? "" : ", \(name)")\(isYesterday ? ", yesterday" : "")")
        .accessibilityValue(done ? "Done" : "Not done")
        .accessibilityHint(done ? "Takes the check-in back" : "Checks in")
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

    var label: String { rawValue.capitalized }
}

extension HabitDraft: @retroactive Identifiable {
    /// A draft is only ever shown one at a time, in a sheet.
    public var id: String { "draft" }
}
