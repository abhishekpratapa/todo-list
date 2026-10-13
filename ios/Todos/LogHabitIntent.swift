// Checking in a habit from outside the app: a Shortcuts action, which also makes
// it available to Siri ("Log Brush teeth in Todos") and to automations, such as
// one that runs when a workout ends. It goes through the same queue as a
// check-in made in the app, so it is kept if the Mac can't be reached.

import AppIntents
import TodosKit

/// A habit, as Shortcuts and Siri know it: by its name.
struct HabitEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Habit"
    static let defaultQuery = HabitQuery()

    var id: Int
    var name: String
    var icon: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\([icon, name].compactMap { $0 }.joined(separator: " "))")
    }
}

/// Finds habits among the ones this iPhone keeps. It needs no connection.
struct HabitQuery: EntityStringQuery {
    private func all() -> [HabitEntity] {
        guard let folder = SharedContainer.currentHubDirectory() else { return [] }
        return LocalStore.readHabits(directory: folder).habits.map { HabitEntity(id: $0.id, name: $0.name, icon: $0.icon) }
    }

    func entities(for identifiers: [Int]) async throws -> [HabitEntity] {
        all().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [HabitEntity] {
        all().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [HabitEntity] {
        all()
    }
}

struct LogHabitIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Habit"
    static let description = IntentDescription(
        "Checks in a habit in Todos, such as brushing your teeth or a visit to the gym. If your Mac can’t be reached, the check-in is kept on this iPhone and sent when it can.",
        categoryName: "Habits"
    )
    static let openAppWhenRun = false

    @Parameter(title: "Habit", requestValueDialog: "Which habit?")
    var habit: HabitEntity

    @Parameter(title: "Time of Day", description: "Which time of day, such as Morning or Evening. Leave it empty for whichever is still to do.")
    var slot: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Log \(\.$habit)") {
            \.$slot
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let named = slot.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        switch await AppModel.shared.checkInFromOutside(habit: habit.id, slot: named, source: .shortcut) {
        case .checkedIn:
            return .result(dialog: "\(LogHabitText.logged(AppModel.shared.habit(habit.id), name: habit.name, waiting: AppModel.shared.hasWaitingChanges(habit: habit.id)))")
        case .alreadyDone:
            return .result(dialog: "\(habit.name) is already done for today.")
        case .noSuchSlot(let slots):
            throw LogHabitError.noSuchSlot(habit.name, slots)
        case .tooLate, .notFound:
            throw LogHabitError.notFound(habit.name)
        case .notPaired:
            throw LogHabitError.notPaired
        }
    }
}

enum LogHabitText {
    /// What to say once a habit is checked in: how the day stands now, and the streak if there is one.
    static func logged(_ habit: Habit?, name: String, waiting: Bool) -> String {
        guard let habit else { return "Logged \(name)." }
        var said = "Logged \(name)."
        if let week = habit.week {
            said += week.state == .met ? " That’s \(week.count) of \(week.target) this week: done." : " That’s \(week.count) of \(week.target) this week."
        } else if habit.today.isComplete {
            said += habit.streak.current > 1 ? " That’s today done, and \(HabitText.length(habit.streak.current, habit.streak.unit)) in a row." : " That’s today done."
        } else {
            let left = habit.today.remaining.map { habit.slotName($0.id).lowercased() }
            said += " Still to do today: \(left.formatted(.list(type: .and)))."
        }
        return waiting ? said + " It will reach your Mac when it can be reached." : said
    }
}

enum LogHabitError: Error, CustomLocalizedStringResourceConvertible {
    case notPaired
    case notFound(String)
    case noSuchSlot(String, [String])

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notPaired: "Open Todos and pair it with your Mac first."
        case .notFound(let name): "Todos has no habit called \(name) on this iPhone any more."
        case .noSuchSlot(let name, let slots): "\(name) has no such time of day. It has: \(slots.formatted(.list(type: .and)))."
        }
    }
}
