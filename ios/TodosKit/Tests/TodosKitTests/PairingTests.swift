import Foundation
import Testing
@testable import TodosKit

@Suite("Hub address")
struct HubAddressTests {
    @Test("accepts what someone might paste, and keeps only scheme, host and port", arguments: [
        ("my-mac.tail1234.ts.net", "https://my-mac.tail1234.ts.net"),
        ("  https://My-Mac.Tail1234.ts.net/  ", "https://my-mac.tail1234.ts.net"),
        ("https://my-mac.tail1234.ts.net/api/v1/tasks?x=1#frag", "https://my-mac.tail1234.ts.net"),
        ("my-mac.tail1234.ts.net:8443", "https://my-mac.tail1234.ts.net:8443"),
        ("https://my-mac.tail1234.ts.net:443", "https://my-mac.tail1234.ts.net"),
        ("HTTPS://my-mac.tail1234.ts.net:10000/login", "https://my-mac.tail1234.ts.net:10000"),
    ])
    func accepts(input: String, expected: String) throws {
        #expect(try HubAddress(input).url.absoluteString == expected)
    }

    @Test("plain HTTP is refused: there is no unencrypted mode")
    func refusesHTTP() {
        #expect(throws: HubAddress.Invalid.notHTTPS) { try HubAddress("http://my-mac.tail1234.ts.net") }
        #expect(throws: HubAddress.Invalid.notHTTPS) { try HubAddress("HTTP://my-mac.tail1234.ts.net:7420") }
        #expect(throws: HubAddress.Invalid.notHTTPS) { try HubAddress("http://127.0.0.1:7420") }
    }

    @Test("nonsense is refused", arguments: ["", "   ", "ftp://my-mac.ts.net", "https://", "https://user:pw@my-mac.ts.net", "https://my mac.ts.net", "todos-pair:?v=1", "https://exa$mple.com", "my-mac.ts.net:99999"])
    func refusesNonsense(input: String) {
        #expect(throws: HubAddress.Invalid.self) { try HubAddress(input) }
    }

    @Test("shows as the host, with the port only when it is unusual")
    func display() throws {
        #expect(try HubAddress("https://my-mac.tail1234.ts.net").description == "my-mac.tail1234.ts.net")
        #expect(try HubAddress("my-mac.tail1234.ts.net:8443").description == "my-mac.tail1234.ts.net:8443")
        #expect(try HubAddress("my-mac.tail1234.ts.net").host == "my-mac.tail1234.ts.net")
    }

    @Test("survives being saved and loaded, and a saved http address is not accepted back")
    func coding() throws {
        let address = try HubAddress("my-mac.tail1234.ts.net:8443")
        let data = try JSONEncoder().encode([address])
        #expect(try JSONDecoder().decode([HubAddress].self, from: data) == [address])
        #expect(throws: HubAddress.Invalid.notHTTPS) { try JSONDecoder().decode([HubAddress].self, from: Data(#"["http://my-mac.ts.net"]"#.utf8)) }
    }
}

@Suite("Credentials and pairing codes")
struct PairingTests {
    @Test("a token is trimmed, and must be one unbroken run of characters")
    func tokens() throws {
        let address = try HubAddress("my-mac.tail1234.ts.net")
        #expect(try HubCredentials(address: address, token: "  abc-DEF_123\n").token == "abc-DEF_123")
        #expect(throws: HubCredentials.Invalid.emptyToken) { try HubCredentials(address: address, token: " \n ") }
        #expect(throws: HubCredentials.Invalid.malformedToken) { try HubCredentials(address: address, token: "two words") }
        #expect(throws: HubCredentials.Invalid.malformedToken) { try HubCredentials(address: address, token: "tökén") }
    }

    @Test("reads the code the Mac's Pair iPhone window shows")
    func scans() throws {
        // Exactly what src/pairing.js builds: pairingLink('https://my-mac.tail1234.ts.net:8443', token)
        let code = try PairingCode(scanned: "todos-pair:?v=1&u=https%3A%2F%2Fmy-mac.tail1234.ts.net%3A8443&t=aB3_-xYzaB3_-xYzaB3_-xYzaB3_-xYzaB3_-xYzabc")
        #expect(code.credentials.address.url.absoluteString == "https://my-mac.tail1234.ts.net:8443")
        #expect(code.credentials.token == "aB3_-xYzaB3_-xYzaB3_-xYzaB3_-xYzaB3_-xYzabc")
        #expect(try PairingCode(scanned: "  TODOS-PAIR:?v=1&u=https%3A%2F%2Fa.ts.net&t=tok \n").credentials.token == "tok")
    }

    @Test("other QR codes are not pairing codes", arguments: [
        "https://example.com", "WIFI:S:home;T:WPA;P:secret;;", "", "todos-pair:", "todos-pair:?u=https%3A%2F%2Fa.ts.net&t=tok",
        "todos-pair:?v=1&u=https%3A%2F%2Fa.ts.net", "todos-pair:?v=1&t=tok", "todos-pair:?v=1&u=http%3A%2F%2Fa.ts.net&t=tok", "todos-pair:?v=1&u=https%3A%2F%2Fa.ts.net&t=",
    ])
    func rejects(text: String) {
        #expect(throws: PairingCode.Invalid.notAPairingCode) { try PairingCode(scanned: text) }
    }

    @Test("a code from a newer Todos says so instead of being misread")
    func newerFormat() {
        #expect(throws: PairingCode.Invalid.newerFormat) { try PairingCode(scanned: "todos-pair:?v=2&x=something-new") }
    }

    @Test("the in-memory store used by tests and previews holds, replaces and forgets")
    func memoryStore() throws {
        let store = InMemoryCredentialStore()
        #expect(store.load() == nil)
        store.save(Sample.credentials())
        #expect(store.load() == Sample.credentials())
        store.save(Sample.credentials("other-mac.tail1234.ts.net"))
        #expect(store.load()?.address.host == "other-mac.tail1234.ts.net")
        store.clear()
        #expect(store.load() == nil)
    }

    @Test("credentials are stored as one small JSON value")
    func credentialCoding() throws {
        let data = try JSONEncoder().encode(Sample.credentials())
        #expect(try JSONDecoder().decode(HubCredentials.self, from: data) == Sample.credentials())
    }
}
