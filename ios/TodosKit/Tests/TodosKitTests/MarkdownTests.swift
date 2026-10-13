import Foundation
import Testing
@testable import TodosKit

@Suite("Markdown notes")
struct MarkdownTests {
    private func spans(_ text: String) -> [MarkdownSpan] { Markdown.inline(text) }
    private let url = URL(string: "https://example.com/a")!

    @Test("plain text is one span")
    func plain() {
        #expect(spans("Just words.") == [MarkdownSpan("Just words.")])
        #expect(spans("").isEmpty)
    }

    @Test("bold, italic, strikethrough and code")
    func emphasis() {
        #expect(spans("a **b** c") == [MarkdownSpan("a "), MarkdownSpan("b", bold: true), MarkdownSpan(" c")])
        #expect(spans("an *italic* and _another_") == [MarkdownSpan("an "), MarkdownSpan("italic", italic: true), MarkdownSpan(" and "), MarkdownSpan("another", italic: true)])
        #expect(spans("~~gone~~") == [MarkdownSpan("gone", strikethrough: true)])
        #expect(spans("run `npm test` now") == [MarkdownSpan("run "), MarkdownSpan("npm test", code: true), MarkdownSpan(" now")])
        #expect(spans("**bold with `code`**") == [MarkdownSpan("bold with ", bold: true), MarkdownSpan("code", bold: true, code: true)])
        #expect(spans("~~**both**~~") == [MarkdownSpan("both", bold: true, strikethrough: true)])
    }

    @Test("markers inside words and maths are left alone")
    func notEmphasis() {
        #expect(spans("snake_case_name and 2*3*4") == [MarkdownSpan("snake_case_name and 2*3*4")])
        #expect(spans("`**not bold**`") == [MarkdownSpan("**not bold**", code: true)])
        #expect(spans("a * b * c") == [MarkdownSpan("a * b * c")])
    }

    @Test("links: named, in angle brackets, and bare")
    func links() {
        #expect(spans("see [the page](https://example.com/a) now") == [MarkdownSpan("see "), MarkdownSpan("the page", link: url), MarkdownSpan(" now")])
        #expect(spans("<https://example.com/a>") == [MarkdownSpan("https://example.com/a", link: url)])
        #expect(spans("go to https://example.com/a.") == [MarkdownSpan("go to "), MarkdownSpan("https://example.com/a", link: url), MarkdownSpan(".")], "the full stop is the sentence's")
        #expect(spans("(https://example.com/a)") == [MarkdownSpan("("), MarkdownSpan("https://example.com/a", link: url), MarkdownSpan(")")])
        #expect(spans("https://en.wikipedia.org/wiki/A_(b)").first?.link?.absoluteString == "https://en.wikipedia.org/wiki/A_(b)")
        #expect(spans("[mail me](mailto:me@example.com)").first?.link?.scheme == "mailto")
        #expect(spans("**[bold link](https://example.com/a)**") == [MarkdownSpan("bold link", bold: true, link: url)])
    }

    @Test("only http, https and mailto ever become links", arguments: [
        "[x](javascript:alert(1))", "[x](file:///etc/passwd)", "[x](tel:123)", "<javascript:alert(1)>", "ftp://example.com/file", "[x](data:text/html,hi)", "[x](todos-pair:?t=secret)",
    ])
    func unsafeLinks(text: String) {
        #expect(spans(text).allSatisfy { $0.link == nil })
    }

    @Test("blocks: headings, paragraphs, rules, quotes and code")
    func blocks() {
        let source = """
        # Title
        ### Small
        #### Not a heading
        #hashtag

        First line
        second line

        ---
        > quoted **text**
        > more

        ```
        let x = **raw**
        ```
        """
        #expect(Markdown.blocks(source) == [
            .heading(level: 1, spans: [MarkdownSpan("Title")]),
            .heading(level: 3, spans: [MarkdownSpan("Small")]),
            .paragraph(lines: [[MarkdownSpan("#### Not a heading")], [MarkdownSpan("#hashtag")]]),
            .paragraph(lines: [[MarkdownSpan("First line")], [MarkdownSpan("second line")]]),
            .rule,
            .quote(lines: [[MarkdownSpan("quoted "), MarkdownSpan("text", bold: true)], [MarkdownSpan("more")]]),
            .codeBlock("let x = **raw**"),
        ])
    }

    @Test("lists: bulleted, numbered and task lists")
    func lists() {
        let source = """
        - one
        * two
        + [link](https://example.com/a)
        1. first
        2) second
        - [ ] to do
        - [x] done
        - [X] also done
        - [y] not a task
        """
        #expect(Markdown.blocks(source) == [
            .list(ordered: false, items: [
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("one")]),
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("two")]),
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("link", link: url)]),
            ]),
            .list(ordered: true, items: [
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("first")]),
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("second")]),
            ]),
            .list(ordered: false, items: [
                MarkdownListItem(checked: false, spans: [MarkdownSpan("to do")]),
                MarkdownListItem(checked: true, spans: [MarkdownSpan("done")]),
                MarkdownListItem(checked: true, spans: [MarkdownSpan("also done")]),
                MarkdownListItem(checked: nil, spans: [MarkdownSpan("[y] not a task")]),
            ]),
        ])
        #expect(Markdown.blocks("-not a list\n1.nor this") == [.paragraph(lines: [[MarkdownSpan("-not a list")], [MarkdownSpan("1.nor this")]])])
    }

    @Test("Windows line endings, an unclosed code block and empty notes don't trip it up")
    func edges() {
        #expect(Markdown.blocks("a\r\nb\r\n\r\nc") == [.paragraph(lines: [[MarkdownSpan("a")], [MarkdownSpan("b")]]), .paragraph(lines: [[MarkdownSpan("c")]])])
        #expect(Markdown.blocks("```\nnever closed") == [.codeBlock("never closed")])
        #expect(Markdown.blocks("").isEmpty)
        #expect(Markdown.blocks("\n\n  \n").isEmpty)
        #expect(Markdown.inline("odd \u{E000}0\u{E001} characters") == [MarkdownSpan("odd 0 characters")], "the parser's own placeholders can't be smuggled in")
    }

    @Test("plain text drops the markup, for previews and VoiceOver")
    func plainText() {
        #expect(Markdown.plainText("# Plan\n\nBring **photos** and the [form](https://example.com/a).\n\n- [x] one\n- two") == "Plan Bring photos and the form. one, two")
        #expect(Markdown.plainText("") == "")
    }
}
