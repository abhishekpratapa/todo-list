// Shared by the unit tests: a stand-in for the network, and sample data.

import Foundation
@testable import TodosKit

/// Records what the client sends and answers with whatever the test queued.
final class StubTransport: @unchecked Sendable {
    struct Reply {
        var status = 200
        var body = "{}"
        var headers: [String: String] = [:]
    }

    private let lock = NSLock()
    private var replies: [Reply] = []
    private var sent: [URLRequest] = []
    private var failure: URLError?

    func reply(_ status: Int = 200, _ body: String = "{}", headers: [String: String] = [:]) {
        lock.withLock { replies.append(Reply(status: status, body: body, headers: headers)) }
    }

    func fail(_ code: URLError.Code) {
        lock.withLock { failure = URLError(code) }
    }

    var requests: [URLRequest] { lock.withLock { sent } }
    var last: URLRequest { requests.last! }

    func body(_ request: URLRequest? = nil) -> [String: Any] {
        let data = (request ?? last).httpBody ?? Data()
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    var transport: HubClient.Transport {
        { [self] request in
            let reply: Reply = try lock.withLock {
                sent.append(request)
                if let failure { throw failure }
                return replies.isEmpty ? Reply() : replies.removeFirst()
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            return (Data(reply.body.utf8), response)
        }
    }
}

enum Sample {
    static let token = "sample-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    static func credentials(_ address: String = "my-mac.tail1234.ts.net") -> HubCredentials {
        try! HubCredentials(address: HubAddress(address), token: token)
    }

    static func client(_ stub: StubTransport, clientName: String = HubClient.defaultClientName) -> HubClient {
        HubClient(credentials: credentials(), clientName: clientName, session: .shared, transport: stub.transport)
    }

    /// A task exactly as the Mac sends one (store.js), with its history.
    static let taskJSON = """
    {"id":7,"title":"Renew passport","notes":"Bring **photos**","status":"in_progress","priority":"high","due":"2026-10-16",
     "project":"personal","tags":["errand","travel"],"assignee":"claude",
     "subtasks":[{"id":1,"title":"Fill in form","done":true},{"id":2,"title":"Book slot","done":false}],
     "repeat":"yearly","remindAt":"2026-10-15T14:00:00.000Z","remindedAt":null,"rev":4,"createdBy":"me",
     "createdAt":"2026-10-05T14:58:12.345Z","updatedAt":"2026-10-12T09:00:00.000Z","completedAt":null,
     "activity":[{"at":"2026-10-05T14:58:12.345Z","by":"me","kind":"event","text":"created this task","via":"iPhone"},
                 {"at":"2026-10-12T09:00:00.000Z","by":"Claude Code · passport","kind":"comment","text":"Form is filled in."}]}
    """

    static var task: TodoTask {
        try! HubJSON.decoder().decode(TodoTask.self, from: Data(taskJSON.utf8))
    }

    static func task(_ id: Int, _ title: String = "Task", status: TaskStatus = .todo, priority: TaskPriority = .medium, due: String? = nil,
                     project: String? = nil, tags: [String] = [], assignee: TaskAssignee = .me, completedAt: Date? = nil) -> TodoTask {
        TodoTask(id: id, title: title, status: status, priority: priority, due: due.flatMap(Day.init), project: project, tags: tags, assignee: assignee, completedAt: completedAt)
    }
}
