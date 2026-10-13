// Where the app, its widget and its extensions keep what they share: the list as
// the Mac last sent it and the changes waiting to be sent. On the iPhone that is
// the app group's container.

import Foundation

public enum SharedContainer {
    public static let appGroup = "group.com.abhishekpratapa.todos"
    /// The Keychain group the app shares with its share extension, so the extension can send what it adds.
    public static let keychainGroup = "N3366NR59J.com.abhishekpratapa.todos.shared"

    /// The folder everything is kept under. Outside a signed app there is no group
    /// container (unit tests, for one), so the process's own folder is used.
    public static var directory: URL {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Todos", isDirectory: true)
    }

    /// Each Mac has a folder of its own, named after its address. Pairing again with the
    /// same Mac finds its list and waiting changes still there; a different Mac never sees them.
    public static func hubDirectory(for address: HubAddress, in directory: URL = SharedContainer.directory) -> URL {
        hubs(in: directory).appendingPathComponent(folderName(for: address), isDirectory: true)
    }

    static func folderName(for address: HubAddress) -> String {
        String(address.description.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" })
    }

    private static func hubs(in directory: URL) -> URL {
        directory.appendingPathComponent("Hubs", isDirectory: true)
    }

    private static func pointer(in directory: URL) -> URL {
        directory.appendingPathComponent("current-hub.txt")
    }

    /// Records which Mac the app is paired with, for the widget and extensions, which have
    /// no other way to know. Nil when unpaired. Only the folder's name is written: never the token.
    public static func setCurrentHub(_ address: HubAddress?, in directory: URL = SharedContainer.directory) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let address {
            try? Data(folderName(for: address).utf8).write(to: pointer(in: directory), options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: pointer(in: directory))
        }
    }

    /// The paired Mac's folder, if the app is paired.
    public static func currentHubDirectory(in directory: URL = SharedContainer.directory) -> URL? {
        guard let name = try? String(contentsOf: pointer(in: directory), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty, name != ".", name != "..",
              name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" }) else { return nil }
        return hubs(in: directory).appendingPathComponent(name, isDirectory: true)
    }
}

extension LocalStore {
    /// Reads the list and waiting changes without opening a store: for the widget, which only looks.
    public static func read(directory: URL) -> (list: CachedList, changes: [PendingChange]) {
        var list = CachedList()
        if let data = try? Data(contentsOf: directory.appendingPathComponent("list.json")),
           let file = try? HubJSON.decoder().decode(CacheFile.self, from: data), file.schema == schema {
            list = file.list
        }
        let outbox = directory.appendingPathComponent("outbox", isDirectory: true)
        let files = ((try? FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        let changes = files.compactMap { file in
            (try? Data(contentsOf: file)).flatMap { try? HubJSON.decoder().decode(PendingChange.self, from: $0) }
        }
        return (list, changes)
    }
}
