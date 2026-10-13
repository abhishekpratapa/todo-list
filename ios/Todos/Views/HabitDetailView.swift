// One habit: today and yesterday, the streak, a calendar of how the days went,
// and what can be done with it (a rest day, a pause, an edit).

import SwiftUI
import TodosKit

struct HabitDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var habitID: Int

    @State private var history: HabitHistory?
    @State private var editing: HabitDraft?
    @State private var confirmingDelete = false
    @State private var failure: String?

    var body: some View {
        Group {
            if let habit = model.habit(habitID) {
                detail(habit)
            } else {
                ContentUnavailableView("No Longer Here", systemImage: "flame", description: Text("This habit was archived or deleted."))
            }
        }
        .navigationTitle(model.habit(habitID)?.name ?? "Habit")
        .navigationBarTitleDisplayMode(.inline)
        .alert("That Didn’t Work", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private func detail(_ habit: Habit) -> some View {
        List {
            Section {
                header(habit)
                if let ended = HabitText.ended(habit) {
                    Label(ended, systemImage: "sunrise")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                dayRow(habit, .today)
                if showsYesterday(habit) { dayRow(habit, .yesterday) }
            } footer: {
                if let risk = HabitText.atRisk(habit) { Text(risk) }
            }

            Section {
                calendar(habit)
            } header: {
                Text("History")
            } footer: {
                Text("Done \(HabitText.rate(habit.rates.d7)) of the last 7 days, \(HabitText.rate(habit.rates.d30)) of the last 30, \(HabitText.rate(habit.rates.d365)) of the last year. Rest days and pauses are left out.")
            }

            Section {
                LabeledContent("Schedule", value: HabitText.schedule(habit.schedule))
                if habit.dayStart != .defaultDayStart {
                    LabeledContent("Day starts at", value: habit.dayStart.formatted())
                }
                Button("Edit Habit") { editing = HabitDraft(habit) }
            }

            Section {
                skipButton(habit)
                Button(habit.paused ? "Resume" : "Pause") { act { await model.setHabit(habit, paused: !habit.paused) } }
            } footer: {
                Text(habit.paused
                     ? "A paused habit expects nothing, and its streak waits for you."
                     : "A rest day neither breaks your streak nor adds to it. For a longer break, pause: the streak waits.")
            }

            Section {
                Button("Archive") { act(thenLeave: true) { await model.setHabit(habit, archived: true) } }
                Button("Delete Habit", role: .destructive) { confirmingDelete = true }
            } footer: {
                Text("Archiving puts a habit away and keeps its history. Deleting removes the history too.")
            }
        }
        .listStyle(.insetGrouped)
        .task(id: habit.today) { history = await model.history(of: habit) ?? history }
        .sheet(item: $editing) { HabitEditorView(draft: $0, editing: habit) }
        .confirmationDialog("Delete “\(habit.name)”?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete Habit and Its History", role: .destructive) { act(thenLeave: true) { await model.deleteHabit(habit) } }
        } message: {
            Text("Every check-in goes with it, from your Mac too. This can’t be undone. To keep the history, archive it instead.")
        }
    }

    /// Runs something that needs the Mac, and says so if it fails.
    private func act(thenLeave: Bool = false, _ work: @escaping () async -> String?) {
        Task {
            failure = await work()
            if failure == nil, thenLeave { dismiss() }
        }
    }

    private func header(_ habit: Habit) -> some View {
        HStack(spacing: 14) {
            HabitIcon(habit: habit, size: 52)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "flame.fill").foregroundStyle(habit.streak.current > 0 ? Color.orange : Color.secondary)
                    Text(HabitText.length(habit.streak.current, habit.streak.unit)).font(.title2.weight(.bold))
                }
                Text("Best: \(HabitText.length(habit.streak.best, habit.streak.unit))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Streak: \(HabitText.length(habit.streak.current, habit.streak.unit)). Best: \(HabitText.length(habit.streak.best, habit.streak.unit)).")
    }

    /// Yesterday is worth showing while something can still be logged for it.
    private func showsYesterday(_ habit: Habit) -> Bool {
        habit.isWeekly ? habit.yesterday.state != .done && habit.lastWeekOrThis(of: habit.yesterday.day)?.state == .open : habit.yesterday.state == .open
    }

    private func dayRow(_ habit: Habit, _ which: HabitRow.Which) -> some View {
        let day = which == .today ? habit.today : habit.yesterday
        return HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(which == .today ? "Today" : "Yesterday")
                Text(which == .today ? HabitText.progress(habit) : "Logged late, it still counts")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if day.state == .off || habit.paused {
                Text(habit.paused ? "Paused" : "Not scheduled").foregroundStyle(.secondary)
            } else {
                SlotButtons(habit: habit, day: which, labelled: true)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func skipButton(_ habit: Habit) -> some View {
        let skipped = habit.isWeekly ? habit.week?.state == .skipped : habit.today.state == .skipped
        let what = habit.isWeekly ? "This Week" : "Today"
        if skipped {
            Button("Undo Rest \(habit.isWeekly ? "Week" : "Day")") { Task { await model.undoSkip(habit) } }
        } else if habit.isDueToday {
            Button("Skip \(what)") { Task { await model.skip(habit) } }
                .disabled(habit.skipsLeft == 0)
            if habit.skipsLeft == 0 {
                Text(habit.isWeekly ? "One week in any four can be skipped, and that one is used." : "Two days in any seven and six in any thirty can be skipped, and those are used.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func calendar(_ habit: Habit) -> some View {
        if let history {
            HabitCalendar(history: history, tint: habit.color.tint)
        } else {
            Text("The calendar is drawn from your Mac’s record, and it can’t be reached just now.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private extension Habit {
    /// The week a day is in, if it is this week or last.
    func lastWeekOrThis(of day: Day) -> HabitWeek? {
        [week, lastWeek].compactMap { $0 }.first { $0.start == day.weekStart }
    }
}

/// A grid of the last weeks, a column a week from Monday down to Sunday, each day
/// colored by how it went. The newest week is on the right.
struct HabitCalendar: View {
    var history: HabitHistory
    var tint: Color
    private let weeksShown = 18

    var body: some View {
        let last = history.today.weekStart
        let weeks = (0..<weeksShown).reversed().map { last.adding(days: -7 * $0) }
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 3) {
                ForEach(weeks, id: \.self) { week in
                    VStack(spacing: 3) {
                        ForEach(0..<7, id: \.self) { offset in
                            cell(history.mark(for: week.adding(days: offset)))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            HStack(spacing: 10) {
                legend("d", "Done")
                legend("p", "Part")
                legend("x", "Missed")
                legend("s", "Rest")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
    }

    private func legend(_ mark: Character, _ name: String) -> some View {
        HStack(spacing: 4) {
            cell(mark).frame(width: 11, height: 11)
            Text(name)
        }
    }

    private func cell(_ mark: Character?) -> some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(fill(mark))
            .overlay {
                if mark == "s" { RoundedRectangle(cornerRadius: 3).strokeBorder(tint.opacity(0.6), lineWidth: 1) }
                if mark == "o" { RoundedRectangle(cornerRadius: 3).strokeBorder(Color.secondary.opacity(0.5), lineWidth: 1) }
            }
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 16)
    }

    private func fill(_ mark: Character?) -> Color {
        switch mark {
        case "d": tint
        case "p": tint.opacity(0.4)
        case "x": Color.secondary.opacity(0.28)
        case ".", "s", "o": Color.secondary.opacity(0.07)
        default: .clear // still to come, or before the stretch that was fetched
        }
    }

    /// For VoiceOver: the last 30 days in a sentence.
    private var summary: String {
        let recent = (0..<30).compactMap { history.mark(for: history.today.adding(days: -$0)) }
        func count(_ mark: Character) -> Int { recent.filter { $0 == mark }.count }
        return "The last 30 days: \(count("d")) done, \(count("p")) partly done, \(count("x")) missed, \(count("s")) rest days."
    }
}
