// Quick capture: one line, read by the Mac exactly as its own capture box reads it
// ("Renew passport fri !high #personal"). What it understood shows as you type.

import SwiftUI
import TodosKit

struct QuickCaptureView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var line = ""
    @State private var parsed: ParsedCapture?
    @State private var adding = false
    @FocusState private var focused: Bool

    private var trimmed: String { line.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                TextField("New task", text: $line, axis: .vertical)
                    .font(.title3)
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.done)
                    // Return adds the task. Depending on the iOS version a multi-line field
                    // either submits or types a line break, so both are handled.
                    .onSubmit(add)
                    .onChange(of: line) { _, new in
                        if new.contains("\n") {
                            line = new.replacingOccurrences(of: "\n", with: " ")
                            add()
                        }
                    }
                    .accessibilityLabel("New task")

                if let parsed, !trimmed.isEmpty {
                    CapturePreview(parsed: parsed)
                } else if model.issue != nil {
                    Label("Your Mac can’t be reached. It will read this line, dates and all, as soon as it can.", systemImage: "clock")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text(verbatim: "Try “Renew passport fri !high #personal” or “Call dentist tomorrow 3pm”.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Quick Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: add)
                        .disabled(trimmed.isEmpty || adding)
                }
            }
        }
        .presentationDetents([.height(250), .large])
        .onAppear { focused = true }
        .task(id: trimmed) {
            guard !trimmed.isEmpty else {
                parsed = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(250)) // wait for a pause in typing
            guard !Task.isCancelled else { return }
            parsed = await model.preview(trimmed)
        }
    }

    private func add() {
        let text = trimmed
        guard !text.isEmpty, !adding else { return }
        adding = true
        dismiss() // it is saved on this iPhone at once; sending it doesn't need this sheet
        Task { await model.capture(text) }
    }
}

/// What the Mac made of the line: the title, and a chip for each thing it picked out.
struct CapturePreview: View {
    var parsed: ParsedCapture

    var body: some View {
        let today = Day.today()
        VStack(alignment: .leading, spacing: 8) {
            Text(parsed.title.isEmpty ? "A task needs a title" : parsed.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(parsed.title.isEmpty ? .red : .primary)
            let chips = chips(today)
            if !chips.isEmpty {
                chips.dropFirst().reduce(chips[0]) { Text("\($0)   \($1)") }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Will add: \(parsed.title)")
    }

    private func chips(_ today: Day) -> [Text] {
        let fields = parsed.fields
        var out: [Text] = []
        if let due = fields.due { out.append(Text("\(Image(systemName: "calendar")) \(due.label(relativeTo: today))")) }
        if let remind = fields.remindAt { out.append(Text("\(Image(systemName: "bell")) \(remind.formatted(date: .omitted, time: .shortened))")) }
        if let repeats = fields.repeats { out.append(Text("\(Image(systemName: "repeat")) \(repeats.label)")) }
        if let priority = fields.priority { out.append(Text("\(Image(systemName: "flag")) \(priority.label)")) }
        if let project = fields.project { out.append(Text("#\(project)")) }
        for tag in fields.tags ?? [] { out.append(Text("@\(tag)")) }
        if fields.assignee == .claude { out.append(Text("\(Image(systemName: "sparkles")) Claude")) }
        return out
    }
}
