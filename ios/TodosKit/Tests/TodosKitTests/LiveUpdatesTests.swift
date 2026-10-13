import Foundation
import Testing
@testable import TodosKit

@Suite("Live-update stream parsing")
struct SSEParserTests {
    private func parse(_ text: String) -> [SSEParser.Message] {
        var parser = SSEParser()
        return parser.feed(Array(text.utf8))
    }

    @Test("reads the Mac's hello and change events")
    func events() {
        let messages = parse("event: hello\ndata: {\"version\":12}\n\nevent: change\ndata: {\"version\":13}\n\n")
        #expect(messages == [.init(event: "hello", data: #"{"version":12}"#), .init(event: "change", data: #"{"version":13}"#)])
        #expect(messages.compactMap(HubEvent.init) == [.hello(version: 12), .change(version: 13)])
        #expect(HubEvent.change(version: 13).version == 13)
    }

    @Test("heartbeat comments produce nothing")
    func heartbeats() {
        #expect(parse(": ping\n\n: ping\n\n").isEmpty)
        #expect(parse(": ping\n\nevent: change\ndata: {\"version\":2}\n\n: ping\n\n").count == 1)
    }

    @Test("an event is only delivered once its blank line arrives, however the bytes are split")
    func chunking() {
        var parser = SSEParser()
        let bytes = Array("event: change\ndata: {\"version\":7}\n\n".utf8)
        for byte in bytes.dropLast() {
            #expect(parser.feed(byte) == nil)
        }
        #expect(parser.feed(bytes.last!) == .init(event: "change", data: #"{"version":7}"#))
    }

    @Test("handles CRLF and bare CR line endings, multi-line data, and fields without a space")
    func variants() {
        #expect(parse("event: change\r\ndata: {\"version\":3}\r\n\r\n") == [.init(event: "change", data: #"{"version":3}"#)])
        #expect(parse("event: change\rdata: {\"version\":3}\r\r") == [.init(event: "change", data: #"{"version":3}"#)])
        #expect(parse("data: one\ndata: two\n\n") == [.init(event: "message", data: "one\ntwo")])
        #expect(parse("event:change\ndata:{\"version\":4}\n\n") == [.init(event: "change", data: #"{"version":4}"#)])
        #expect(parse("data: a: b\n\n") == [.init(event: "message", data: "a: b")], "only the first colon separates the field name")
    }

    @Test("an event name does not leak into the next event, and an event with no data is dropped")
    func resets() {
        #expect(parse("event: hello\n\ndata: x\n\n") == [.init(event: "message", data: "x")])
        #expect(parse("id: 5\nretry: 100\nunknown\n\n").isEmpty)
    }

    @Test("events this app doesn't know, or can't read, are ignored rather than guessed at")
    func unknownEvents() {
        #expect(HubEvent(.init(event: "reminder", data: #"{"version":1}"#)) == nil)
        #expect(HubEvent(.init(event: "change", data: "not json")) == nil)
        #expect(HubEvent(.init(event: "change", data: #"{"version":"x"}"#)) == nil)
        #expect(HubEvent(.init(event: "change", data: #"{"version":9,"extra":true}"#)) == .change(version: 9))
    }
}
