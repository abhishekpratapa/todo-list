// Markdown for notes and comments, with the same rules as the Mac's renderer
// (public/markdown.js): headings, bold, italic, strikethrough, code, links, lists,
// task lists, quotes and rules. Links only ever go to http, https or mailto addresses.
//
// This turns text into a small tree; the app draws it.

import Foundation

public struct MarkdownSpan: Sendable, Equatable {
    public var text: String
    public var bold = false
    public var italic = false
    public var strikethrough = false
    public var code = false
    public var link: URL?

    public init(_ text: String, bold: Bool = false, italic: Bool = false, strikethrough: Bool = false, code: Bool = false, link: URL? = nil) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.strikethrough = strikethrough
        self.code = code
        self.link = link
    }
}

public struct MarkdownListItem: Sendable, Equatable {
    /// nil for a plain item; true or false for a task-list item ("- [x] done").
    public var checked: Bool?
    public var spans: [MarkdownSpan]
}

public enum MarkdownBlock: Sendable, Equatable {
    case heading(level: Int, spans: [MarkdownSpan])
    case paragraph(lines: [[MarkdownSpan]])
    case codeBlock(String)
    case rule
    case quote(lines: [[MarkdownSpan]])
    case list(ordered: Bool, items: [MarkdownListItem])
}

public enum Markdown {
    // MARK: Blocks

