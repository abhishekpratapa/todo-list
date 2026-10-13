// The form for a new habit, or an edit to one: its name, icon and color, when it
// is done, and when to be reminded. Saving needs the Mac.

import SwiftUI
import TodosKit

struct HabitEditorView: View {
    enum Kind: String, CaseIterable, Identifiable {
        case daily = "Every Day"
        case days = "Certain Days"
        case weekly = "Days a Week"

        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: HabitDraft
    @State private var kind: Kind
    // Each kind keeps what was entered for it, so switching back and forth loses nothing.
    @State private var slots: [EditableSlot]
    @State private var days: Set<Weekday>
    @State private var target: Int
    @State private var weeklyReminder: Bool
    @State private var reminderDays: Set<Weekday>
    @State private var reminderTime: ClockTime
    @State private var saving = false
    @State private var failure: String?
    private let editing: Habit?

    init(draft: HabitDraft, editing: Habit? = nil) {
        self.editing = editing
        _draft = State(initialValue: draft)
        var slots = [HabitSlot(name: "", remind: ClockTime("09:00"))]
        var days: Set<Weekday> = [.mon, .wed, .fri]
        var target = 3
        var reminder: HabitSchedule.WeeklyReminder?
        switch draft.schedule {
        case .daily(let its):
            _kind = State(initialValue: .daily)
            slots = its
        case .days(let on, let its):
            _kind = State(initialValue: .days)
            days = Set(on)
            slots = its
        case .weekly(let its, let remind):
            _kind = State(initialValue: .weekly)
            target = its
            reminder = remind
        }
        _slots = State(initialValue: slots.map { EditableSlot(slot: $0) })
        _days = State(initialValue: days)
        _target = State(initialValue: target)
        _weeklyReminder = State(initialValue: reminder != nil)
        _reminderDays = State(initialValue: Set(reminder?.days ?? [.mon, .wed, .fri]))
        _reminderTime = State(initialValue: reminder?.time ?? ClockTime("17:30")!)
    }

    /// The schedule as the form stands.
    private var schedule: HabitSchedule {
        let ordered = Weekday.allCases
        switch kind {
        case .daily: return .daily(slots: slots.map(\.slot))
        case .days: return .days(ordered.filter(days.contains), slots: slots.map(\.slot))
        case .weekly: return .weekly(target: target, remind: weeklyReminder ? .init(days: ordered.filter(reminderDays.contains), time: reminderTime) : nil)
        }
    }

    /// A habit counted in days can't become one counted in weeks, or the other way
    /// round: its streak would mean nothing. So an edit offers only its own kinds.
    private var kinds: [Kind] {
        guard let editing else { return Kind.allCases }
        return editing.isWeekly ? [.weekly] : [.daily, .days]
    }

    private var canSave: Bool {
        let named = !draft.name.trimmingCharacters(in: .whitespaces).isEmpty
        switch kind {
        case .daily: return named && !slots.isEmpty
        case .days: return named && !slots.isEmpty && !days.isEmpty
        case .weekly: return named && (!weeklyReminder || !reminderDays.isEmpty)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                        .textInputAutocapitalization(.sentences)
                    HStack {
                        Text("Icon")
                        Spacer()
                        TextField("An emoji", text: $draft.icon)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 120)
                            .onChange(of: draft.icon) { _, icon in
                                if icon.count > 1 { draft.icon = String(icon.suffix(1)) } // one emoji: the last one typed
                            }
                    }
                    colors
                }

                Section {
                    Picker("Repeats", selection: $kind) {
                        ForEach(kinds) { Text($0.rawValue).tag($0) }
                    }
                    if kind == .days { WeekdayPicker(title: "On", days: $days) }
                    if kind == .weekly {
                        Stepper("\(target) day\(target == 1 ? "" : "s") a week", value: $target, in: 1...7)
                    }
                } footer: {
                    switch kind {
                    case .daily: Text("A day counts when every time below is checked in.")
                    case .days: Text("Other days expect nothing, and don’t break the streak.")
                    case .weekly: Text("Any days count. The streak is kept in weeks, Monday to Sunday.\(editing != nil ? " A new number counts from next week." : "")")
                    }
                }

                if kind == .weekly {
                    Section("Reminders") {
                        Toggle("Remind Me", isOn: $weeklyReminder)
                        if weeklyReminder {
                            WeekdayPicker(title: "On", days: $reminderDays)
                            TimeRow(title: "At", time: $reminderTime)
                        }
                    }
                } else {
                    ForEach($slots) { $editable in
                        SlotSection(slot: $editable.slot, canRemove: slots.count > 1) { slots.removeAll { $0.id == editable.id } }
                    }
                    if slots.count < 6 {
                        Section {
                            Button("Add a Time of Day") { slots.append(EditableSlot(slot: HabitSlot(name: "", remind: ClockTime("21:30")))) }
                        }
                    }
                }

