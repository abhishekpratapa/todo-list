// Links into the app, used by the widget, and what the share sheet makes of what it is given.

import Foundation

/// todos-app://task/7 opens task 7, todos-app://habit/2 habit 2, and todos-app://habits
/// the Habits tab. Links carry nothing secret.
public enum AppLinks {
    public static let scheme = "todos-app"

    public static let habits = URL(string: "\(scheme)://habits")!

    public static func isHabits(_ url: URL) -> Bool {
        url.scheme == scheme && url.host() == "habits"
    }

    public static func habit(_ id: Int) -> URL {
        URL(string: "\(scheme)://habit/\(id)")!
    }

    public static func habit(from url: URL) -> Int? {
        guard url.scheme == scheme, url.host() == "habit" else { return nil }
        return Int(url.lastPathComponent)
    }

    public static func task(_ id: Int) -> URL {
        URL(string: "\(scheme)://task/\(id)")!
    }

    public static func task(from url: URL) -> Int? {
        guard url.scheme == scheme, url.host() == "task" else { return nil }
        return Int(url.lastPathComponent)
    }
}

public enum SharedContent {
    /// Turns what was shared into a task: a link becomes the notes under the page's title;
    /// text becomes the title, with the rest of it in the notes if it runs long.
    /// - Parameters:
    ///   - url: a shared link, if there was one.
    ///   - text: shared or selected text, if there was any.
    ///   - pageTitle: the title the sharing app gave (a web page's title, usually).
    public static func task(url: URL?, text: String?, pageTitle: String?) -> (title: String, notes: String) {
        let clean = { (s: String?) in s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        let body = clean(text)
        let named = clean(pageTitle)
        let firstLine = body.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let link = url?.absoluteString ?? ""

        var title = named.isEmpty || named == link ? firstLine : named
        if title.isEmpty || title == link { title = url?.host() ?? link }
        if title.count > 200 { title = String(title.prefix(199)) + "…" }

        var notes: [String] = []
        if !link.isEmpty { notes.append(link) }
        // The text goes in the notes when it says more than the title does.
        if !body.isEmpty, body != title, body != link { notes.append(body) }
        return (title, notes.joined(separator: "\n\n"))
    }
}