    public static func blocks(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(lines: paragraph.map(inline))) }
            paragraph = []
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i])
                    i += 1
                }
                out.append(.codeBlock(code.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
            } else if let (level, text) = heading(line) {
                flush()
                out.append(.heading(level: level, spans: inline(text)))
            } else if isRule(trimmed) {
                flush()
                out.append(.rule)
            } else if trimmed.hasPrefix(">") {
                flush()
                var quote: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var text = lines[i].trimmingCharacters(in: .whitespaces).dropFirst()
                    if text.first == " " { text = text.dropFirst() }
                    quote.append(String(text))
                    i += 1
                }
                i -= 1
                out.append(.quote(lines: quote.map(inline)))
            } else if let first = listItem(trimmed) {
                flush()
                var items: [MarkdownListItem] = []
                while i < lines.count, let item = listItem(lines[i].trimmingCharacters(in: .whitespaces)), item.ordered == first.ordered {
                    items.append(item.item)
                    i += 1
                }
                i -= 1
                out.append(.list(ordered: first.ordered, items: items))
            } else {
                paragraph.append(line)
            }
            i += 1
        }
        flush()
        return out
    }

    /// "# Title" to "### Title": one to three hashes, then a space.
    private static func heading(_ line: String) -> (Int, String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...3).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard let first = rest.first, first == " " || first == "\t" else { return nil }
        return (hashes, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ trimmed: String) -> Bool {
        trimmed.count >= 3 && (trimmed.allSatisfy { $0 == "-" } || trimmed.allSatisfy { $0 == "*" })
    }

    /// "- item", "* item", "+ item", "1. item", "2) item", and "- [ ] task" / "- [x] task".
    private static func listItem(_ trimmed: String) -> (ordered: Bool, item: MarkdownListItem)? {
        var rest: Substring
        let ordered: Bool
        if let marker = trimmed.first, "-*+".contains(marker) {
            rest = trimmed.dropFirst()
            ordered = false
        } else {
            let digits = trimmed.prefix { $0.isASCII && $0.isNumber }
            let after = trimmed.dropFirst(digits.count)
            guard !digits.isEmpty, let mark = after.first, mark == "." || mark == ")" else { return nil }
            rest = after.dropFirst()
            ordered = true
        }
        guard let space = rest.first, space == " " || space == "\t" else { return nil }
        rest = rest.drop { $0 == " " || $0 == "\t" }

        var checked: Bool?
        if rest.count >= 4, rest.hasPrefix("["), rest.dropFirst(2).hasPrefix("]") {
            let mark = rest[rest.index(after: rest.startIndex)]
            let after = rest.dropFirst(3)
            if " xX".contains(mark), let space = after.first, space == " " || space == "\t" {
                checked = mark != " "
                rest = after.drop { $0 == " " || $0 == "\t" }
            }
        }
        return (ordered, MarkdownListItem(checked: checked, spans: inline(String(rest))))
    }

    // MARK: Inline

    private enum Style { case bold, italic, strikethrough }

    private struct Emphasis: Sendable {
        let regex: NSRegularExpression
        /// The capture group holding a character before the marker that must be kept, if any.
        let kept: Int?
        let inner: Int
        let style: Style
    }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern) // the patterns are constants, checked by the tests
    }

    private static let codeSpan = regex("`([^`\\n]+)`")
    private static let namedLink = regex("\\[([^\\]\\n]+)\\]\\(((?:https?://|mailto:)[^\\s)]+)\\)")
    private static let angleLink = regex("<(https?://[^\\s<>]+)>")
    private static let bareLink = regex("(^|[\\s(])(https?://[^\\s<>\"']+)")
    private static let emphases = [
        Emphasis(regex: regex("\\*\\*([^*\\n]+)\\*\\*"), kept: nil, inner: 1, style: .bold),
        Emphasis(regex: regex("(^|[^\\w*])\\*([^*\\s][^*\\n]*)\\*(?!\\w)"), kept: 1, inner: 2, style: .italic),
        Emphasis(regex: regex("(^|[^\\w_])_([^_\\s][^_\\n]*)_(?!\\w)"), kept: 1, inner: 2, style: .italic),
        Emphasis(regex: regex("~~([^~\\n]+)~~"), kept: nil, inner: 1, style: .strikethrough),
    ]

    // Finished pieces are swapped for a placeholder while later rules run, the way the
    // Mac's renderer swaps in HTML tags. That lets "~~**both**~~" and "**see `this`**"
    // come out right: a later rule can match around an earlier one's result.
    private static let open: Character = "\u{E000}"
    private static let close: Character = "\u{E001}"

    private enum Kept {
        /// Code or a link: done, apart from any emphasis around it.
        case span(MarkdownSpan)
        /// The inside of an emphasis marker, still to be read by the rules after `rule`.
        case group(text: String, style: Style, rule: Int)
    }

    private static func placeholder(_ index: Int) -> String {
        "\(open)\(index)\(close)"
    }

    /// Replaces every match, handing the closure the match's capture groups.
    private static func replacing(_ regex: NSRegularExpression, in text: String, with body: ([String]) -> String) -> String {
        let whole = text as NSString
        var out = ""
        var at = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: whole.length)) {
            out += whole.substring(with: NSRange(location: at, length: match.range.location - at))
            out += body((0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : whole.substring(with: match.range(at: $0)) })
            at = match.range.location + match.range.length
        }
        return out + whole.substring(from: at)
    }

    public static func inline(_ source: String) -> [MarkdownSpan] {
        var kept: [Kept] = []
        func keep(_ span: MarkdownSpan) -> String {
            kept.append(.span(span))
            return placeholder(kept.count - 1)
        }

        var text = source.filter { $0 != open && $0 != close }
        text = replacing(codeSpan, in: text) { keep(MarkdownSpan($0[1], code: true)) }
        text = replacing(namedLink, in: text) { groups in
            guard let url = URL(string: groups[2]) else { return groups[0] }
            return keep(MarkdownSpan(groups[1], link: url))
        }
        text = replacing(angleLink, in: text) { groups in
            guard let url = URL(string: groups[1]) else { return groups[0] }
            return keep(MarkdownSpan(groups[1], link: url))
        }
        text = replacing(bareLink, in: text) { groups in
            // Trailing punctuation belongs to the sentence, not the link.
            var address = groups[2]
            var tail = ""
            while let last = address.last, ".,;:!?".contains(last) || (last == ")" && !address.contains("(")) {
                tail = String(last) + tail
                address.removeLast()
            }
            guard let url = URL(string: address) else { return groups[0] }
            return groups[1] + keep(MarkdownSpan(address, link: url)) + tail
        }
        return merge(expand(emphasize(text, from: 0, &kept), [], &kept))
    }

    /// Applies the emphasis rules from `rule` on, leaving a placeholder for each match.
    private static func emphasize(_ text: String, from rule: Int, _ kept: inout [Kept]) -> String {
        var text = text
        for index in emphases.indices.dropFirst(rule) {
            let emphasis = emphases[index]
            text = replacing(emphasis.regex, in: text) { groups in
                kept.append(.group(text: groups[emphasis.inner], style: emphasis.style, rule: index))
                return (emphasis.kept.map { groups[$0] } ?? "") + placeholder(kept.count - 1)
            }
        }
        return text
    }

    /// Turns text with placeholders back into spans, styling everything inside a group.
    private static func expand(_ text: String, _ styles: Set<Style>, _ kept: inout [Kept]) -> [MarkdownSpan] {
        func styled(_ span: MarkdownSpan) -> MarkdownSpan {
            var s = span
            s.bold = s.bold || styles.contains(.bold)
            s.italic = s.italic || styles.contains(.italic)
            s.strikethrough = s.strikethrough || styles.contains(.strikethrough)
            return s
        }
        var out: [MarkdownSpan] = []
        var plain = ""
        var rest = text[...]
        while let start = rest.firstIndex(of: open) {
            plain += rest[..<start]
            let after = rest[rest.index(after: start)...]
            guard let end = after.firstIndex(of: close), let index = Int(after[..<end]), kept.indices.contains(index) else {
                rest = after
                continue
            }
            if !plain.isEmpty { out.append(styled(MarkdownSpan(plain))) }
            plain = ""
            switch kept[index] {
            case .span(let span):
                out.append(styled(span))
            case .group(let inner, let style, let rule):
                out += expand(emphasize(inner, from: rule + 1, &kept), styles.union([style]), &kept)
            }
            rest = after[after.index(after: end)...]
        }
        plain += rest
        if !plain.isEmpty { out.append(styled(MarkdownSpan(plain))) }
        return out
    }

    /// Joins neighbouring spans that look the same.
    private static func merge(_ spans: [MarkdownSpan]) -> [MarkdownSpan] {
        var out: [MarkdownSpan] = []
        for span in spans {
            if var last = out.last, last.link == nil, span.link == nil, !last.code, !span.code,
               last.bold == span.bold, last.italic == span.italic, last.strikethrough == span.strikethrough {
                last.text += span.text
                out[out.count - 1] = last
            } else {
                out.append(span)
            }
        }
        return out
    }

    /// The text with all the markup taken out, for one-line previews and VoiceOver.
    public static func plainText(_ source: String) -> String {
        func text(_ spans: [MarkdownSpan]) -> String { spans.map(\.text).joined() }
        return blocks(source).map { block in
            switch block {
            case .heading(_, let spans): text(spans)
            case .paragraph(let lines), .quote(let lines): lines.map(text).joined(separator: " ")
            case .codeBlock(let code): code
            case .rule: ""
            case .list(_, let items): items.map { text($0.spans) }.joined(separator: ", ")
            }
        }.filter { !$0.isEmpty }.joined(separator: " ")
    }
}
