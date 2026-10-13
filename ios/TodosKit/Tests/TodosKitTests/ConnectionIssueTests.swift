import Foundation
import Testing
@testable import TodosKit

@Suite("Connection problems")
struct ConnectionIssueTests {
    @Test("with no Tailscale address, any failure to connect is Tailscale being off", arguments: [URLError.Code.timedOut, .cannotFindHost, .cannotConnectToHost, .notConnectedToInternet, .secureConnectionFailed])
    func tailscaleOff(code: URLError.Code) {
        #expect(ConnectionIssue(.transport(code), tailscaleConnected: false) == .tailscaleOff)
    }

    @Test("with Tailscale connected, no answer means the Mac is asleep, off or offline", arguments: [URLError.Code.timedOut, .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet])
    func macUnreachable(code: URLError.Code) {
        #expect(ConnectionIssue(.transport(code), tailscaleConnected: true) == .macUnreachable)
    }

    @Test("a name the tailnet doesn't know, and TLS failures, are told apart")
    func otherTransport() {
        #expect(ConnectionIssue(.transport(.cannotFindHost), tailscaleConnected: true) == .addressNotFound)
        #expect(ConnectionIssue(.transport(.dnsLookupFailed), tailscaleConnected: true) == .addressNotFound)
        #expect(ConnectionIssue(.transport(.secureConnectionFailed), tailscaleConnected: true) == .insecureConnection)
        #expect(ConnectionIssue(.transport(.serverCertificateUntrusted), tailscaleConnected: true) == .insecureConnection)
        #expect(ConnectionIssue(.transport(.appTransportSecurityRequiresSecureConnection), tailscaleConnected: true) == .insecureConnection)
    }

    @Test("answers from the Mac are read for what they mean, whatever Tailscale's state")
    func refusals() {
        for connected in [true, false] {
            #expect(ConnectionIssue(.unauthorized, tailscaleConnected: connected) == .tokenRevoked)
            #expect(ConnectionIssue(.remoteAccessOff, tailscaleConnected: connected) == .remoteAccessOff)
            #expect(ConnectionIssue(.forbidden(code: "forbidden_user", message: "x"), tailscaleConnected: connected) == .wrongTailscaleAccount)
            #expect(ConnectionIssue(.todosNotRunning, tailscaleConnected: connected) == .todosNotRunning)
            #expect(ConnectionIssue(.rateLimited(retryAfter: 30), tailscaleConnected: connected) == .rateLimited(retryAfter: 30))
            #expect(ConnectionIssue(.busy, tailscaleConnected: connected) == .tooManyConnections)
        }
        #expect(ConnectionIssue(.forbidden(code: "forbidden", message: "Todos is not available over Tailscale Funnel."), tailscaleConnected: true) == .other("Todos is not available over Tailscale Funnel."))
        #expect(ConnectionIssue(.server(status: 500, code: "internal", message: nil), tailscaleConnected: true) == .other("Your Mac answered with an error (500)."))
    }

    static let all: [ConnectionIssue] = [.tailscaleOff, .macUnreachable, .addressNotFound, .todosNotRunning, .remoteAccessOff, .wrongTailscaleAccount, .tokenRevoked,
                                         .serverTooOld, .serverTooNew, .rateLimited(retryAfter: 12), .rateLimited(retryAfter: nil), .insecureConnection, .tooManyConnections, .other("Something specific.")]

    @Test("every problem has a name, a one-line explanation and something to do", arguments: all)
    func wording(issue: ConnectionIssue) {
        #expect(!issue.title.isEmpty && !issue.title.hasSuffix("."))
        #expect(!issue.explanation.isEmpty && !issue.explanation.contains("\n"))
        #expect(issue.action.hasSuffix(".") && !issue.action.contains("\n"))
        #expect(issue.explanation.count < 110)
    }

    @Test("the four states the app must explain each say what to do")
    func requiredStates() {
        #expect(ConnectionIssue.tailscaleOff.action == "Open the Tailscale app and connect.")
        #expect(ConnectionIssue.macUnreachable.explanation.contains("asleep"))
        #expect(ConnectionIssue.tokenRevoked.action.contains("Pair this iPhone again"))
        #expect(ConnectionIssue.rateLimited(retryAfter: 11.2).explanation.contains("12 seconds"))
    }

    @Test("only a revoked token needs pairing again, and only some problems are worth retrying quietly")
    func recovery() {
        #expect(Self.all.filter(\.needsPairing) == [.tokenRevoked])
        #expect(Self.all.filter { !$0.mayClearByItself } == [.wrongTailscaleAccount, .tokenRevoked, .serverTooOld, .serverTooNew])
    }

    @Test("only Tailscale's own address range counts as a Tailscale address")
    func tailscaleRange() {
        func ip(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) -> UInt32 { a << 24 | b << 16 | c << 8 | d }
        #expect(Tailscale.isTailscaleIPv4(ip(100, 64, 0, 1)))
        #expect(Tailscale.isTailscaleIPv4(ip(100, 101, 102, 103)))
        #expect(Tailscale.isTailscaleIPv4(ip(100, 127, 255, 254)))
        #expect(!Tailscale.isTailscaleIPv4(ip(100, 63, 255, 255)))
        #expect(!Tailscale.isTailscaleIPv4(ip(100, 128, 0, 1)))
        #expect(!Tailscale.isTailscaleIPv4(ip(192, 168, 1, 10)))
        #expect(!Tailscale.isTailscaleIPv4(ip(10, 64, 0, 1)))
        _ = Tailscale.isConnected() // reads the real interfaces; must not crash whatever they are
    }
}
