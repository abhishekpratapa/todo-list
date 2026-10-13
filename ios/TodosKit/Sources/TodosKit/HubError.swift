// What can go wrong talking to the Mac, in the terms the app needs to react to.

import Foundation

public enum HubError: Error, Sendable, Equatable {
    /// 401. The access token is wrong, or was rotated on the Mac.
    case unauthorized
    /// 403 from the API: `forbidden_user` (another Tailscale account), `forbidden_host`, `forbidden` (Funnel).
    case forbidden(code: String, message: String)
    /// 403 in the Mac's older, pre-API error shape: remote access is switched off there.
    case remoteAccessOff
    /// 404.
    case notFound(message: String)
    /// 409. The task changed since the revision the edit was based on. Nothing was changed.
    case conflict(current: TodoTask)
    /// 409, for a habit: it changed since the revision the edit was based on.
    case habitConflict(current: Habit)
    /// 428. An edit or delete did not say which revision it was based on.
    case preconditionRequired
    /// 400, 413, 415. The Mac refused the input; `message` says why.
    case invalid(code: String, message: String)
    /// 429. Too many changes, or too many wrong tokens.
    case rateLimited(retryAfter: TimeInterval?)
    /// 503. Too many live-update connections are open.
    case busy
    /// 502. Tailscale answered for the Mac, but Todos is not running there.
    case todosNotRunning
    /// Any other HTTP failure.
    case server(status: Int, code: String?, message: String?)
    /// The request never got an answer: no route, timeout, TLS failure.
    case transport(URLError.Code)
    /// An answer that was not what the API documents.
    case badResponse

    /// A name for the log: which kind of failure, with nothing from the Mac's answer
    /// in it. Messages and conflicting tasks can contain what the user wrote.
    public var logName: String {
        switch self {
        case .unauthorized: "unauthorized"
        case .forbidden(let code, _): "forbidden(\(code))"
        case .remoteAccessOff: "remoteAccessOff"
        case .notFound: "notFound"
        case .conflict, .habitConflict: "conflict"
        case .preconditionRequired: "preconditionRequired"
        case .invalid(let code, _): "invalid(\(code))"
        case .rateLimited: "rateLimited"
        case .busy: "busy"
        case .todosNotRunning: "todosNotRunning"
        case .server(let status, _, _): "server(\(status))"
        case .transport(let code): "transport(\(code.rawValue))"
        case .badResponse: "badResponse"
        }
    }

    /// The Mac's own wording, where there is one worth showing.
    public var serverMessage: String? {
        switch self {
        case .forbidden(_, let message), .notFound(let message), .invalid(_, let message): message
        case .server(_, _, let message): message
        default: nil
        }
    }
}

extension HubError {
    private struct Envelope: Decodable {
        struct Detail: Decodable {
            var code: String?
            var message: String?
            /// What a conflict was with: a task, or a habit.
            var current: TodoTask?
            var currentHabit: Habit?

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                code = try? c.decode(String.self, forKey: .code)
                message = try? c.decode(String.self, forKey: .message)
                current = try? c.decode(TodoTask.self, forKey: .current)
                currentHabit = current == nil ? try? c.decode(Habit.self, forKey: .current) : nil
            }

            enum CodingKeys: String, CodingKey { case code, message, current }
        }

        var error: Detail?
        var plain: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let text = try? c.decode(String.self, forKey: .error) {
                plain = text
            } else {
                error = try? c.decode(Detail.self, forKey: .error)
            }
        }

        enum CodingKeys: String, CodingKey { case error }
    }

    /// Reads a failed response. /api/v1 answers `{"error": {"code", "message"}}`; the
    /// Mac's older routes, which answer when remote access is off, send `{"error": "text"}`.
    static func from(status: Int, data: Data, headers: [String: String]) -> HubError {
        let envelope = try? HubJSON.decoder().decode(Envelope.self, from: data)
        let code = envelope?.error?.code
        let message = envelope?.error?.message ?? envelope?.plain
        switch status {
        case 401:
            return .unauthorized
        case 403:
            guard let code else { return .remoteAccessOff }
            return .forbidden(code: code, message: message ?? "")
        case 404:
            return .notFound(message: message ?? "Not found")
        case 409:
            if let current = envelope?.error?.current { return .conflict(current: current) }
            if let current = envelope?.error?.currentHabit { return .habitConflict(current: current) }
            return .server(status: status, code: code, message: message)
        case 428:
            return .preconditionRequired
        case 400, 413, 415:
            return .invalid(code: code ?? "invalid", message: message ?? "The Mac refused that.")
        case 429:
            let retry = headers.first { $0.key.lowercased() == "retry-after" }.flatMap { TimeInterval($0.value) }
            return .rateLimited(retryAfter: retry)
        case 502:
            return .todosNotRunning
        case 503 where code == "busy":
            return .busy
        default:
            return .server(status: status, code: code, message: message)
        }
    }
}
