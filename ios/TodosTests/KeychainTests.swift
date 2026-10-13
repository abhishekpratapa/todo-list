// Keychain storage, tested where it really runs: inside the app, in the Simulator
// or on a device. (The Keychain needs an app's entitlements, so these can't run
// under `swift test`.) Every test uses a service name of its own and cleans up, so
// the app's real pairing is never touched.

import Foundation
import Security
import Testing
@testable import TodosKit

@Suite("Keychain storage")
struct KeychainTests {
    let service = "com.abhishekpratapa.todos.tests.\(UUID().uuidString)"
    var store: KeychainCredentialStore { KeychainCredentialStore(service: service) }

    static func credentials(_ host: String = "my-mac.tail1234.ts.net", token: String = "test-token-\(UUID().uuidString)") -> HubCredentials {
        try! HubCredentials(address: HubAddress(host), token: token)
    }

    @Test("nothing is stored until this iPhone is paired")
    func emptyAtFirst() throws {
        #expect(try store.load() == nil)
        try store.clear() // clearing nothing is not an error
    }

    @Test("credentials are saved, read back, replaced and removed")
    func roundTrip() throws {
        defer { try? store.clear() }
        let first = Self.credentials()
        try store.save(first)
        #expect(try store.load() == first)
        #expect(try KeychainCredentialStore(service: service).load() == first, "a fresh store reads the same item, as the app does on its next launch")

        let second = Self.credentials("other-mac.tail1234.ts.net:8443")
        try store.save(second)
        #expect(try store.load() == second, "saving again replaces, it does not add a second item")

        try store.clear()
        #expect(try store.load() == nil)
    }

    @Test("the item can be read after first unlock, stays on this device and is not synced")
    func protection() throws {
        defer { try? store.clear() }
        try store.save(Self.credentials())
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitOne]
        var found: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess)
        let attributes = try #require(found as? [String: Any])
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        #expect((attributes[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue != true)
    }

    @Test("stores with different names don't see each other's items")
    func isolation() throws {
        defer { try? store.clear() }
        try store.save(Self.credentials())
        #expect(try KeychainCredentialStore(service: service + ".other").load() == nil)
        #expect(try KeychainCredentialStore(service: service, account: "other").load() == nil)
    }

    @Test("the share extension's group works, and an item from an earlier build is moved into it once")
    func sharedGroup() throws {
        let own = KeychainCredentialStore(service: service, accessGroup: "N3366NR59J.com.abhishekpratapa.todos.ios")
        let shared = KeychainCredentialStore(service: service, accessGroup: SharedContainer.keychainGroup)
        defer {
            try? own.clear()
            try? shared.clear()
        }
        #expect(KeychainCredentialStore.moveToSharedGroup(from: "N3366NR59J.com.abhishekpratapa.todos.ios", service: service) == false, "nothing to move")

        let credentials = Self.credentials()
        try own.save(credentials) // where builds before the share extension kept it
        #expect(try shared.load() == nil)
        #expect(KeychainCredentialStore.moveToSharedGroup(from: "N3366NR59J.com.abhishekpratapa.todos.ios", service: service))
        #expect(try shared.load() == credentials)
        #expect(try own.load() == nil, "moved, not copied")
        #expect(KeychainCredentialStore.moveToSharedGroup(from: "N3366NR59J.com.abhishekpratapa.todos.ios", service: service) == false, "and only once")
    }

    @Test("an item this app can't make sense of counts as not paired, and pairing replaces it")
    func unreadable() throws {
        defer { try? store.clear() }
        let junk: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "default", kSecValueData: Data("not json".utf8)]
        #expect(SecItemAdd(junk as CFDictionary, nil) == errSecSuccess)
        #expect(try store.load() == nil)
        let fresh = Self.credentials()
        try store.save(fresh)
        #expect(try store.load() == fresh)
    }
}