                Section {
                    TimeRow(title: "Day Starts At", time: $draft.dayStart)
                } footer: {
                    Text("A check-in before this counts for the day before, so brushing your teeth after midnight is still last night’s.")
                }
            }
            .navigationTitle(editing == nil ? "New Habit" : "Edit Habit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(!canSave || saving)
                }
            }
            .alert("That Didn’t Work", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var saved = draft
        saved.name = draft.name.trimmingCharacters(in: .whitespaces)
        saved.schedule = schedule
        failure = await model.saveHabit(saved, editing: editing)
        if failure == nil { dismiss() }
    }

    private var colors: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(HabitColor.allCases, id: \.self) { color in
                    Button {
                        draft.color = color
                    } label: {
                        Circle()
                            .fill(color.tint)
                            .frame(width: 28, height: 28)
                            .overlay { if draft.color == color { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.white) } }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(color.label)
                    .accessibilityAddTraits(draft.color == color ? .isSelected : [])
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Color")
    }
}

/// A slot in the form. A new one has no id yet (the Mac gives it one), so the form
/// tells them apart by a key of its own.
private struct EditableSlot: Identifiable {
    let id = UUID()
    var slot: HabitSlot
}

/// One time of day: its name, when to be reminded, the hours it belongs in, and a
/// second reminder if it still isn't done.
private struct SlotSection: View {
    @Binding var slot: HabitSlot
    var canRemove: Bool
    var remove: () -> Void

    var body: some View {
        Section {
            TextField("Name, e.g. Morning", text: $slot.name)
            OptionalTimeRow(title: "Remind Me At", time: $slot.remind, fallback: ClockTime("09:00")!)
            OptionalTimeRow(title: "Remind Again At", time: $slot.nudge, fallback: slot.remind.flatMap { ClockTime(hour: min($0.hour + 1, 23), minute: $0.minute) } ?? ClockTime("10:00")!)
            Toggle("Has Its Own Hours", isOn: Binding(
                get: { slot.from != nil },
                set: { on in
                    slot.from = on ? ClockTime("05:00") : nil
                    slot.until = on ? ClockTime("11:00") : nil
                }
            ))
            if slot.from != nil {
                TimeRow(title: "From", time: Binding(get: { slot.from ?? ClockTime("05:00")! }, set: { slot.from = $0 }))
                TimeRow(title: "Until", time: Binding(get: { slot.until ?? ClockTime("11:00")! }, set: { slot.until = $0 }))
            }
            if canRemove { Button("Remove This Time", role: .destructive, action: remove) }
        } header: {
            Text(slot.name.isEmpty ? "Time of Day" : slot.name)
        } footer: {
            if slot.from != nil { Text("The hours say which time of day a check-in is for when you don’t say. They may run past midnight.") }
        }
    }
}

/// A row with a time picker.
private struct TimeRow: View {
    var title: String
    @Binding var time: ClockTime

    var body: some View {
        DatePicker(title, selection: Binding(
            get: { Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: time.hour, minute: time.minute)) ?? Date() },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                time = ClockTime(hour: parts.hour ?? 0, minute: parts.minute ?? 0) ?? time
            }
        ), displayedComponents: .hourAndMinute)
    }
}

/// A time that may be off: a switch, and the picker when it is on.
private struct OptionalTimeRow: View {
    var title: String
    @Binding var time: ClockTime?
    var fallback: ClockTime

    var body: some View {
        Toggle(title, isOn: Binding(get: { time != nil }, set: { time = $0 ? fallback : nil }))
        if time != nil {
            TimeRow(title: "Time", time: Binding(get: { time ?? fallback }, set: { time = $0 }))
        }
    }
}

/// Seven small buttons, Monday to Sunday.
private struct WeekdayPicker: View {
    var title: String
    @Binding var days: Set<Weekday>

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
            Spacer(minLength: 8)
            ForEach(Weekday.allCases, id: \.self) { day in
                let on = days.contains(day)
                Button {
                    if on { days.remove(day) } else { days.insert(day) }
                } label: {
                    Text(String(day.label.prefix(1)))
                        .font(.footnote.weight(.semibold))
                        .frame(width: 30, height: 30)
                        .background(on ? Color.accentColor : Color.secondary.opacity(0.15), in: Circle())
                        .foregroundStyle(on ? Color.white : Color.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(day.label)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}
