// swift-tools-version: 6.0
// TodosKit: everything about talking to the Todos app on the Mac that has no user
// interface. It builds for macOS as well as iOS so its tests can run with
// `swift test`, where the integration tests start a real Todos server.

import PackageDescription

let package = Package(
    name: "TodosKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        // Linked statically into the app (and later into each extension), so there is
        // no framework to embed. The app's own tests use the copy inside the app.
        .library(name: "TodosKit", targets: ["TodosKit"]),
    ],
    targets: [
        .target(name: "TodosKit"),
        .testTarget(name: "TodosKitTests", dependencies: ["TodosKit"]),
        .testTarget(name: "TodosKitIntegrationTests", dependencies: ["TodosKit"]),
    ]
)
