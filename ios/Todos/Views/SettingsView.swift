// Settings: which Mac this iPhone is paired with, how the connection is doing, and unpairing.

import SwiftUI
import TodosKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingUnpair = false
    @State private var retrying = false
    @State private var remindersOn = Reminders.shared.isEnabled
    @State private var remindersRefused = false
    @State private var habitRemindersOn = Reminders.shared.habitsEnabled
    @State private var notificationsAllowed = true

    /// How habit reminders stand: on and how far ahead they reach, or why they can't be shown.
    private var habitReminderStatus: String {
        guard habitRemindersOn else { return "Habit reminders are off on this iPhone." }
        guard notificationsAllowed else { return "Notifications are turned off for Todos on this iPhone, so habit reminders can’t be shown." }
        let basics = "At each habit’s reminder time, with Done and Snooze buttons. They are scheduled on this iPhone, so they arrive even when your Mac is asleep."
        guard let plan = Reminders.shared.plan, let through = plan.habitsCoveredThrough else { return basics }
        var reach = " Scheduled through \(through.date().formatted(.dateTime.weekday(.wide).month().day())); opening Todos, or answering a reminder, schedules more."
        if plan.isShort { reach = " There are more reminders than iOS will keep at once: only the nearest are scheduled, and Todos must be opened each day to keep them coming." }
        if plan.withoutNudges { reach += " Second reminders are left out to make room." }
        return basics + reach
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    LabeledContent("Address", value: model.address?.description ?? "Not paired")
                    if let version = model.macVersion {
                        LabeledContent("Todos on the Mac", value: version)
                    }
                    LabeledContent("Status") {
                        Label(status, systemImage: model.issue != nil ? "exclamationmark.triangle.fill" : model.isLive ? "dot.radiowaves.left.and.right" : "clock")
                            .foregroundStyle(model.issue != nil ? .orange : .secondary)
                    }
                    if let synced = model.lastSynced {
                        LabeledContent("Last updated", value: synced.formatted(date: .abbreviated, time: .shortened))
                    }
                }

                Section {
                    Button {
                        dismiss()
                        model.isShowingSync = true
                    } label: {
                        LabeledContent("Waiting to be sent", value: "\(model.waiting.count)")
                    }
                    if !model.needingAttention.isEmpty {
                        Button {
                            dismiss()
                            model.isShowingSync = true
                        } label: {
                            LabeledContent("Need your decision", value: "\(model.needingAttention.count)")
                        }
                    }
                } header: {
                    Text("Changes made on this iPhone")
                } footer: {
                    Text("The list is kept on this iPhone, so you can read and change it without a connection. Changes are sent, in order, when your Mac can be reached.")
                }

                if let issue = model.issue {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(issue.title).font(.headline)
                            Text(issue.explanation)
                            Text(issue.action).foregroundStyle(.secondary)
                        }
                        .font(.subheadline)
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                        if !issue.needsPairing {
                            Button {
                                Task {
                                    retrying = true
                                    await model.retry()
                                    retrying = false
                                }
                            } label: {
                                if retrying { ProgressView() } else { Text("Try Again") }
                            }
                            .disabled(retrying)
                        }
                    }
                }

                Section {
                    Toggle("Reminders on This iPhone", isOn: $remindersOn)
                        .onChange(of: remindersOn) { _, on in
                            Task {
                                let accepted = await Reminders.shared.setEnabled(on, tasks: model.tasks, habits: model.habits)
                                remindersRefused = on && !accepted
                                if !accepted { remindersOn = false }
                            }
                        }
                    if remindersRefused {
                        Button("Allow Notifications in Settings…") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    Text(remindersRefused
                        ? "Notifications are turned off for Todos on this iPhone, so reminders can’t be shown."
                        : "Reminders are scheduled on this iPhone from your list, so they arrive even when your Mac is asleep. To be reminded only once, turn off Reminder Notifications on This Mac in the Todos menu on your Mac.")
                }

                if model.habitsSupported == true {
                    Section {
                        Toggle("Habit Reminders on This iPhone", isOn: $habitRemindersOn)
                            .onChange(of: habitRemindersOn) { _, on in
                                Task { notificationsAllowed = await Reminders.shared.setHabitsEnabled(on, tasks: model.tasks, habits: model.habits) }
                            }
                        if habitRemindersOn, !notificationsAllowed {
                            Button("Allow Notifications in Settings…") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                        }
                    } header: {
                        Text("Habits")
                    } footer: {
                        Text(habitReminderStatus)
                    }
                    .task { notificationsAllowed = await Reminders.shared.isAllowed() || !habitRemindersOn }
                }

                Section {
                    if model.issue?.needsPairing == true {
                        Button("Pair Again") {
                            dismiss()
                            Task { await model.unpair(erasingData: false) }
                        }
                    }
                    Button("Unpair This iPhone", role: .destructive) { confirmingUnpair = true }
                } footer: {
                    Text("Unpairing removes the access token and the copy of your list from this iPhone. To sign every device out at once, choose Rotate Access Token on your Mac.")
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                } header: {
                    Text("About")
                } footer: {
                    Text("Your list lives on your Mac. This iPhone reaches it over Tailscale, so it needs your Mac to be awake and Todos running there.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button(unsent == 0 ? "Unpair" : "Unpair and Lose \(unsent == 1 ? "1 Change" : "\(unsent) Changes")", role: .destructive) {
                    dismiss()
                    Task { await model.unpair(erasingData: true) }
                }
            } message: {
                Text(unsent == 0
                    ? "The token and the copy of your list are removed from this iPhone. Nothing changes on your Mac."
                    : "\(unsent == 1 ? "1 change" : "\(unsent) changes") made on this iPhone \(unsent == 1 ? "hasn’t" : "haven’t") reached your Mac and will be lost.")
            }
        }
    }

    /// Changes that would be lost by unpairing.
    private var unsent: Int { model.changes.count }

    private var status: String {
        if let issue = model.issue { return issue.title }
        return model.isLive ? "Connected, updating live" : "Connecting…"
    }
}
