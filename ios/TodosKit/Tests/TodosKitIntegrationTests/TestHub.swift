// A real Todos server for the integration tests: ios/scripts/test-server.mjs, which
// runs the Mac app's own server code on a data directory it creates in the temporary
// folder and deletes afterwards. The real data file and token are never touched.

#if os(macOS)
import Foundation
@testable import TodosKit

final class TestHub: @unchecked Sendable {
    enum Failure: Error {
        case nodeNotFound
        case serverExited
        case refused(String)
    }

    /// Where `node` is, or nil if it isn't installed. The integration tests are skipped without it.
    static let node: String? = {
        let fromEnvironment = ProcessInfo.processInfo.environment["TODOS_NODE"].map { [$0] } ?? []
        let onPath = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
        return (fromEnvironment + onPath + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]).first { FileManager.default.isExecutableFile(atPath: $0) }
    }()

    /// The repository root: this file is ios/TodosKit/Tests/TodosKitIntegrationTests/TestHub.swift.
    static let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private let process = Process()
    private let toServer = Pipe()
    private let fromServer = Pipe()
    private let lock = NSLock()
    private var buffer = Data()

    // Set once, in init, from the server's first line.
    private(set) var port = 0
    private(set) var tailnet = ""
    private(set) var owner = ""
    private(set) var token = ""

    init() throws {
        guard let node = Self.node else { throw Failure.nodeNotFound }
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [Self.repository.appendingPathComponent("ios/scripts/test-server.mjs").path]
        process.standardInput = toServer
        process.standardOutput = fromServer
        try process.run()
        let ready = try readLine()
        guard let port = ready["port"] as? Int, let token = ready["token"] as? String,
              let tailnet = ready["tailnet"] as? String, let owner = ready["owner"] as? String else { throw Failure.serverExited }
        self.port = port
        self.token = token
        self.tailnet = tailnet
        self.owner = owner
    }

    deinit {
        try? toServer.fileHandleForWriting.close() // the server exits when its input closes
        process.terminate()
    }

    /// Waits for the server's next line of JSON.
    private func readLine() throws -> [String: Any] {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                buffer = Data(buffer[buffer.index(after: newline)...])
                return (try JSONSerialization.jsonObject(with: line)) as? [String: Any] ?? [:]
            }
            let more = fromServer.fileHandleForReading.availableData
            guard !more.isEmpty else { throw Failure.serverExited }
            buffer.append(more)
        }
    }

    /// Sends the server one command and returns its answer.
    @discardableResult
    func command(_ name: String, _ arguments: [String: Any] = [:]) throws -> [String: Any] {
        try lock.withLock {
            var message = arguments
            message["cmd"] = name
            var line = try JSONSerialization.data(withJSONObject: message)
            line.append(0x0A)
            try toServer.fileHandleForWriting.write(contentsOf: line)
            let answer = try readLine()
            guard answer["ok"] as? Bool == true else { throw Failure.refused(answer["error"] as? String ?? "") }
            if name == "rotate", let token = answer["token"] as? String { self.token = token }
            return answer
        }
    }

    // MARK: Things that happen on the Mac

    private func task(from answer: [String: Any]) throws -> TodoTask {
        try HubJSON.decoder().decode(TodoTask.self, from: JSONSerialization.data(withJSONObject: answer["task"] ?? [:]))
    }

    /// A change made on the Mac itself: in the app, or by a Claude session through the MCP server.
    @discardableResult
    func macUpdate(_ id: Int, _ patch: [String: Any], by: String = "me") throws -> TodoTask {
        try task(from: command("mac.update", ["id": id, "patch": patch, "by": by]))
    }

    @discardableResult
    func macCreate(_ input: [String: Any], by: String = "me") throws -> TodoTask {
        try task(from: command("mac.create", ["input": input, "by": by]))
    }

    func macDelete(_ id: Int) throws {
        try command("mac.delete", ["id": id])
    }

    var version: Int {
        get throws { try command("version")["version"] as? Int ?? -1 }
    }

    // MARK: Clients

    /// The headers `tailscale serve` adds when it relays a request from a device on the tailnet.
    func relayHeaders(login: String? = nil) -> [String: String] {
        ["X-Forwarded-Host": tailnet, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.2",
         "Tailscale-User-Login": login ?? owner, "Tailscale-User-Name": "Test Owner"]
    }

    /// A client that reaches the server the way the iPhone does: relayed by Tailscale, signed in as the owner.
    func phone(token: String? = nil, login: String? = nil, port: Int? = nil) -> HubClient {
        let credentials = try! HubCredentials(address: HubAddress(loopbackPort: port ?? self.port), token: token ?? self.token)
        let session = URLSession(configuration: HubClient.configuration())
        var client = HubClient(credentials: credentials, session: session) { try await session.data(for: $0) }
        client.extraHeaders = relayHeaders(login: login)
        return client
    }
}

/// Collects what a live connection reports, so a test can wait for a particular state.
actor LiveLog {
    private(set) var states: [LiveState] = []
    private var listening: Task<Void, Never>?

    func start(_ updates: LiveUpdates) {
        listening = Task {
            for await state in updates.states() { record(state) }
            record(nil)
        }
    }

    private var finished = false
    private func record(_ state: LiveState?) {
        if let state { states.append(state) } else { finished = true }
    }

    var isFinished: Bool { finished }

    func stop() {
        listening?.cancel()
    }

    /// Waits until some reported state satisfies the test, or the time runs out.
    func saw(within seconds: Double = 5, _ matches: @Sendable (LiveState) -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if states.contains(where: matches) { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return states.contains(where: matches)
    }

    func finished(within seconds: Double = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !finished { try? await Task.sleep(for: .milliseconds(20)) }
        return finished
    }
}
#endif
