// Todos for iPhone: a client for the Todos app on the Mac, which stays the one
// copy of the list. This app reaches it over the tailnet (see ../README.md).

import BackgroundTasks
import SwiftUI
import TodosKit
import WidgetKit

@main
struct TodosApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { url in
                    if let task = AppLinks.task(from: url) { model.requestedTask = task }
                }
        }
        // Only this one modifier on the scene. With a second (watching the scene phase here as
        // well), the app lost its accent colour; RootView watches the phase instead.
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await AppModel.shared.refreshInBackground()
            await BackgroundRefresh.scheduleNext()
        }
    }
}

/// Only here to set things up at the moment iOS expects it: once the app has launched,
/// and before a tapped reminder that launched it is delivered.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Notifications.shared.install()
        return true
    }
}

extension AppModel {
    /// The one model for the app, whether it was opened by the user, by a Shortcut or for a background refresh.
    static let shared: AppModel = {
        let model = forLaunch()
        // Whenever what is on screen changes, so do the reminders to schedule and what the widget shows.
        model.didReload = { tasks, habits in
            await Reminders.shared.reschedule(tasks: tasks, habits: habits)
            WidgetCenter.shared.reloadAllTimelines()
        }
        return model
    }()

    /// In debug builds, launching with TODOS_TEST_PORT and TODOS_TEST_TOKEN in the
    /// environment pairs the app, in memory only, with the test server on this machine,
    /// for trying it out in the Simulator.
    private static func forLaunch() -> AppModel {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let port = environment["TODOS_TEST_PORT"].flatMap(Int.init), let token = environment["TODOS_TEST_TOKEN"],
           let credentials = HubCredentials.loopbackForTesting(port: port, token: token) {
            // The test server's list goes in a folder of its own (each Mac has one, named after its
            // address), started empty each launch. The token stays in memory.
            try? FileManager.default.removeItem(at: SharedContainer.hubDirectory(for: credentials.address))
            return AppModel(credentials: InMemoryCredentialStore(credentials))
        }
        #endif
        // Builds before the share extension kept the token in the app's own Keychain group.
        KeychainCredentialStore.moveToSharedGroup(from: "N3366NR59J.com.abhishekpratapa.todos.ios")
        return AppModel(credentials: KeychainCredentialStore.shared)
    }
}

/// iOS wakes the app now and then to refresh. When, and how often, is up to iOS.
enum BackgroundRefresh {
    static let identifier = "com.abhishekpratapa.todos.ios.refresh"

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func scheduleNext() async {
        schedule()
    }
}
