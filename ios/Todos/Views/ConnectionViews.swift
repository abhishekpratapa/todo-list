// How connection problems are shown: a banner over a list that is already loaded,
// or the whole screen when there is nothing to show yet.

import SwiftUI
import TodosKit

struct IssueBanner: View {
    var issue: ConnectionIssue

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(issue.title).font(.subheadline.weight(.semibold))
                Text(issue.action).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens settings")
    }
}

/// The problem, why, and what to do, with a way to try again.
struct IssueView: View {
    @Environment(AppModel.self) private var model
    var issue: ConnectionIssue
    @State private var retrying = false
    @State private var confirmingUnpair = false

    var body: some View {
        ContentUnavailableView {
            Label(issue.title, systemImage: issue.symbol)
        } description: {
            Text("\(issue.explanation)\n\(issue.action)")
        } actions: {
            if issue.needsPairing {
                Button("Pair Again") { Task { await model.unpair(erasingData: false) } }
                    .buttonStyle(.borderedProminent)
            } else {
                Button {
                    Task {
                        retrying = true
                        await model.retry()
                        retrying = false
                    }
                } label: {
                    if retrying { ProgressView() } else { Text("Try Again") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(retrying)
                Button("Pair with a Different Mac", role: .destructive) { confirmingUnpair = true }
                    .font(.footnote)
            }
        }
        .confirmationDialog("Forget this Mac?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { Task { await model.unpair(erasingData: false) } }
        } message: {
            Text("The access token is removed from this iPhone. Nothing changes on your Mac.")
        }
    }
}

extension ConnectionIssue {
    var symbol: String {
        switch self {
        case .tailscaleOff: "network.slash"
        case .macUnreachable: "desktopcomputer.trianglebadge.exclamationmark"
        case .tokenRevoked: "key.slash"
        case .serverTooOld, .serverTooNew: "arrow.down.circle"
        case .todosNotRunning, .remoteAccessOff: "power"
        default: "exclamationmark.triangle"
        }
    }
}
