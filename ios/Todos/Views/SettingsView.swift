// Settings: which Mac this iPhone is paired with, how the connection is doing, and unpairing.

import SwiftUI
import TodosKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingUnpair = false
    @State private var retrying = false

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
                    Button(model.issue?.needsPairing == true ? "Pair Again" : "Unpair This iPhone", role: .destructive) { confirmingUnpair = true }
                } footer: {
                    Text("Unpairing removes the access token from this iPhone. To sign every device out at once, choose Rotate Access Token on your Mac.")
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
                Button("Unpair", role: .destructive) {
                    dismiss()
                    model.unpair()
                }
            } message: {
                Text("You’ll need the address and token, or the pairing code, to connect again. Nothing changes on your Mac.")
            }
        }
    }

    private var status: String {
        if let issue = model.issue { return issue.title }
        return model.isLive ? "Connected, updating live" : "Connecting…"
    }
}
