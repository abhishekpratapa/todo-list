// Small editing controls the detail screen is built from.

import SwiftUI
import TodosKit

/// A text field for a value that lives elsewhere. It keeps its own draft while being
/// edited, saves when Return is pressed or focus moves away, and follows the value
/// when that changes underneath it (a live update) unless it is being edited.
struct CommitField: View {
    var prompt: String
    var value: String
    var axis: Axis = .horizontal
    var autocapitalization: TextInputAutocapitalization = .sentences
    var onCommit: (String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField(prompt, text: $draft, axis: axis)
            .focused($focused)
            .textInputAutocapitalization(autocapitalization)
            .submitLabel(.done)
            .onAppear { draft = value }
            .onChange(of: value) { _, new in
                if !focused { draft = new }
            }
            .onChange(of: focused) { _, isFocused in
                if !isFocused { commit() }
            }
            .onSubmit { focused = false }
    }

    private func commit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != value { onCommit(trimmed) }
        draft = trimmed.isEmpty ? value : trimmed
    }
}

/// A date that may be absent: "Add" when there is none, a picker and a clear button when there is.
/// The picker sits beside the title when there is room, and under it when there isn't
/// (a date with a time, or large text).
struct OptionalDateRow: View {
    var title: String
    var symbol: String
    var date: Date?
    var components: DatePickerComponents
    /// What "Add" starts from.
    var initial: () -> Date
    var onChange: (Date?) -> Void

    var body: some View {
        if let date {
            let picker = DatePicker(title, selection: Binding(get: { date }, set: { onChange($0) }), displayedComponents: components)
                .labelsHidden()
            let clear = Button { onChange(nil) } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Clear \(title.lowercased())")

            ViewThatFits(in: .horizontal) {
                HStack {
                    Label(title, systemImage: symbol).fixedSize()
                    Spacer(minLength: 12)
                    picker.fixedSize()
                    clear
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label(title, systemImage: symbol)
                        Spacer()
                        clear
                    }
                    picker
                }
            }
        } else {
            Button { onChange(initial()) } label: {
                Label("Add \(title)", systemImage: symbol)
            }
        }
    }
}

extension Date {
    /// Nine o'clock tomorrow morning: where a new reminder starts.
    static var tomorrowMorning: Date {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}

enum TagText {
    /// "errand, travel" or "#errand @travel" to ["errand", "travel"], the way the Mac stores tags.
    static func tags(from text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "#@")).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
