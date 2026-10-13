// Whether this app and the Todos app on the Mac understand each other.
//
// The API only ever adds things within a version, and each addition raises the
// revision. So the app needs "version 1, at least revision N" (see src/api-v1.js).

import Foundation

public struct ServerMeta: Codable, Sendable, Equatable {
    public struct API: Codable, Sendable, Equatable {
        public var version: Int
        public var revision: Int
    }

    public struct App: Codable, Sendable, Equatable {
        public var name: String?
        public var version: String?
    }

    public var api: API
    public var app: App?

    public init(version: Int, revision: Int, appVersion: String? = nil) {
        api = API(version: version, revision: revision)
        app = appVersion.map { App(name: "Todos", version: $0) }
    }
}

public enum Compatibility: Sendable, Equatable {
    case compatible
    /// The Mac's Todos is missing something this app needs. Update Todos on the Mac.
    case serverTooOld(revision: Int)
    /// The Mac's Todos speaks a later version of the API. Update this app.
    case serverTooNew(version: Int)

    /// The API version this app speaks.
    public static let apiVersion = 1
    /// The earliest revision with everything this app relies on (Todos 1.6: changes that are
    /// safe to send twice, and captured lines that say when they were typed).
    public static let requiredRevision = 3
    /// The Todos release that first had `requiredRevision`, for telling the user what to update to.
    public static let requiredAppVersion = "1.6"

    public init(_ meta: ServerMeta) {
        if meta.api.version > Self.apiVersion {
            self = .serverTooNew(version: meta.api.version)
        } else if meta.api.version < Self.apiVersion || meta.api.revision < Self.requiredRevision {
            self = .serverTooOld(revision: meta.api.revision)
        } else {
            self = .compatible
        }
    }
}

extension HubClient {
    /// Asks the Mac what it speaks and compares. A Mac running Todos 1.4 has no /meta
    /// and answers 404, which means revision 1.
    public func checkCompatibility() async throws -> (meta: ServerMeta?, result: Compatibility) {
        do {
            let meta = try await meta()
            return (meta, Compatibility(meta))
        } catch HubError.notFound {
            return (nil, .serverTooOld(revision: 1))
        } catch HubError.badResponse {
            return (nil, .serverTooNew(version: Self.unknownVersion))
        }
    }

    /// Stands for "a version this app can't even read".
    static let unknownVersion = Int.max
}
