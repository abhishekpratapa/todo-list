// Pairing: this iPhone learns the Mac's address and access token, once. Scan the
// code in the Mac's "Pair iPhone" window, or type the two in. The token goes to
// the Keychain only after the Mac has accepted it.

import SwiftUI
import TodosKit

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var token = ""
    @State private var scanning = false
    @State private var connecting = false
    @State private var problem: Problem?

    /// What went wrong, in words.
    struct Problem: Equatable {
        var title: String
        var detail: String
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Connect to your Mac")
                            .font(.title2.weight(.bold))
                        Text("Todos on this iPhone shows the list kept by Todos on your Mac, over Tailscale. Make sure Tailscale is connected on both.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                if QRScanner.isSupported {
                    Section {
                        Button {
                            problem = nil
                            scanning = true
                        } label: {
                            Label("Scan Code", systemImage: "qrcode.viewfinder")
                                .font(.headline)
                        }
                        .disabled(connecting)
                    } footer: {
                        Text("On your Mac, choose Todos → Remote Access → Pair iPhone… and point the camera at the code.")
                    }
                }

                Section {
                    TextField("my-mac.tailnet.ts.net", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Mac address")
                    HStack {
                        SecureField("Access token", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        PasteButton(payloadType: String.self) { strings in
                            token = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? token
                        }
                        .labelStyle(.iconOnly)
                        .buttonBorderShape(.capsule)
                    }
                    Button {
                        Task { await connectManually() }
                    } label: {
                        if connecting { ProgressView() } else { Text("Connect") }
                    }
                    .disabled(connecting || address.trimmingCharacters(in: .whitespaces).isEmpty || token.trimmingCharacters(in: .whitespaces).isEmpty)
                } header: {
                    Text(QRScanner.isSupported ? "Or enter them yourself" : "Address and token")
                } footer: {
                    Text("Both are in Todos → Remote Access on your Mac: Copy Address and Copy Access Token.")
                }

                if let problem {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(problem.title, systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.red)
                            Text(problem.detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .navigationTitle("Todos")
            .navigationBarTitleDisplayMode(.inline)
            .fullScreenCover(isPresented: $scanning) {
                ScannerSheet { scanned in
                    scanning = false
                    Task { await connect(scanned: scanned) }
                }
            }
        }
    }

    private func connectManually() async {
        do {
            await connect(try HubCredentials(address: HubAddress(address), token: token))
        } catch HubAddress.Invalid.notHTTPS {
            problem = Problem(title: "That address isn’t secure", detail: "Todos only connects over HTTPS. Use the address from Copy Address on your Mac, which starts with https://.")
        } catch is HubAddress.Invalid {
            problem = Problem(title: "That doesn’t look like an address", detail: "It should look like my-mac.tailnet.ts.net. Use Copy Address on your Mac.")
        } catch {
            problem = Problem(title: "That doesn’t look like a token", detail: "Use Copy Access Token on your Mac and paste it here.")
        }
    }

    private func connect(scanned: String) async {
        do {
            await connect(try PairingCode(scanned: scanned).credentials)
        } catch PairingCode.Invalid.newerFormat {
            problem = Problem(title: "This app is out of date", detail: "That code is from a newer Todos than this app understands. Update Todos on this iPhone.")
        } catch {
            problem = Problem(title: "That isn’t a pairing code", detail: "Scan the code in Todos → Remote Access → Pair iPhone… on your Mac.")
        }
    }

    private func connect(_ credentials: HubCredentials) async {
        connecting = true
        problem = nil
        defer { connecting = false }
        guard let issue = await model.pair(credentials) else { return }
        // A token that is refused while pairing was mistyped or is out of date, not "revoked".
        problem = issue == .tokenRevoked
            ? Problem(title: "That token isn’t right", detail: "Copy it again from Todos → Remote Access on your Mac. If it was rotated, older codes and tokens no longer work.")
            : Problem(title: issue.title, detail: "\(issue.explanation) \(issue.action)")
    }
}

/// The camera, full screen, with a way out.
private struct ScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onScan: (String) -> Void

    var body: some View {
        NavigationStack {
            QRScanner(onScan: onScan)
                .ignoresSafeArea()
                .navigationTitle("Scan the Code on Your Mac")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
        }
    }
}
