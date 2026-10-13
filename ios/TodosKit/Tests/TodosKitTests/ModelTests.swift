import Foundation
import Testing
@testable import TodosKit

@Suite("Task model")
struct ModelTests {
    @Test("a task decodes exactly as the Mac sends it")
    func decodesTask() throws {
        let task = Sample.task
        #expect(task.id == 7)
        #expect(task.rev == 4)
        #expect(task.status == .inProgress)
        #expect(task.priority == .high)
        #expect(task.due == Day(year: 2026, month: 10, day: 16))
        #expect(task.project == "personal")
        #expect(task.tags == ["errand", "travel"])
        #expect(task.assignee == .claude)
        #expect(task.subtasks == [Subtask(id: 1, title: "Fill in form", done: true), Subtask(id: 2, title: "Book slot", done: false)])
        #expect(task.repeats == .yearly)
        #expect(task.remindAt == Date(timeIntervalSince1970: 1_792_072_800))
        #expect(task.remindedAt == nil)
        #expect(task.completedAt == nil)
        #expect(task.activity?.count == 2)
        #expect(task.commentCount == 1)
        #expect(task.subtasksDone == 1)
    }

    @Test("timestamps keep their milliseconds, and ones without them are read too")
    func timestamps() throws {
        #expect(abs(Sample.task.createdAt.timeIntervalSince1970 - 1_791_212_292.345) < 0.0005)
        #expect(HubJSON.parseDate("2026-10-05T14:58:12Z") == Date(timeIntervalSince1970: 1_791_212_292))
        #expect(HubJSON.parseDate("yesterday") == nil)
        #expect(HubJSON.string(from: Date(timeIntervalSince1970: 1_791_212_292.345)) == "2026-10-05T14:58:12.345Z")
    }

    @Test("a task in a list has a comment count instead of its history")
    func decodesListTask() throws {
        let json = #"{"id":1,"title":"T","notes":"","status":"todo","priority":"medium","due":null,"project":null,"tags":[],"assignee":"me","subtasks":[],"repeat":null,"remindAt":null,"remindedAt":null,"rev":1,"createdBy":"Claude Code · repo","createdAt":"2026-10-05T14:58:12.345Z","updatedAt":"2026-10-05T14:58:12.345Z","completedAt":null,"comments":3}"#
        let task = try HubJSON.decoder().decode(TodoTask.self, from: Data(json.utf8))
        #expect(task.activity == nil)
        #expect(task.commentCount == 3)
        #expect(task.due == nil && task.repeats == nil && task.project == nil)
    }

    @Test("activity says who did it and from where")
    func activityAuthor() {
        let activity = Sample.task.activity!
        #expect(activity[0].author == "You · iPhone")
        #expect(activity[1].author == "Claude Code · passport")
        #expect(activity[1].kind == .comment)
    }

    @Test("overdue and due today only apply to open tasks")
    func dueness() {
        let today = Day("2026-10-12")!
        #expect(Sample.task(1, due: "2026-10-11").isOverdue(on: today))
        #expect(!Sample.task(1, due: "2026-10-12").isOverdue(on: today))
        #expect(Sample.task(1, due: "2026-10-12").isDueToday(today))
        #expect(!Sample.task(1, status: .done, due: "2026-10-11").isOverdue(on: today))
        #expect(!Sample.task(1, status: .done, due: "2026-10-12").isDueToday(today))
        #expect(!Sample.task(1).isOverdue(on: today))
    }

