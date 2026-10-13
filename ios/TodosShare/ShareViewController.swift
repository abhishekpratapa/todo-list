// The share sheet extension: share a link or some text into a new task.
//
// The task is saved on this iPhone straight away, in the same queue the app uses.
// The extension then tries for a few seconds to send it to the Mac; if the Mac
// can't be reached, the app sends it later. Either way it is sent once: every
// change carries a key the Mac recognises.

import SwiftUI
import TodosKit
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading, editing, saving, notPaired
        case finished(String)
    }

    var title = ""
    var notes = ""
    private(set) var phase = Phase.loading
    @ObservationIgnored private let context: NSExtensionContext?

    init(context: NSExtensionContext?) {
        self.context = context
    }

    /// Reads what was shared: a link, some text, or both.
    func load() async {
        guard SharedContainer.currentHubDirectory() != nil else {
            phase = .notPaired
            return
        }
        var url: URL?
        var text: String?
        var pageTitle: String?
        for item in (context?.inputItems ?? []).compactMap({ $0 as? NSExtensionItem }) {
            pageTitle = pageTitle ?? item.attributedContentText?.string ?? item.attributedTitle?.string
            for provider in item.attachments ?? [] {
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    url = await withCheckedContinuation { done in
                        _ = provider.loadObject(ofClass: URL.self) { value, _ in done.resume(returning: value) }
                    }
                } else if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    text = await withCheckedContinuation { done in
                        _ = provider.loadObject(ofClass: String.self) { value, _ in done.resume(returning: value) }
                    }
                }
            }
        }
        (title, notes) = SharedContent.task(url: url, text: text, pageTitle: pageTitle)
        phase = .editing
    }

    func add() async {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .editing, !title.isEmpty, let folder = SharedContainer.currentHubDirectory() else { return }
        phase = .saving
        let store = LocalStore(directory: folder)
        let change = await store.add(.add(title: title, notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)))

        // Try to send it now, but don't keep the share sheet up for long.
        if let credentials = try? KeychainCredentialStore.shared.load() {
            let engine = SyncEngine(client: HubClient(credentials: credentials), store: store)
            await withTaskGroup(of: Void.self) { group in
                group.addTask { _ = await engine.replay() }
                group.addTask { try? await Task.sleep(for: .seconds(6)) }
                await group.next()
                group.cancelAll()
            }
        }
        let sent = await !store.changes.contains { $0.id == change.id }
        phase = .finished(sent ? "Added to Todos" : "Saved. It will be added when your Mac can be reached.")
        try? await Task.sleep(for: .seconds(sent ? 0.7 : 1.6))
        context?.completeRequest(returningItems: nil)
    }

    func cancel() {
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView()
                case .notPaired:
                    ContentUnavailableView("Not Connected Yet", systemImage: "desktopcomputer", description: Text("Open Todos and pair it with your Mac first."))
                case .finished(let message):
                    ContentUnavailableView(message, systemImage: "checkmark.circle.fill")
                case .editing, .saving:
                    Form {
                        Section("New task") {
                            TextField("Title", text: $model.title, axis: .vertical)
                                .lineLimit(1...4)
                        }
                        if !model.notes.isEmpty {
                            Section("Notes") {
                                TextField("Notes", text: $model.notes, axis: .vertical)
                                    .font(.footnote)
                                    .lineLimit(1...8)
                            }
                        }
                    }
                    .disabled(model.phase == .saving)
                }
            }
            .navigationTitle("Todos")
            .navigationBarTitleDisplayMode(.inline)
            .tint(Color(red: 0x55 / 255, green: 0x50 / 255, blue: 0xD8 / 255)) // the app's accent; an extension doesn't inherit it
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    switch model.phase {
                    case .finished, .saving: EmptyView() // nothing left to cancel
                    case .notPaired: Button("Close") { model.cancel() }
                    case .loading, .editing: Button("Cancel") { model.cancel() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.phase == .saving {
                        ProgressView()
                    } else if model.phase == .editing {
                        Button("Add") { Task { await model.add() } }
                            .disabled(model.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }
}
