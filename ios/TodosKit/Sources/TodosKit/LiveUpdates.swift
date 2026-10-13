// Live updates: the Mac's server-sent event stream (GET /events).
//
// The stream says only that the list changed and its new version; the app then
// fetches what it needs. A comment line arrives every 25 seconds, so a connection
// that is silent for a minute is treated as dead.

import Foundation

/// Reads server-sent events from bytes as they arrive.
///
/// Framing is done here rather than with URLSession's `lines`, which drops the
/// blank lines that mark where one event ends.
public struct SSEParser: Sendable {
    public struct Message: Sendable, Equatable {
        public var event: String
        public var data: String
    }

    private var line: [UInt8] = []
    private var event = ""
    private var data: [String] = []
    private var afterCarriageReturn = false

    public init() {}

    /// Feeds one byte. Returns a message when this byte completes one.
    public mutating func feed(_ byte: UInt8) -> Message? {
        if byte == 0x0A, afterCarriageReturn { // the LF of a CRLF: the line already ended at the CR
            afterCarriageReturn = false
            return nil
        }
        afterCarriageReturn = byte == 0x0D
        guard byte == 0x0A || byte == 0x0D else {
            line.append(byte)
            return nil
        }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty { return dispatch() }
        if line[0] == UInt8(ascii: ":") { return nil } // a comment, sent as a heartbeat
        let text = String(decoding: line, as: UTF8.self)
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }

    public mutating func feed(_ bytes: some Sequence<UInt8>) -> [Message] {
        bytes.compactMap { feed($0) }
    }

    private mutating func dispatch() -> Message? {
        defer {
            event = ""
            data.removeAll()
        }
        guard !data.isEmpty else { return nil }
        return Message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
    }
}

public enum HubEvent: Sendable, Equatable {
    /// Sent once when the stream opens, with the list's current version.
    case hello(version: Int)
    /// Something in the list changed.
    case change(version: Int)

    init?(_ message: SSEParser.Message) {
        struct Payload: Decodable { var version: Int }
        guard let version = (try? JSONDecoder().decode(Payload.self, from: Data(message.data.utf8)))?.version else { return nil }
        switch message.event {
        case "hello": self = .hello(version: version)
        case "change": self = .change(version: version)
        default: return nil
        }
    }

    public var version: Int {
        switch self {
        case .hello(let version), .change(let version): version
        }
    }
}

extension HubClient {
    /// One connection to the event stream. It finishes when the Mac closes it (which it
    /// does when the token is rotated or remote access is switched off) and throws a
    /// `HubError` when the connection fails or is refused.
    public func events() -> AsyncThrowingStream<HubEvent, Error> {
        var streaming = request("GET", "/events", headers: ["Accept": "text/event-stream"])
        streaming.timeoutInterval = 60
        let request = streaming
        let session = session
        return AsyncThrowingStream { continuation in
            let reading = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw HubError.badResponse }
                    guard http.statusCode == 200 else {
                        var body = Data()
                        for try await byte in bytes.prefix(64_000) { body.append(byte) }
                        throw HubError.from(status: http.statusCode, data: body, headers: Self.headers(of: http))
                    }
                    var parser = SSEParser()
                    for try await byte in bytes {
                        if let message = parser.feed(byte), let event = HubEvent(message) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch let error as URLError where error.code != .cancelled {
                    continuation.finish(throwing: HubError.transport(error.code))
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
    }
}

/// The state of the live connection, for the app to act on and to show.
public enum LiveState: Sendable, Equatable {
    case connecting
    /// Connected. `version` is the list's version right now.
    case live(version: Int)
    /// The list changed while connected.
    case changed(version: Int)
    /// The connection was lost or refused. Another attempt follows after `retryIn` seconds.
    case waiting(HubError, retryIn: TimeInterval)
    /// The token no longer works. Nothing more is tried: wrong tokens are rate limited, and only pairing again can fix it.
    case stopped(HubError)
}

/// Keeps a live connection to the Mac, reconnecting with growing pauses when it drops.
public struct LiveUpdates: Sendable {
    let client: HubClient
    let pauses: [TimeInterval]

    public init(client: HubClient, pauses: [TimeInterval] = [1, 2, 4, 8, 15, 30]) {
        self.client = client
        self.pauses = pauses.isEmpty ? [5] : pauses
    }

    /// Runs until the consumer stops listening or its task is cancelled.
    public func states() -> AsyncStream<LiveState> {
        AsyncStream { continuation in
            let running = Task {
                var failures = 0
                while !Task.isCancelled {
                    continuation.yield(.connecting)
                    var failure = HubError.transport(.networkConnectionLost) // what a clean close by the Mac counts as
                    do {
                        for try await event in client.events() {
                            failures = 0
                            switch event {
                            case .hello(let version): continuation.yield(.live(version: version))
                            case .change(let version): continuation.yield(.changed(version: version))
                            }
                        }
                    } catch HubError.unauthorized {
                        continuation.yield(.stopped(.unauthorized))
                        break
                    } catch let error as HubError {
                        failure = error
                    } catch {
                        failure = .badResponse
                    }
                    if Task.isCancelled { break }
                    var pause = pauses[min(failures, pauses.count - 1)]
                    if case .rateLimited(let retryAfter?) = failure { pause = max(pause, retryAfter) }
                    failures += 1
                    continuation.yield(.waiting(failure, retryIn: pause))
                    try? await Task.sleep(for: .seconds(pause))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in running.cancel() }
        }
    }
}
