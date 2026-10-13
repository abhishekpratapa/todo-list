// Where the address and access token are kept. On the iPhone that is the Keychain,
// and nowhere else: not UserDefaults, not a file.

import Foundation
import Security

public protocol CredentialStore: Sendable {
    /// The saved credentials, or nil if this iPhone is not paired.
    func load() throws -> HubCredentials?
    func save(_ credentials: HubCredentials) throws
    func clear() throws
}

public struct KeychainError: Error, Sendable, Equatable, CustomStringConvertible {
    public let status: OSStatus

    public var description: String {
        let text = SecCopyErrorMessageString(status, nil) as String?
        return "Keychain error \(status)" + (text.map { ": \($0)" } ?? "")
    }
}

/// One generic-password item holding the address and token together.
///
/// It can be read once the iPhone has been unlocked after a restart (so a widget
/// or background refresh can use it), and it stays on this device: it is not
/// synced to iCloud Keychain and is not restored onto another device.
public struct KeychainCredentialStore: CredentialStore {
    public static let defaultService = "com.abhishekpratapa.todos.hub"

    let service: String
    let account: String
    let accessGroup: String?

    public init(service: String = KeychainCredentialStore.defaultService, account: String = "default", accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private var query: [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: false,
        ]
        if let accessGroup { q[kSecAttrAccessGroup] = accessGroup }
        return q
    }

    public func load() throws -> HubCredentials? {
        var q = query
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data else { throw KeychainError(status: status) }
        // Something unreadable is treated as "not paired", so pairing again can replace it.
        return try? JSONDecoder().decode(HubCredentials.self, from: data)
    }

    public func save(_ credentials: HubCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let attributes: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// Holds credentials in memory only. For tests and previews.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: HubCredentials?

    public init(_ credentials: HubCredentials? = nil) {
        stored = credentials
    }

    public func load() -> HubCredentials? {
        lock.withLock { stored }
    }

    public func save(_ credentials: HubCredentials) {
        lock.withLock { stored = credentials }
    }

    public func clear() {
        lock.withLock { stored = nil }
    }
}
