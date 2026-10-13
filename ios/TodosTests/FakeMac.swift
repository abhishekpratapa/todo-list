// A stand-in for the Mac, for testing the app's own behaviour: it keeps a list of
// tasks and answers the requests the app makes, with the same rules that matter
// here (revisions, conflicts, a token that can be revoked, being unreachable).
// The real server is tested against in TodosKit's integration tests.

import Foundation
@testable import TodosKit

final class FakeMac: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [TodoTask] = []
    private var listVersion = 1
    private var nextID = 1
    private var sent: [URLRequest] = []
    private var unreachable = false
    private var revoked = false
    private var revision = Compatibility.requiredRevision

    // MARK: What a test does to the Mac

    @discardableResult
    func add(_ title: String, _ change: (inout TodoTask) -> Void = { _ in }) -> TodoTask {
        lock.withLock {
            var task = TodoTask(id: nextID, title: title, activity: [])
            nextID += 1
            change(&task)
            tasks.append(task)
            listVersion += 1
            return task
        }
    }

    /// A change made on the Mac itself, by the user or a Claude session.
    func edit(_ id: Int, by: String = "Claude Code · repo", _ change: (inout TodoTask) -> Void) {
        lock.withLock {
            guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
            change(&tasks[index])
            tasks[index].rev += 1
            tasks[index].activity?.append(ActivityEntry(at: Date(), by: by, kind: .event, text: "changed it"))
            listVersion += 1
        }
    }

    func delete(_ id: Int) {
        lock.withLock {
            tasks.removeAll { $0.id == id }
            listVersion += 1
        }
    }

    func task(_ id: Int) -> TodoTask? { lock.withLock { tasks.first { $0.id == id } } }
    var all: [TodoTask] { lock.withLock { tasks } }
    var version: Int { lock.withLock { listVersion } }
    var requests: [URLRequest] { lock.withLock { sent } }
    /// Requests that change something.
    var writes: [URLRequest] { requests.filter { $0.httpMethod != "GET" && $0.url?.path.hasSuffix("/preview") == false } }

    var isUnreachable: Bool {
        get { lock.withLock { unreachable } }
        set { lock.withLock { unreachable = newValue } }
    }

    var tokenRevoked: Bool {
        get { lock.withLock { revoked } }
        set { lock.withLock { revoked = newValue } }
    }

    var apiRevision: Int {
        get { lock.withLock { revision } }
        set { lock.withLock { revision = newValue } }
    }

    func client(_ credentials: HubCredentials) -> HubClient {
        HubClient(credentials: credentials, session: .shared) { [self] request in
            let (status, body) = try lock.withLock { try respond(request) }
            return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }

    // MARK: Answering

    private func error(_ status: Int, _ code: String, _ message: String) -> (Int, Data) {
        (status, Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8))
    }

    private func answer(_ status: Int, _ value: some Encodable) -> (Int, Data) {
        (status, try! HubJSON.encoder().encode(value))
    }

    private struct TaskAnswer: Encodable {
        var task: TodoTask
        var next: TodoTask?
    }

    private func respond(_ request: URLRequest) throws -> (Int, Data) {
        sent.append(request)
        if unreachable { throw URLError(.timedOut) }
        if revoked { return error(401, "unauthorized", "That access token is not valid.") }
        let method = request.httpMethod ?? "GET"
        let parts = request.url!.path.replacingOccurrences(of: "/api/v1/", with: "").split(separator: "/").map(String.init)
        let body = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]

        switch (method, parts.first, parts.count) {
        case ("GET", "meta", 1):
            return (200, Data(#"{"api":{"version":1,"revision":\#(revision)},"app":{"name":"Todos","version":"1.6.0"}}"#.utf8))

        case ("GET", "tasks", 1):
            struct List: Encodable {
                var tasks: [TodoTask]
                var total: Int
                var summary: Counts
                var version: Int
            }
            let brief = tasks.inListOrder().map { task in
                var brief = task
                brief.comments = task.commentCount
                brief.activity = nil
                return brief
            }
            return answer(200, List(tasks: brief, total: brief.count, summary: tasks.counts(today: .today()), version: listVersion))

        case ("POST", "capture", 1):
            let line = body["text"] as? String ?? ""
            let key = request.value(forHTTPHeaderField: "Idempotency-Key")
            if let key, let existing = tasks.first(where: { $0.createdBy == key }) { // sent twice: answered once
                return (201, Data(#"{"task":\#(String(decoding: try! HubJSON.encoder().encode(existing), as: UTF8.self)),"parsed":{"title":"\#(line)","fields":{}}}"#.utf8))
            }
            var task = TodoTask(id: nextID, title: line, createdBy: key ?? "me", activity: [])
            task.activity = [ActivityEntry(at: Date(), by: "me", kind: .event, text: "created this task", via: "iPhone")]
            nextID += 1
            tasks.append(task)
            listVersion += 1
            return (201, Data(#"{"task":\#(String(decoding: try! HubJSON.encoder().encode(task), as: UTF8.self)),"parsed":{"title":"\#(line)","fields":{}}}"#.utf8))

        case ("POST", "capture", 2):
            return (200, Data(#"{"title":"\#(body["text"] as? String ?? "")","fields":{}}"#.utf8))

        case ("POST", "tasks", 1): // putting a deleted task back
            var task = TodoTask(id: nextID, title: body["title"] as? String ?? "", notes: body["notes"] as? String ?? "", activity: [])
            task.priority = (body["priority"] as? String).flatMap { TaskPriority(rawValue: $0) } ?? .medium
            task.subtasks = (body["subtasks"] as? [String] ?? []).enumerated().map { Subtask(id: $0.offset + 1, title: $0.element, done: false) }
            nextID += 1
            tasks.append(task)
            listVersion += 1
            return answer(201, TaskAnswer(task: task))

        default:
            break
        }

        guard parts.first == "tasks", parts.count >= 2, let id = Int(parts[1]) else { return error(404, "not_found", "No such endpoint.") }
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return error(404, "not_found", "No todo with id #\(id)") }
        let basedOn = request.value(forHTTPHeaderField: "If-Match").flatMap { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "\""))) }
        func conflict() -> (Int, Data) {
            (409, Data(#"{"error":{"code":"conflict","message":"changed","current":\#(String(decoding: try! HubJSON.encoder().encode(tasks[index]), as: UTF8.self))}}"#.utf8))
        }
        func changed(_ text: String, comment: Bool = false) {
            tasks[index].rev += 1
            tasks[index].activity?.append(ActivityEntry(at: Date(), by: "me", kind: comment ? .comment : .event, text: text, via: "iPhone"))
            listVersion += 1
        }

        switch (method, parts.count, parts.count > 2 ? parts[2] : "") {
        case ("GET", 2, _):
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("PATCH", 2, _):
            guard basedOn == tasks[index].rev else { return conflict() }
            let patch = try HubJSON.decoder().decode(TaskPatch.self, from: request.httpBody ?? Data())
            tasks[index] = patch.applied(to: tasks[index])
            changed("edited it")
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("DELETE", 2, _):
            guard basedOn == tasks[index].rev else { return conflict() }
            tasks.remove(at: index)
            listVersion += 1
            return (204, Data())
        case ("POST", 3, "complete"):
            tasks[index].status = .done
            changed("moved To do → Done")
            return answer(200, TaskAnswer(task: tasks[index]))
        case ("POST", 3, "comments"):
            changed(body["text"] as? String ?? "", comment: true)
            return answer(201, TaskAnswer(task: tasks[index]))
        case ("POST", 3, "subtasks"):
            let next = (tasks[index].subtasks.map(\.id).max() ?? 0) + 1
            tasks[index].subtasks.append(Subtask(id: next, title: body["title"] as? String ?? "", done: false))
            changed("added a subtask")
            return answer(201, TaskAnswer(task: tasks[index]))
        case ("PATCH", 4, "subtasks"):
            guard let subtask = tasks[index].subtasks.firstIndex(where: { $0.id == Int(parts[3]) }) else { return error(404, "not_found", "Task #\(id) has no subtask \(parts[3])") }
            if let done = body["done"] as? Bool { tasks[index].subtasks[subtask].done = done }
            changed("changed a subtask")
            return answer(200, TaskAnswer(task: tasks[index]))
        default:
            return error(404, "not_found", "No such endpoint.")
        }
    }
}
