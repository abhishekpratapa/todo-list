// Quick capture from outside the app: a Shortcuts action, which also makes it
// available to Siri and the Action button. It takes one line, read by the Mac
// exactly as the app's own quick capture is.

import AppIntents
import TodosKit

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription(
        "Adds a task to Todos from one line, such as “Renew passport fri !high #personal”. If your Mac can’t be reached, the line is kept on this iPhone and added when it can.",
        categoryName: "Tasks"
    )
    static let openAppWhenRun = false

    @Parameter(title: "Task", description: "One line: a title, with an optional date, time, !priority, #project and @tags.", requestValueDialog: "What do you need to do?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to Todos")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { throw AddTaskError.empty }
        switch await AppModel.shared.captureFromOutside(line) {
        case .added:
            return .result(dialog: "Added to Todos.")
        case .waiting:
            return .result(dialog: "Saved. It will be added when your Mac can be reached.")
        case .notPaired:
            throw AddTaskError.notPaired
        case .refused(let message):
            throw AddTaskError.refused(message)
        }
    }
}

enum AddTaskError: Error, CustomLocalizedStringResourceConvertible {
    case empty, notPaired
    case refused(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .empty: "There was nothing to add."
        case .notPaired: "Open Todos and pair it with your Mac first."
        case .refused(let message): "Your Mac didn’t accept that: \(message)"
        }
    }
}

struct TodosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: ["Add a task in \(.applicationName)", "Add a \(.applicationName) task", "New task in \(.applicationName)"],
            shortTitle: "Add Task",
            systemImageName: "plus.circle"
        )
    }
}
