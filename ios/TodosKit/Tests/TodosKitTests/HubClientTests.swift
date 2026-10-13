import Foundation
import Testing
@testable import TodosKit

@Suite("API client")
struct HubClientTests {
    let stub = StubTransport()
    var client: HubClient { Sample.client(stub) }
    static let task = #"{"task":\#(Sample.taskJSON)}"#

    // MARK: What is sent

    @Test("every request carries the token, names this client, and goes to /api/v1 over HTTPS")
    func commonHeaders() async throws {
        stub.reply(200, Self.task)
        _ = try await client.task(7)
        let request = stub.last
        #expect(request.url?.absoluteString == "https://my-mac.tail1234.ts.net/api/v1/tasks/7")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Sample.token)")
        #expect(request.value(forHTTPHeaderField: "X-Todos-Client") == "iPhone")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.url?.query == nil, "the token never goes in the address")
    }

    @Test("a different port and client name are respected")
    func customAddress() async throws {
        let client = HubClient(credentials: Sample.credentials("https://my-mac.tail1234.ts.net:8443/"), clientName: "iPhone widget", session: .shared, transport: stub.transport)
        stub.reply(200, #"{"api":{"version":1,"revision":2},"app":{"name":"Todos","version":"1.5.0"}}"#)
        let meta = try await client.meta()
        #expect(stub.last.url?.absoluteString == "https://my-mac.tail1234.ts.net:8443/api/v1/meta")
        #expect(stub.last.value(forHTTPHeaderField: "X-Todos-Client") == "iPhone widget")
        #expect(meta == ServerMeta(version: 1, revision: 2, appVersion: "1.5.0"))
    }

    @Test("an edit names the revision it is based on and sends only what changed")
    func update() async throws {
        stub.reply(200, #"{"task":\#(Sample.taskJSON),"next":null}"#)
        let result = try await client.update(7, rev: 3, TaskPatch(priority: .low, due: .clear))
        #expect(stub.last.httpMethod == "PATCH")
        #expect(stub.last.url?.path == "/api/v1/tasks/7")
        #expect(stub.last.value(forHTTPHeaderField: "If-Match") == "\"3\"")
        #expect(stub.last.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = stub.body()
        #expect(body.keys.sorted() == ["due", "priority"])
        #expect(body["due"] is NSNull)
        #expect(result.task.id == 7 && result.next == nil)
    }

    @Test("a delete names its revision too")
    func delete() async throws {
        stub.reply(204, "")
        try await client.delete(7, rev: 5)
        #expect(stub.last.httpMethod == "DELETE")
        #expect(stub.last.value(forHTTPHeaderField: "If-Match") == "\"5\"")
        #expect(stub.last.httpBody == nil)
    }

    @Test("completing, commenting and subtask changes need no revision")
    func additive() async throws {
        for _ in 0..<7 { stub.reply(200, Self.task) }
        _ = try await client.complete(7)
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/tasks/7/complete" && stub.last.httpBody == nil)
        _ = try await client.complete(7, comment: "Done at the counter")
        #expect(stub.body()["comment"] as? String == "Done at the counter")
        _ = try await client.addComment(7, text: "On my way")
        #expect(stub.last.url?.path == "/api/v1/tasks/7/comments" && stub.body()["text"] as? String == "On my way")
        _ = try await client.addSubtask(7, title: "Pay fee")
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/tasks/7/subtasks" && stub.body()["title"] as? String == "Pay fee")
        _ = try await client.setSubtask(7, subtask: 2, done: true)
        #expect(stub.last.httpMethod == "PATCH" && stub.last.url?.path == "/api/v1/tasks/7/subtasks/2" && stub.body()["done"] as? Bool == true)
        _ = try await client.renameSubtask(7, subtask: 2, title: "Book a slot")
        #expect(stub.body()["title"] as? String == "Book a slot")
        _ = try await client.removeSubtask(7, subtask: 2)
        #expect(stub.last.httpMethod == "DELETE" && stub.last.url?.path == "/api/v1/tasks/7/subtasks/2")
        #expect(stub.requests.allSatisfy { $0.value(forHTTPHeaderField: "If-Match") == nil })
    }

    @Test("quick capture sends the line as typed and returns how the Mac read it")
    func capture() async throws {
        stub.reply(201, #"{"task":\#(Sample.taskJSON),"parsed":{"title":"Renew passport","fields":{"due":"2026-10-16","priority":"high","project":"personal"}}}"#)
        let captured = try await client.capture("Renew passport fri !high #personal")
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/capture")
        #expect(stub.body()["text"] as? String == "Renew passport fri !high #personal")
        #expect(captured.task.id == 7)
        #expect(captured.parsed.fields.priority == .high)

        stub.reply(200, #"{"title":"Call dentist","fields":{"due":"2026-10-13"}}"#)
        let preview = try await client.preview("Call dentist tomorrow")
        #expect(stub.last.url?.path == "/api/v1/capture/preview")
        #expect(preview.title == "Call dentist" && preview.fields.due == Day("2026-10-13"))
    }

    @Test("a change can carry a key that makes it safe to send twice, and a capture can say when it was typed")
    func keysAndTypedAt() async throws {
        let key = UUID(uuidString: "0A1B2C3D-0000-4000-8000-00000000ABCD")!
        for _ in 0..<8 { stub.reply(200, Self.task) }
        _ = try await client.update(7, rev: 3, TaskPatch(priority: .low), key: key)
        #expect(stub.last.value(forHTTPHeaderField: "Idempotency-Key") == "0A1B2C3D-0000-4000-8000-00000000ABCD")
        #expect(stub.last.value(forHTTPHeaderField: "If-Match") == "\"3\"")
        _ = try await client.complete(7, key: key)
        _ = try await client.addComment(7, text: "x", key: key)
        _ = try await client.addSubtask(7, title: "x", key: key)
        _ = try await client.setSubtask(7, subtask: 1, done: true, key: key)
        _ = try await client.renameSubtask(7, subtask: 1, title: "y", key: key)
        _ = try await client.removeSubtask(7, subtask: 1, key: key)
        _ = try await client.create(like: Sample.task, key: key)
        #expect(stub.requests.allSatisfy { $0.value(forHTTPHeaderField: "Idempotency-Key") == key.uuidString })
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/tasks")
        #expect(stub.body()["title"] as? String == "Renew passport" && stub.body()["repeat"] as? String == "yearly")
        #expect(stub.body()["subtasks"] as? [String] == ["Fill in form", "Book slot"])

        stub.reply(201, #"{"task":\#(Sample.taskJSON),"parsed":{"title":"Renew passport","fields":{}}}"#)
        _ = try await client.capture("Renew passport tomorrow", typedAt: Date(timeIntervalSince1970: 1_792_072_800), key: key)
        #expect(stub.body()["text"] as? String == "Renew passport tomorrow")
        #expect(stub.body()["at"] as? String == "2026-10-15T14:00:00.000Z")

        stub.reply(201, #"{"task":\#(Sample.taskJSON),"parsed":{"title":"Renew passport","fields":{}}}"#)
        _ = try await client.capture("Typed just now")
        #expect(stub.body()["at"] == nil && stub.last.value(forHTTPHeaderField: "Idempotency-Key") == nil)
    }

    @Test("the whole list is fetched a page at a time")
    func paging() async throws {
        let summary = #"{"open":3,"in_progress":0,"blocked":0,"overdue":0,"due_today":0,"claude":0,"done_7d":0}"#
        func page(_ ids: [Int]) -> String {
            let tasks = ids.map { #"{"id":\#($0),"title":"T\#($0)","notes":"","status":"todo","priority":"medium","due":null,"project":null,"tags":[],"assignee":"me","subtasks":[],"repeat":null,"remindAt":null,"remindedAt":null,"rev":1,"createdBy":"me","createdAt":"2026-10-05T14:58:12.345Z","updatedAt":"2026-10-05T14:58:12.345Z","completedAt":null,"comments":0}"# }
            return #"{"tasks":[\#(tasks.joined(separator: ","))],"total":5,"summary":\#(summary),"version":42}"#
        }
        stub.reply(200, page([1, 2]))
        stub.reply(200, page([3, 4]))
        stub.reply(200, page([5]))
        let snapshot = try await client.allTasks(pageSize: 2)
        #expect(snapshot.tasks.map(\.id) == [1, 2, 3, 4, 5])
        #expect(snapshot.version == 42)
        #expect(snapshot.summary.open == 3)
        #expect(stub.requests.map { $0.url?.query } == ["limit=2&offset=0&status=all", "limit=2&offset=2&status=all", "limit=2&offset=4&status=all"])
    }

    // MARK: What can come back

    @Test("a conflict carries the task as it is now on the Mac")
    func conflict() async throws {
        stub.reply(409, #"{"error":{"code":"conflict","message":"Todo #7 has changed since you loaded it (it is now at revision 4)","current":\#(Sample.taskJSON)}}"#)
        await #expect(throws: HubError.conflict(current: Sample.task)) {
            try await client.update(7, rev: 3, TaskPatch(title: "Mine"))
        }
    }

    @Test("each kind of refusal becomes its own error", arguments: [
        (401, #"{"error":{"code":"unauthorized","message":"That access token is not valid."}}"#, HubError.unauthorized),
        (403, #"{"error":{"code":"forbidden_user","message":"This Tailscale account is not allowed to use Todos on this Mac."}}"#,
         HubError.forbidden(code: "forbidden_user", message: "This Tailscale account is not allowed to use Todos on this Mac.")),
        (403, #"{"error":"Forbidden host"}"#, HubError.remoteAccessOff),
        (404, #"{"error":{"code":"not_found","message":"No todo with id #7"}}"#, HubError.notFound(message: "No todo with id #7")),
        (428, #"{"error":{"code":"precondition_required","message":"Say which revision you are changing"}}"#, HubError.preconditionRequired),
        (400, #"{"error":{"code":"invalid","message":"Title cannot be empty"}}"#, HubError.invalid(code: "invalid", message: "Title cannot be empty")),
        (413, #"{"error":{"code":"too_large","message":"Request body too large"}}"#, HubError.invalid(code: "too_large", message: "Request body too large")),
        (502, "Bad Gateway", HubError.todosNotRunning),
        (503, #"{"error":{"code":"busy","message":"Too many live connections."}}"#, HubError.busy),
        (500, #"{"error":{"code":"internal","message":"Internal error"}}"#, HubError.server(status: 500, code: "internal", message: "Internal error")),
        (409, #"{"error":{"code":"conflict","message":"no task attached"}}"#, HubError.server(status: 409, code: "conflict", message: "no task attached")),
    ])
    func refusals(status: Int, body: String, expected: HubError) async throws {
        stub.reply(status, body)
        await #expect(throws: expected) { try await client.task(7) }
    }

    @Test("being rate limited says how long to wait")
    func rateLimited() async throws {
        stub.reply(429, #"{"error":{"code":"rate_limited","message":"Too many changes in a short time."}}"#, headers: ["Retry-After": "17"])
        await #expect(throws: HubError.rateLimited(retryAfter: 17)) { try await client.addComment(7, text: "x") }
        stub.reply(429, "{}")
        await #expect(throws: HubError.rateLimited(retryAfter: nil)) { try await client.addComment(7, text: "x") }
    }

    @Test("a request that gets no answer reports why")
    func transportFailures() async throws {
        stub.fail(.timedOut)
        await #expect(throws: HubError.transport(.timedOut)) { try await client.allTasks() }
    }

    @Test("an answer that isn't what the API documents is reported, not guessed at")
    func badResponse() async throws {
        stub.reply(200, "<html>captive portal</html>")
        await #expect(throws: HubError.badResponse) { try await client.task(7) }
    }

    // MARK: Secrets

    @Test("the token never appears when a client or credentials are printed or dumped")
    func tokenStaysOutOfDescriptions() {
        let credentials = Sample.credentials()
        var dumped = ""
        dump(credentials, to: &dumped)
        dump(client, to: &dumped)
        let printed = [String(describing: credentials), String(reflecting: credentials), String(describing: client), String(reflecting: client), "\(credentials)", dumped]
        for text in printed {
            #expect(!text.contains(Sample.token))
        }
        #expect(String(describing: credentials).contains("my-mac.tail1234.ts.net"))
    }

    @Test("what gets logged about a failure names its kind and nothing the user wrote")
    func logNames() {
        let errors: [HubError] = [.unauthorized, .forbidden(code: "forbidden_user", message: "private message"), .remoteAccessOff, .notFound(message: "No todo with id #7"),
                                  .conflict(current: Sample.task), .preconditionRequired, .invalid(code: "invalid", message: "Title cannot be empty"), .rateLimited(retryAfter: 3),
                                  .busy, .todosNotRunning, .server(status: 500, code: "internal", message: "private message"), .transport(.timedOut), .badResponse]
        #expect(errors.map(\.logName) == ["unauthorized", "forbidden(forbidden_user)", "remoteAccessOff", "notFound", "conflict", "preconditionRequired", "invalid(invalid)",
                                          "rateLimited", "busy", "todosNotRunning", "server(500)", "transport(-1001)", "badResponse"])
        for name in errors.map(\.logName) {
            #expect(!name.contains("passport") && !name.contains("private") && !name.contains("#7") && !name.contains("Title"))
        }
    }

    @Test("the URL session keeps no cookies, cache or stored credentials")
    func sessionConfiguration() {
        let c = HubClient.configuration()
        #expect(c.urlCache == nil)
        #expect(c.httpCookieStorage == nil)
        #expect(c.urlCredentialStorage == nil)
        #expect(c.httpShouldSetCookies == false)
    }
}

@Suite("Version checks")
struct CompatibilityTests {
    @Test("the app needs API version 1, at revision 3 or later")
    func rules() {
        #expect(Compatibility(ServerMeta(version: 1, revision: 3)) == .compatible)
        #expect(Compatibility(ServerMeta(version: 1, revision: 9)) == .compatible, "later revisions only add things")
        #expect(Compatibility(ServerMeta(version: 1, revision: 2)) == .serverTooOld(revision: 2), "Todos 1.5: no safe retries")
        #expect(Compatibility(ServerMeta(version: 1, revision: 1)) == .serverTooOld(revision: 1))
        #expect(Compatibility(ServerMeta(version: 2, revision: 1)) == .serverTooNew(version: 2))
        #expect(Compatibility(ServerMeta(version: 0, revision: 5)) == .serverTooOld(revision: 5))
        #expect(Compatibility.requiredRevision == 3 && Compatibility.apiVersion == 1)
    }

    @Test("a current Mac is compatible")
    func current() async throws {
        let stub = StubTransport()
        stub.reply(200, #"{"api":{"version":1,"revision":3},"app":{"name":"Todos","version":"1.6.0"}}"#)
        let check = try await Sample.client(stub).checkCompatibility()
        #expect(check.result == .compatible)
        #expect(check.meta?.app?.version == "1.6.0")
    }

    @Test("Todos 1.4 has no /meta, and its 404 means too old")
    func tooOld() async throws {
        let stub = StubTransport()
        stub.reply(404, #"{"error":{"code":"not_found","message":"No such endpoint."}}"#)
        let check = try await Sample.client(stub).checkCompatibility()
        #expect(check.result == .serverTooOld(revision: 1))
        #expect(check.meta == nil)
    }

    @Test("a Mac that speaks a later API version is too new, even with fields this app doesn't know")
    func tooNew() async throws {
        let stub = StubTransport()
        stub.reply(200, #"{"api":{"version":2,"revision":1,"flavour":"new"},"app":{"name":"Todos","version":"3.0.0"},"extra":true}"#)
        #expect(try await Sample.client(stub).checkCompatibility().result == .serverTooNew(version: 2))

        stub.reply(200, #"{"protocol":"something else entirely"}"#)
        guard case .serverTooNew = try await Sample.client(stub).checkCompatibility().result else {
            Issue.record("an unreadable /meta should count as too new")
            return
        }
    }

    @Test("a refused or failed check is an error, not a verdict")
    func failures() async throws {
        let stub = StubTransport()
        stub.reply(401, #"{"error":{"code":"unauthorized","message":"That access token is not valid."}}"#)
        await #expect(throws: HubError.unauthorized) { try await Sample.client(stub).checkCompatibility() }
    }

    @Test("each verdict has its own explanation")
    func wording() {
        #expect(ConnectionIssue(.serverTooOld(revision: 1)) == .serverTooOld)
        #expect(ConnectionIssue(.serverTooNew(version: 2)) == .serverTooNew)
        #expect(ConnectionIssue.serverTooOld.action == "Update Todos on your Mac.")
        #expect(ConnectionIssue.serverTooNew.action == "Update Todos on this iPhone.")
        #expect(ConnectionIssue.serverTooOld.explanation.contains("1.6"))
    }
}
