// Why the Mac can't be reached, in words: what is wrong, and what to do about it.

import Foundation

public enum ConnectionIssue: Sendable, Equatable {
    case tailscaleOff
    case macUnreachable
    case addressNotFound
    case todosNotRunning
    case remoteAccessOff
    case wrongTailscaleAccount
    case tokenRevoked
    case serverTooOld
    case serverTooNew
    case rateLimited(retryAfter: TimeInterval?)
    case insecureConnection
    case tooManyConnections
    case other(String)

    /// A short name for the problem.
    public var title: String {
        switch self {
        case .tailscaleOff: "Tailscale isn’t connected"
        case .macUnreachable: "Can’t reach your Mac"
        case .addressNotFound: "Address not found"
        case .todosNotRunning: "Todos isn’t running on your Mac"
        case .remoteAccessOff: "Remote access is off"
        case .wrongTailscaleAccount: "Different Tailscale account"
        case .tokenRevoked: "Access token no longer works"
        case .serverTooOld: "Todos on your Mac is out of date"
        case .serverTooNew: "This app is out of date"
        case .rateLimited: "Too many attempts"
        case .insecureConnection: "Secure connection failed"
        case .tooManyConnections: "Too many devices connected"
        case .other: "Something went wrong"
        }
    }

    /// One line on what is wrong.
    public var explanation: String {
        switch self {
        case .tailscaleOff: "This iPhone reaches your Mac through Tailscale, and it isn’t connected."
        case .macUnreachable: "Your Mac may be asleep, switched off, or not on Tailscale."
        case .addressNotFound: "Your tailnet doesn’t know the address this iPhone was paired with."
        case .todosNotRunning: "Your Mac answered, but the Todos app isn’t open on it."
        case .remoteAccessOff: "Todos on your Mac isn’t allowing access from other devices."
        case .wrongTailscaleAccount: "This iPhone is signed in to Tailscale as someone other than the Mac’s owner."
        case .tokenRevoked: "The token was probably rotated on your Mac, which signs every device out."
        case .serverTooOld: "This app needs Todos \(Compatibility.requiredAppVersion) or later on your Mac."
        case .serverTooNew: "Todos on your Mac is newer than this app understands."
        case .rateLimited(let retryAfter):
            retryAfter.map { "Your Mac is refusing requests for the next \(Int($0.rounded(.up))) seconds." } ?? "Your Mac is refusing requests for a short while."
        case .insecureConnection: "The encrypted connection to your Mac couldn’t be set up."
        case .tooManyConnections: "Your Mac has too many live connections open."
        case .other(let detail): detail
        }
    }

    /// What to do about it.
    public var action: String {
        switch self {
        case .tailscaleOff: "Open the Tailscale app and connect."
        case .macUnreachable: "Wake your Mac and check that Tailscale is running on it."
        case .addressNotFound: "Check the address in Settings, or pair again."
        case .todosNotRunning: "Open Todos on your Mac. Turning on Launch at Login keeps it running."
        case .remoteAccessOff: "On your Mac, choose Todos → Remote Access → Allow Access from My Other Devices."
        case .wrongTailscaleAccount: "Sign in to Tailscale with the Mac’s account, or turn off Only My Tailscale Account on the Mac."
        case .tokenRevoked: "Pair this iPhone again with the new token."
        case .serverTooOld: "Update Todos on your Mac."
        case .serverTooNew: "Update Todos on this iPhone."
        case .rateLimited: "Wait a moment, then try again."
        case .insecureConnection: "Try again in a minute. A new address can take that long to get its certificate."
        case .tooManyConnections: "Close Todos on another device, then try again."
        case .other: "Try again."
        }
    }

    /// True when only pairing again can fix it.
    public var needsPairing: Bool {
        self == .tokenRevoked
    }

    /// True when trying again by itself might work, so the app keeps retrying quietly.
    public var mayClearByItself: Bool {
        switch self {
        case .tokenRevoked, .serverTooOld, .serverTooNew, .wrongTailscaleAccount: false
        default: true
        }
    }

    /// Works out the issue behind a failed request. `tailscaleConnected` is whether this
    /// device currently has a Tailscale address (see `Tailscale.isConnected`).
    public init(_ error: HubError, tailscaleConnected: Bool) {
        switch error {
        case .unauthorized:
            self = .tokenRevoked
        case .remoteAccessOff:
            self = .remoteAccessOff
        case .forbidden(let code, let message):
            self = code == "forbidden_user" ? .wrongTailscaleAccount : .other(message.isEmpty ? "Your Mac refused the connection." : message)
        case .todosNotRunning:
            self = .todosNotRunning
        case .rateLimited(let retryAfter):
            self = .rateLimited(retryAfter: retryAfter)
        case .busy:
            self = .tooManyConnections
        case .transport(let code):
            switch code {
            case _ where !tailscaleConnected:
                self = .tailscaleOff
            case .cannotFindHost, .dnsLookupFailed:
                self = .addressNotFound
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
                 .serverCertificateHasUnknownRoot, .clientCertificateRejected, .appTransportSecurityRequiresSecureConnection:
                self = .insecureConnection
            default:
                self = .macUnreachable
            }
        case .badResponse:
            self = .other("Your Mac sent an answer this app couldn’t read.")
        case .server(let status, _, let message):
            self = .other(message ?? "Your Mac answered with an error (\(status)).")
        case .notFound(let message), .invalid(_, let message):
            self = .other(message)
        case .conflict, .preconditionRequired:
            self = .other("The task changed on your Mac.")
        }
    }

    public init(_ compatibility: Compatibility) {
        switch compatibility {
        case .serverTooOld: self = .serverTooOld
        case .serverTooNew: self = .serverTooNew
        case .compatible: self = .other("")
        }
    }
}

public enum Tailscale {
    /// Whether this device has a Tailscale address right now.
    ///
    /// There is no way to ask the Tailscale app directly, so this looks at the network
    /// interfaces: Tailscale gives its tunnel an address in 100.64.0.0/10 (or its own
    /// IPv6 range). Only tunnel interfaces count, since some mobile carriers hand
    /// out addresses from the same IPv4 range.
    public static func isConnected() -> Bool {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return false }
        defer { freeifaddrs(list) }
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let interface = pointer.pointee
            guard let address = interface.ifa_addr, (interface.ifa_flags & UInt32(IFF_UP)) != 0,
                  String(cString: interface.ifa_name).hasPrefix("utun") else { continue }
            switch Int32(address.pointee.sa_family) {
            case AF_INET:
                let ip = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                if isTailscaleIPv4(ip) { return true }
            case AF_INET6:
                let bytes = address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0.prefix(6)) } }
                if bytes == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] { return true }
            default:
                break
            }
        }
        return false
    }

    /// 100.64.0.0/10, the range Tailscale assigns from.
    static func isTailscaleIPv4(_ address: UInt32) -> Bool {
        address & 0xFFC0_0000 == 0x6440_0000
    }
}
