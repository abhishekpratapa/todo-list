// The top of the app: pairing until this iPhone knows a Mac, then the list.
// Quick capture floats over every screen, so it is always one tap away.

import SwiftUI
import TodosKit

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ProgressView()
            case .unpaired:
                PairingView()
            case .paired:
                MainView()
            }
        }
        .task {
            await model.start()
            await model.activate()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.activate() }
            case .background:
                model.deactivate()
                BackgroundRefresh.schedule() // ask iOS to wake the app now and then to refresh
            default: break
            }
        }
    }
}

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var capturing = false
    @State private var showingSettings = false
    @State private var path: [Int] = []

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            TaskListView(showingSettings: $showingSettings)
                .navigationDestination(for: Int.self) { TaskDetailView(taskID: $0) }
        }
        // A reminder or the widget was tapped: go to that task.
        .onChange(of: model.requestedTask, initial: true) { _, task in
            guard let task else { return }
            model.requestedTask = nil
            capturing = false
            showingSettings = false
            model.isShowingSync = false
            path = [task]
        }
        .overlay(alignment: .bottom) {
            if let notice = model.notice {
                NoticeView(notice: notice)
                    .padding(.bottom, 92)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: notice.id) {
                        try? await Task.sleep(for: .seconds(notice.isError ? 5 : 3))
                        if model.notice?.id == notice.id { model.notice = nil }
                    }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            CaptureButton { capturing = true }
                .padding(.trailing, 20)
                .padding(.bottom, 16)
                .ignoresSafeArea(.keyboard, edges: .bottom) // stays put, under the keyboard, instead of covering a text field
        }
        .animation(.snappy, value: model.notice)
        .sheet(isPresented: $capturing) { QuickCaptureView() }
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(isPresented: $model.isShowingSync) { SyncView() }
    }
}

/// The floating "+" that opens quick capture.
struct CaptureButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 58, height: 58)
                .background(Color.accentColor, in: Circle())
                .shadow(color: .black.opacity(0.25), radius: 6, y: 3)
        }
        .accessibilityLabel("Quick capture")
        .accessibilityHint("Adds a task from one line")
    }
}

struct NoticeView: View {
    var notice: AppModel.Notice

    var body: some View {
        Label(notice.text, systemImage: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            .font(.subheadline)
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(notice.isError ? Color.red : Color.black.opacity(0.82), in: Capsule())
            .padding(.horizontal, 20)
            .accessibilityAddTraits(.isStaticText)
            .onAppear { AccessibilityNotification.Announcement(notice.text).post() }
    }
}
