// The client for /api/v1 on the Mac (docs/openapi.json).
//
// Every request carries the access token as a bearer token and names this client
// so the Mac's activity log can say "You · iPhone". Nothing is cached or stored by
// the URL session, and nothing here logs: not tokens, not task content.

import Foundation

public struct HubClient: Sendable {
    /// Sends one request and returns the whole response. Replaced in unit tests.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public static let apiPath = "/api/v1"
    /// How the Mac labels this client's changes when no other name is given.
    public static let defaultClientName = "iPhone"

    public let address: HubAddress
    let token: String
    let clientName: String
    let session: URLSession
    let transport: Transport
    /// Extra headers on every request. Only tests set this, to stand in for Tailscale's relay.
    var extraHeaders: [String: String] = [:]

    public init(credentials: HubCredentials, clientName: String = HubClient.defaultClientName) {
        let session = URLSession(configuration: Self.configuration())
        self.init(credentials: credentials, clientName: clientName, session: session) { try await session.data(for: $0) }
    }

    init(credentials: HubCredentials, clientName: String = HubClient.defaultClientName, session: URLSession, transport: @escaping Transport) {
        address = credentials.address
        token = credentials.token
        self.clientName = clientName
        self.session = session
        self.transport = transport
    }

    /// No cookies, no cache, no credential storage: the token lives in the Keychain and
    /// task content lives in the app's own cache, not in URLSession's.
    static func configuration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.urlCredentialStorage = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        return c
    }

    // MARK: Compatibility

    /// What the Mac speaks. Todos 1.4 has no such endpoint and answers 404.
    public func meta() async throws -> ServerMeta {
        try await get("/meta")
    }

    // MARK: Tasks

    public struct TaskPage: Decodable, Sendable {
        public var tasks: [TodoTask]
        /// How many tasks match, before limit and offset.
        public var total: Int
        public var summary: Counts
        /// The version of the whole list, the number live updates announce. Missing from Todos 1.4.
        public var version: Int?
    }

    public struct TaskSnapshot: Sendable, Equatable {
        public var tasks: [TodoTask]
        public var summary: Counts
        public var version: Int?
    }

    /// One page of tasks, in the Mac's order. `status` is "open", "all", or statuses joined by commas.
    public func tasks(status: String = "all", limit: Int = 500, offset: Int = 0) async throws -> TaskPage {
        try await get("/tasks", query: ["status": status, "limit": String(limit), "offset": String(offset)])
    }

    /// Every task, fetched a page at a time. Tasks in a list come without their history.
    public func allTasks(pageSize: Int = 500) async throws -> TaskSnapshot {
        var page = try await tasks(limit: pageSize)
        var all = page.tasks
        while all.count < page.total, !page.tasks.isEmpty {
            page = try await tasks(limit: pageSize, offset: all.count)
            all += page.tasks
        }
        return TaskSnapshot(tasks: all, summary: page.summary, version: page.version)
    }

    /// One task, with its full history.
    public func task(_ id: Int) async throws -> TodoTask {
        try await taskResult("GET", "/tasks/\(id)").task
    }

    /// An edit's outcome. `next` is the new occurrence when a repeating task was completed.
    public struct TaskResult: Decodable, Sendable, Equatable {
        public var task: TodoTask
        public var next: TodoTask?
    }

    /// Edits a task. `rev` is the revision the edit is based on: if the task has
    /// changed since, this throws `HubError.conflict` with the current task and nothing is changed.
    public func update(_ id: Int, rev: Int, _ patch: TaskPatch, key: UUID? = nil) async throws -> TaskResult {
        try await taskResult("PATCH", "/tasks/\(id)", body: patch, headers: Self.keyed(key, ["If-Match": "\"\(rev)\""]))
    }

    /// Deletes a task, with the same revision check as `update`.
    public func delete(_ id: Int, rev: Int) async throws {
        _ = try await send("DELETE", "/tasks/\(id)", headers: ["If-Match": "\"\(rev)\""])
    }

    /// A change that might be sent twice (a retry after a lost answer, or a change
    /// queued while offline) carries a key. The Mac makes it once.
    static func keyed(_ key: UUID?, _ headers: [String: String] = [:]) -> [String: String] {
        guard let key else { return headers }
        return headers.merging(["Idempotency-Key": key.uuidString]) { $1 }
    }

    /// Marks a task done. Needs no revision: completing can't overwrite anyone's work.
    public func complete(_ id: Int, comment: String? = nil, key: UUID? = nil) async throws -> TaskResult {
        try await taskResult("POST", "/tasks/\(id)/complete", body: comment.map { ["comment": $0] }, headers: Self.keyed(key))
    }

    // MARK: Subtasks and comments (additive: no revision needed)

    public func addSubtask(_ id: Int, title: String, key: UUID? = nil) async throws -> TodoTask {
        try await taskResult("POST", "/tasks/\(id)/subtasks", body: ["title": title], headers: Self.keyed(key)).task
    }

    public func setSubtask(_ id: Int, subtask: Int, done: Bool, key: UUID? = nil) async throws -> TodoTask {
        try await taskResult("PATCH", "/tasks/\(id)/subtasks/\(subtask)", body: ["done": done], headers: Self.keyed(key)).task
    }

    public func renameSubtask(_ id: Int, subtask: Int, title: String, key: UUID? = nil) async throws -> TodoTask {
        try await taskResult("PATCH", "/tasks/\(id)/subtasks/\(subtask)", body: ["title": title], headers: Self.keyed(key)).task
    }

    public func removeSubtask(_ id: Int, subtask: Int, key: UUID? = nil) async throws -> TodoTask {
        try await taskResult("DELETE", "/tasks/\(id)/subtasks/\(subtask)", headers: Self.keyed(key)).task
    }

    public func addComment(_ id: Int, text: String, key: UUID? = nil) async throws -> TodoTask {
        try await taskResult("POST", "/tasks/\(id)/comments", body: ["text": text], headers: Self.keyed(key)).task
    }

    // MARK: Quick capture

    public struct Captured: Decodable, Sendable, Equatable {
        public var task: TodoTask
        public var parsed: ParsedCapture
    }

    /// Adds a task from one line, read by the Mac exactly as its own capture box reads it.
    /// `typedAt` is when the line was typed, if that was earlier: "tomorrow" is then read from that moment.
    public func capture(_ line: String, typedAt: Date? = nil, key: UUID? = nil) async throws -> Captured {
        var body = ["text": line]
        if let typedAt { body["at"] = HubJSON.string(from: typedAt) }
        return try decode(await send("POST", "/capture", body: body, headers: Self.keyed(key)).data)
    }

    /// Creates a task with these fields: how a task deleted on the Mac is brought back.
    public func create(like task: TodoTask, key: UUID? = nil) async throws -> TodoTask {
        struct Body: Encodable, Sendable {
            var title: String
            var notes: String
            var status: TaskStatus
            var priority: TaskPriority
            var assignee: TaskAssignee
            var tags: [String]
            var due: Day?
            var project: String?
            var `repeat`: TaskRepeat?
            var remindAt: Date?
            var subtasks: [String]
        }
        let body = Body(title: task.title, notes: task.notes, status: task.status, priority: task.priority, assignee: task.assignee, tags: task.tags,
                        due: task.due, project: task.project, repeat: task.repeats, remindAt: task.remindAt, subtasks: task.subtasks.map(\.title))
        return try await taskResult("POST", "/tasks", body: body, headers: Self.keyed(key)).task
    }

    /// How the Mac would read a line, without adding anything.
    public func preview(_ line: String) async throws -> ParsedCapture {
        try decode(await send("POST", "/capture/preview", body: ["text": line]).data)
    }

    // MARK: Requests

    func request(_ method: String, _ path: String, query: [String: String] = [:], headers: [String: String] = [:]) -> URLRequest {
        var parts = URLComponents(url: address.url, resolvingAgainstBaseURL: false)!
        parts.path = Self.apiPath + path
        if !query.isEmpty {
            parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(clientName, forHTTPHeaderField: "X-Todos-Client")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in extraHeaders { request.setValue(value, forHTTPHeaderField: name) }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try decode(await send("GET", path, query: query).data)
    }

    private func taskResult(_ method: String, _ path: String, headers: [String: String] = [:]) async throws -> TaskResult {
        try decode(await send(method, path, headers: headers).data)
    }

    private func taskResult(_ method: String, _ path: String, body: (some Encodable & Sendable)?, headers: [String: String] = [:]) async throws -> TaskResult {
        try decode(await send(method, path, body: body, headers: headers).data)
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try HubJSON.decoder().decode(T.self, from: data)
        } catch {
            throw HubError.badResponse
        }
    }

    @discardableResult
    func send(_ method: String, _ path: String, query: [String: String] = [:], headers: [String: String] = [:]) async throws -> (data: Data, response: HTTPURLResponse) {
        try await perform(request(method, path, query: query, headers: headers))
    }

    @discardableResult
    func send(_ method: String, _ path: String, body: (some Encodable & Sendable)?, headers: [String: String] = [:]) async throws -> (data: Data, response: HTTPURLResponse) {
        var request = request(method, path, headers: headers)
        if let body {
            request.httpBody = try HubJSON.encoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw HubError.transport(error.code)
        }
        guard let http = response as? HTTPURLResponse else { throw HubError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw HubError.from(status: http.statusCode, data: data, headers: Self.headers(of: http))
        }
        return (data, http)
    }

    static func headers(of response: HTTPURLResponse) -> [String: String] {
        var out: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, let value = value as? String { out[name] = value }
        }
        return out
    }
}

extension HubClient: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "HubClient(\(address))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["address": address]) }
}
