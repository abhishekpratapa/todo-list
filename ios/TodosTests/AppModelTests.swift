// The app's behaviour around pairing and changes, with the network replaced by
// canned answers. The real Keychain is used, under a service name of its own.

import Foundation
import Testing
@testable import Todos
@testable import TodosKit

/// Answers requests in order with whatever the test queued, and remembers what was asked.
final class CannedHub: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [(status: Int, body: String)] = []
    private var sent: [URLRequest] = []
    private var down = false

    func reply(_ status: Int, _ body: String) { lock.withLock { replies.append((status, body)) } }
    func goDown() { lock.withLock { down = true } }
    var requests: [URLRequest] { lock.withLock { sent } }

    func client(_ credentials: HubCredentials) -> HubClient {
        HubClient(credentials: credentials, session: .shared) { [self] request in
            let reply: (status: Int, body: String) = try lock.withLock {
                sent.append(request)
                if down { throw URLError(.timedOut) }
                return replies.isEmpty ? (500, "{}") : replies.removeFirst()
            }
            return (Data(reply.body.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }
}

@MainActor
@Suite("Pairing and changes")
struct AppModelTests {
    let hub = CannedHub()
    let store = KeychainCredentialStore(service: "com.abhishekpratapa.todos.tests.\(UUID().uuidString)")
    let credentials = try! HubCredentials(address: HubAddress("my-mac.tail1234.ts.net"), token: "test-token-\(UUID().uuidString)")

    static let meta = #"{"api":{"version":1,"revision":2},"app":{"name":"Todos","version":"1.5.0"}}"#
    static let counts = #"{"open":1,"in_progress":0,"blocked":0,"overdue":0,"due_today":0,"claude":0,"done_7d":0}"#

    static func task(rev: Int = 1, title: String = "Renew passport", priority: String = "medium", activity: String = "[]") -> String {
        #"{"id":7,"title":"\#(title)","notes":"","status":"todo","priority":"\#(priority)","due":null,"project":null,"tags":[],"assignee":"me","subtasks":[],"repeat":null,"remindAt":null,"remindedAt":null,"rev":\#(rev),"createdBy":"me","createdAt":"2026-10-05T14:58:12.345Z","updatedAt":"2026-10-05T14:58:12.345Z","completedAt":null,"activity":\#(activity)}"#
    }

    static func list(_ tasks: String...) -> String {
        #"{"tasks":[\#(tasks.joined(separator: ","))],"total":\#(tasks.count),"summary":\#(counts),"version":3}"#
    }

    /// The live connection, driven by the test: `live.yield(...)` is the Mac's event stream reporting something.
    private let channel = AsyncStream.makeStream(of: LiveState.self)
    var liveStates: AsyncStream<LiveState> { channel.stream }
    var live: AsyncStream<LiveState>.Continuation { channel.continuation }

    func model() -> AppModel {
        AppModel(store: store, makeClient: { [hub] in hub.client($0) }, liveStates: { [liveStates] _ in liveStates })
    }

    /// A model that has paired and loaded one task.
    func paired() async -> AppModel {
        let model = model()
        hub.reply(200, Self.meta)
        hub.reply(200, Self.list(Self.task()))
        #expect(await model.pair(credentials) == nil)
        return model
    }

    /// Waits for something that happens a moment later, on the model's own schedule.
    func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    @Test("pairing keeps the token only once the Mac has accepted it, and only in the Keychain")
    func pairing() async throws {
        defer { try? store.clear() }
        let model = model()
        await model.start()
        #expect(model.phase == .unpaired)

        hub.reply(200, Self.meta)
        hub.reply(200, Self.list(Self.task()))
        #expect(await model.pair(credentials) == nil)
        #expect(model.phase == .paired)
        #expect(model.address == credentials.address)
        #expect(model.macVersion == "1.5.0")
        #expect(model.tasks.map(\.title) == ["Renew passport"])
        #expect(try store.load() == credentials)

        // The token is in the Keychain and nowhere else this app writes.
        let token = credentials.token
        #expect(!"\(UserDefaults.standard.dictionaryRepresentation())".contains(token))
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let files = FileManager.default.enumerator(at: home, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey])
        while let file = files?.nextObject() as? URL {
            guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), values.isRegularFile == true, (values.fileSize ?? 0) < 5_000_000,
                  let data = try? Data(contentsOf: file) else { continue }
            #expect(data.range(of: Data(token.utf8)) == nil, "found the token in \(file.lastPathComponent)")
        }
    }

    @Test("a wrong token, an old Mac or no connection: nothing is saved and the reason is given")
    func pairingRefused() async throws {
        defer { try? store.clear() }
        let model = model()
        await model.start()

        hub.reply(401, #"{"error":{"code":"unauthorized","message":"That access token is not valid."}}"#)
        #expect(await model.pair(credentials) == .tokenRevoked)

        hub.reply(404, #"{"error":{"code":"not_found","message":"No such endpoint."}}"#)
        #expect(await model.pair(credentials) == .serverTooOld)

        hub.reply(200, #"{"api":{"version":2,"revision":1}}"#)
        #expect(await model.pair(credentials) == .serverTooNew)

        hub.goDown()
        let issue = await model.pair(credentials)
        #expect(issue == .macUnreachable || issue == .tailscaleOff)

        #expect(model.phase == .unpaired)
        #expect(try store.load() == nil)
    }

    @Test("the next launch finds the pairing; unpairing removes it")
    func relaunchAndUnpair() async throws {
        defer { try? store.clear() }
        _ = await paired()

        let relaunched = model()
        hub.reply(200, Self.meta)
        hub.reply(200, Self.list(Self.task()))
        await relaunched.start()
        #expect(relaunched.phase == .paired)
        #expect(relaunched.tasks.count == 1)
        #expect(hub.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer \(credentials.token)")

        relaunched.unpair()
        #expect(relaunched.phase == .unpaired)
        #expect(relaunched.tasks.isEmpty && relaunched.address == nil)
        #expect(try store.load() == nil)
    }

    @Test("an edit shows at once and is sent with the revision it was based on")
    func edit() async throws {
        defer { try? store.clear() }
        let model = await paired()
        hub.reply(200, #"{"task":\#(Self.task(rev: 2, priority: "high")),"next":null}"#)
        await model.update(7, TaskPatch(priority: .high))
        #expect(model.task(7)?.priority == .high && model.task(7)?.rev == 2)
        let request = try #require(hub.requests.last)
        #expect(request.httpMethod == "PATCH" && request.value(forHTTPHeaderField: "If-Match") == "\"1\"")
    }

    @Test("when the task changed on the Mac first, the Mac's version shows and my change is offered again, not dropped")
    func conflict() async throws {
        defer { try? store.clear() }
        let model = await paired()
        let theirs = Self.task(rev: 2, priority: "high", activity: #"[{"at":"2026-10-12T09:00:00.000Z","by":"Claude Code · passport","kind":"event","text":"set priority to high"}]"#)
        hub.reply(409, #"{"error":{"code":"conflict","message":"changed","current":\#(theirs)}}"#)
        await model.update(7, TaskPatch(title: "Renew passport this week"))

        let conflict = try #require(model.conflict)
        #expect(model.task(7)?.title == "Renew passport" && model.task(7)?.priority == .high, "showing the Mac's version")
        #expect(ConflictText.message(for: conflict).contains("Claude Code · passport"))
        #expect(ConflictText.message(for: conflict).contains("title"))

        // Applying it goes on top of the Mac's version, at its revision.
        hub.reply(200, #"{"task":\#(Self.task(rev: 3, title: "Renew passport this week", priority: "high")),"next":null}"#)
        await model.resolve(conflict, applyMine: true)
        #expect(model.conflict == nil)
        #expect(hub.requests.last?.value(forHTTPHeaderField: "If-Match") == "\"2\"")
        #expect(model.task(7)?.title == "Renew passport this week" && model.task(7)?.priority == .high, "both changes survive")
    }

    @Test("a change that can't be sent is taken back, and says so")
    func unreachable() async throws {
        defer { try? store.clear() }
        let model = await paired()
        hub.goDown()
        await model.update(7, TaskPatch(title: "Never arrives"))
        #expect(model.task(7)?.title == "Renew passport")
        #expect(model.notice?.isError == true)
        #expect(model.issue == .macUnreachable || model.issue == .tailscaleOff)

        await model.complete(7)
        #expect(model.task(7)?.status == .todo)
        #expect(await model.capture("Something new") == false)
        #expect(model.tasks.count == 1)
    }

    @Test("a live update reloads the list only when the Mac's version has moved on")
    func liveUpdate() async throws {
        defer { try? store.clear() }
        let model = await paired()
        let before = hub.requests.count

        live.yield(.live(version: 3)) // the version the list already has
        #expect(await eventually { model.isLive })
        #expect(hub.requests.count == before, "nothing to fetch")

        hub.reply(200, Self.list(Self.task(rev: 2, title: "Renew passport today"), Self.task().replacingOccurrences(of: #""id":7"#, with: #""id":8"#)))
        live.yield(.changed(version: 4))
        #expect(await eventually { model.tasks.count == 2 })
        #expect(model.task(7)?.title == "Renew passport today")
        #expect(model.lastSynced != nil && model.issue == nil)
    }

    @Test("losing the connection shows why; getting it back clears it")
    func connectionLostAndBack() async throws {
        defer { try? store.clear() }
        let model = await paired()
        live.yield(.live(version: 3))
        #expect(await eventually { model.isLive })

        live.yield(.waiting(.todosNotRunning, retryIn: 1))
        #expect(await eventually { model.issue == .todosNotRunning })
        #expect(model.isLive == false)
        #expect(model.tasks.count == 1, "the list stays on screen")

        live.yield(.live(version: 3))
        #expect(await eventually { model.issue == nil && model.isLive })

        live.yield(.stopped(.unauthorized))
        #expect(await eventually { model.issue == .tokenRevoked })
    }

    @Test("a revoked token is reported as such, and the list stays on screen")
    func revoked() async throws {
        defer { try? store.clear() }
        let model = await paired()
        hub.reply(401, #"{"error":{"code":"unauthorized","message":"That access token is not valid."}}"#)
        await model.refresh()
        #expect(model.issue == .tokenRevoked)
        #expect(model.issue?.needsPairing == true)
        #expect(model.tasks.count == 1)
    }
}
