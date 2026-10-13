// Where the Mac is, and what the "Pair iPhone" code on the Mac says.

import Foundation

/// The Mac's address on the tailnet. Always HTTPS, and never more than scheme, host and port.
public struct HubAddress: Sendable, Hashable, Codable, CustomStringConvertible {
    public enum Invalid: Error, Sendable, Equatable {
        case empty
        /// Plain http was given. Todos is only reachable over HTTPS.
        case notHTTPS
        case malformed
    }

    public let url: URL

    /// Accepts what someone might paste: "my-mac.tailnet.ts.net", with or without
    /// "https://", a port, or a trailing path. Anything that is not HTTPS is refused.
    public init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Invalid.empty }
        let text = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased() else { throw Invalid.malformed }
        guard scheme == "https" else {
            if scheme == "http" { throw Invalid.notHTTPS }
            throw Invalid.malformed
        }
        guard let host = parts.host?.lowercased(), !host.isEmpty, parts.user == nil, parts.password == nil,
              host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }) else { throw Invalid.malformed }
        // "name:" with no port number after it is some other kind of link, not a host and port.
        let authority = text.dropFirst(scheme.count + 3).prefix { !"/?#".contains($0) }
        guard !authority.contains(":") || parts.port != nil else { throw Invalid.malformed }
        var clean = URLComponents()
        clean.scheme = "https"
        clean.host = host
        if let port = parts.port, port != 443 {
            guard (1...65535).contains(port) else { throw Invalid.malformed }
            clean.port = port
        }
        guard let url = clean.url else { throw Invalid.malformed }
        self.url = url
    }

    /// For tests only: a server on this machine, reached without TLS. Loopback
    /// addresses are the one place that is safe, and App Transport Security agrees.
    init(loopbackPort port: Int) {
        url = URL(string: "http://127.0.0.1:\(port)")!
    }

    public var host: String { url.host() ?? "" }

    /// "my-mac.tailnet.ts.net", or with ":8443" when it is not the usual port.
    public var description: String {
        url.port.map { "\(host):\($0)" } ?? host
    }

    public init(from decoder: Decoder) throws {
        try self.init(decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(url.absoluteString)
    }
}

/// The address and access token this iPhone uses. The token is a secret: this type
/// keeps it out of anything that prints or logs.
public struct HubCredentials: Sendable, Equatable, Codable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var address: HubAddress
    public var token: String

    public enum Invalid: Error, Sendable, Equatable {
        case emptyToken
        /// Tokens have no spaces or line breaks; this is probably something else that was pasted.
        case malformedToken
    }

    public init(address: HubAddress, token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Invalid.emptyToken }
        guard trimmed.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 0x20 && $0.value < 0x7f }) else { throw Invalid.malformedToken }
        self.address = address
        self.token = trimmed
    }

    public var description: String { "HubCredentials(\(address), token: <hidden>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["address": address, "token": "<hidden>"]) }
}

#if DEBUG
extension HubCredentials {
    /// Debug builds only: credentials for a Todos server on this same machine, reached
    /// without TLS. It is how the app is tried out in the Simulator against the test
    /// server (ios/scripts/test-server.mjs). Release builds have no way to make these.
    public static func loopbackForTesting(port: Int, token: String) -> HubCredentials? {
        guard (1...65535).contains(port) else { return nil }
        return try? HubCredentials(address: HubAddress(loopbackPort: port), token: token)
    }
}
#endif

/// What the QR code in the Mac's "Pair iPhone" window carries:
/// `todos-pair:?v=1&u=<address>&t=<token>`.
public struct PairingCode: Sendable, Equatable {
    public enum Invalid: Error, Sendable, Equatable {
        /// Some other QR code.
        case notAPairingCode
        /// A pairing code from a newer Todos on the Mac than this app understands.
        case newerFormat
    }

    public static let scheme = "todos-pair"

    public let credentials: HubCredentials

    public init(scanned text: String) throws {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == Self.scheme else { throw Invalid.notAPairingCode }
        let value = { (name: String) in parts.queryItems?.first { $0.name == name }?.value }
        guard let version = value("v").flatMap(Int.init) else { throw Invalid.notAPairingCode }
        guard version == 1 else { throw Invalid.newerFormat }
        guard let address = value("u"), let token = value("t"),
              let credentials = try? HubCredentials(address: HubAddress(address), token: token) else { throw Invalid.notAPairingCode }
        self.credentials = credentials
    }
}
