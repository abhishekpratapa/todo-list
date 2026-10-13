// Todos for iPhone: a client for the Todos app on the Mac, which stays the one
// copy of the list. This app reaches it over the tailnet (see ../README.md).

import SwiftUI
import TodosKit

@main
struct TodosApp: App {
    @State private var model = AppModel.forLaunch()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

extension AppModel {
    /// The app's model. In debug builds, launching with TODOS_TEST_PORT and
    /// TODOS_TEST_TOKEN in the environment pairs it, in memory only, with the test
    /// server on this machine, for trying the app out in the Simulator.
    static func forLaunch() -> AppModel {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let port = environment["TODOS_TEST_PORT"].flatMap(Int.init), let token = environment["TODOS_TEST_TOKEN"],
           let credentials = HubCredentials.loopbackForTesting(port: port, token: token) {
            return AppModel(store: InMemoryCredentialStore(credentials))
        }
        #endif
        return AppModel()
    }
}
