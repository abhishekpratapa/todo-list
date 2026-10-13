// Draws notes and comments from the Markdown tree TodosKit produces. Links are
// tappable; the parser only ever makes links to http, https and mailto addresses.

import SwiftUI
import TodosKit

struct MarkdownView: View {
    var blocks: [MarkdownBlock]

    init(_ source: String) {
        blocks = Markdown.blocks(source)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let spans):
            Text(spans.attributed)
                .font(level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let lines):
            Text(lines.attributed)
        case .codeBlock(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.callout.monospaced())
                    .padding(10)
            }
            .background(Color(uiColor: .secondarySystemFill), in: RoundedRectangle(cornerRadius: 8))
        case .rule:
            Divider()
        case .quote(let lines):
            Text(lines.attributed)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
                }
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(ordered: ordered, index: index, checked: item.checked)
                        Text(item.spans.attributed)
                            .strikethrough(item.checked == true)
                            .foregroundStyle(item.checked == true ? .secondary : .primary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(ordered: Bool, index: Int, checked: Bool?) -> some View {
        if let checked {
            Image(systemName: checked ? "checkmark.square" : "square")
                .foregroundStyle(.secondary)
                .accessibilityLabel(checked ? "Done" : "Not done")
        } else if ordered {
            Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
        } else {
            Text("•").foregroundStyle(.secondary)
        }
    }
}

/// One line of Markdown, as used for comments.
struct InlineMarkdown: View {
    var text: String

    var body: some View {
        Text(text.split(separator: "\n", omittingEmptySubsequences: false).map { Markdown.inline(String($0)) }.attributed)
    }
}

extension [MarkdownSpan] {
    var attributed: AttributedString {
        var out = AttributedString()
        for span in self {
            var piece = AttributedString(span.text)
            var intent: InlinePresentationIntent = []
            if span.bold { intent.insert(.stronglyEmphasized) }
            if span.italic { intent.insert(.emphasized) }
            if span.strikethrough { intent.insert(.strikethrough) }
            if span.code { intent.insert(.code) }
            if !intent.isEmpty { piece.inlinePresentationIntent = intent }
            if let link = span.link {
                piece.link = link
                piece.underlineStyle = .single
            }
            out.append(piece)
        }
        return out
    }
}

extension [[MarkdownSpan]] {
    /// Lines joined with line breaks.
    var attributed: AttributedString {
        var out = AttributedString()
        for (index, line) in enumerated() {
            if index > 0 { out.append(AttributedString("\n")) }
            out.append(line.attributed)
        }
        return out
    }
}