    @Test("the dashboard's counts and a capture preview decode")
    func countsAndPreview() throws {
        let counts = try HubJSON.decoder().decode(Counts.self, from: Data(#"{"open":5,"in_progress":1,"blocked":2,"overdue":3,"due_today":4,"claude":1,"done_7d":9}"#.utf8))
        #expect(counts == Counts(open: 5, inProgress: 1, blocked: 2, overdue: 3, dueToday: 4, claude: 1, doneThisWeek: 9))

        let parsed = try HubJSON.decoder().decode(ParsedCapture.self, from: Data(#"{"title":"Call dentist","fields":{"due":"2026-10-13","remindAt":"2026-10-13T20:00:00.000Z","repeat":"weekly","tags":["health"],"assignee":"claude","priority":"low","project":"home"}}"#.utf8))
        #expect(parsed.title == "Call dentist")
        #expect(parsed.fields.due == Day("2026-10-13"))
        #expect(parsed.fields.repeats == .weekly)
        #expect(parsed.fields.tags == ["health"])
        #expect(parsed.fields.assignee == .claude)
        #expect(parsed.fields.priority == .low)
        #expect(parsed.fields.project == "home")
        #expect(parsed.fields.remindAt != nil)

        let bare = try HubJSON.decoder().decode(ParsedCapture.self, from: Data(#"{"title":"Just a title","fields":{}}"#.utf8))
        #expect(bare.fields == ParsedCapture.Fields())
    }
}

@Suite("Calendar days")
struct DayTests {
    @Test("only YYYY-MM-DD is a day")
    func parsing() {
        #expect(Day("2026-10-20")?.description == "2026-10-20")
        #expect(Day("2026-1-5") == nil)
        #expect(Day("2026-13-01") == nil)
        #expect(Day("tomorrow") == nil)
        #expect(Day("") == nil)
        #expect(Day("2026-10-20T00:00:00Z") == nil)
    }

    @Test("days compare and count in calendar order")
    func ordering() {
        #expect(Day("2026-09-30")! < Day("2026-10-01")!)
        #expect(Day("2025-12-31")! < Day("2026-01-01")!)
        #expect(Day("2026-10-13")!.days(since: Day("2026-10-12")!) == 1)
        #expect(Day("2026-10-01")!.days(since: Day("2026-10-12")!) == -11)
        #expect(Day("2026-11-02")!.days(since: Day("2026-10-31")!) == 2, "across the end of daylight saving time")
    }

    @Test("a moment becomes the day it falls on in the local time zone")
    func fromDate() {
        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        var chicago = Calendar(identifier: .gregorian)
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        let moment = Date(timeIntervalSince1970: 1_791_849_600) // 2026-10-13 00:00 UTC
        #expect(Day(moment, calendar: tokyo) == Day("2026-10-13"))
        #expect(Day(moment, calendar: chicago) == Day("2026-10-12"))
        #expect(Day(Day("2026-03-08")!.date(calendar: chicago), calendar: chicago) == Day("2026-03-08"), "round trip on a daylight-saving day")
    }

    @Test("a due date reads the way people say it")
    func labels() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let locale = Locale(identifier: "en_US")
        let today = Day("2026-10-12")! // a Monday
        func label(_ day: String) -> String { Day(day)!.label(relativeTo: today, calendar: calendar, locale: locale) }
        #expect(label("2026-10-12") == "Today")
        #expect(label("2026-10-13") == "Tomorrow")
        #expect(label("2026-10-11") == "Yesterday")
        #expect(label("2026-10-16") == "Friday")
        #expect(label("2026-10-18") == "Sunday")
        #expect(label("2026-10-19") == "Oct 19", "a week out, the weekday alone would be ambiguous")
        #expect(label("2026-10-05") == "Oct 5")
        #expect(label("2027-01-15") == "Jan 15, 2027")
    }

    @Test("a day is one JSON string")
    func coding() throws {
        let data = try JSONEncoder().encode([Day("2026-10-20")!])
        #expect(String(decoding: data, as: UTF8.self) == #"["2026-10-20"]"#)
        #expect(try JSONDecoder().decode([Day].self, from: data) == [Day("2026-10-20")!])
        #expect(throws: DecodingError.self) { try JSONDecoder().decode([Day].self, from: Data(#"["soon"]"#.utf8)) }
    }
}
