import Foundation
import Testing
@testable import TodosKit

/// The cases the Mac's rules (src/query.js) and the command-line client's pass too,
/// in test/fixtures/query-cases.json at the top of the repository.
enum SharedCases {
    struct Case: Decodable, CustomTestStringConvertible {
        var name: String
        var tasks: String?
        var today: String?
        var filter: [String: String]?
        var sort: String?
        var view: String?
        var error: String?
        var expect: Expectation?

        var testDescription: String { name }
    }

    enum Expectation: Decodable {
        case ids([Int])
        case groups(overdue: [Int], today: [Int])

        init(from decoder: Decoder) throws {
            if let ids = try? decoder.singleValueContainer().decode([Int].self) {
                self = .ids(ids)
            } else {
                let groups = try decoder.singleValueContainer().decode([String: [Int]].self)
                self = .groups(overdue: groups["overdue"] ?? [], today: groups["today"] ?? [])
            }
        }
    }

    static let file = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() // up to TodosKit
        .deletingLastPathComponent().deletingLastPathComponent() // up to the repository
        .appendingPathComponent("test/fixtures/query-cases.json")

    struct Fixture {
        var today: Day
        var sets: [String: [TodoTask]]
        var cases: [Case]
    }

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: file)
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let defaults = json["defaults"] as! [String: Any]
        var sets: [String: [TodoTask]] = [:]
        for (name, list) in json["taskSets"] as! [String: [[String: Any]]] {
            sets[name] = list.map { own in
                // Each task is the defaults with its own fields on top, then read as the Mac's JSON.
                let task = defaults.merging(own) { _, mine in mine }
                return try! HubJSON.decoder().decode(TodoTask.self, from: JSONSerialization.data(withJSONObject: task))
            }
        }
        struct Cases: Decodable { var cases: [Case] }
        let cases = try! JSONDecoder().decode(Cases.self, from: data).cases
        return Fixture(today: Day(json["today"] as! String)!, sets: sets, cases: cases)
    }()
}

@Suite("The rules every client shares")
struct ListRulesTests {
    @Test("the shared cases", arguments: SharedCases.fixture.cases)
    func sharedCase(_ c: SharedCases.Case) throws {
        let fixture = SharedCases.fixture
        // Backwards, so nothing can pass by leaving the tasks in the order they came.
        let tasks = Array(fixture.sets[c.tasks ?? "board"]!.reversed())
        let today = c.today.flatMap(Day.init) ?? fixture.today
        switch c.error {
        case "sort":
            #expect(throws: ListRuleError.self) { try TaskSort(c.sort ?? "") }
            return
        case "filter":
            #expect(throws: ListRuleError.self) { try ListFilter(text: c.filter ?? [:]) }
            return
        case nil: break
        default: Issue.record("an error is \"sort\" or \"filter\", not \(c.error!)")
        }
        switch (c.view, c.expect) {
        case ("today", .groups(let overdue, let dueToday)?):
            // The Today view is built on DueOverview, which the widget shows.
            let sections = DueOverview(tasks: tasks, on: today).todaySections
            #expect(sections.first { $0.kind == .overdue }?.tasks.map(\.id) ?? [] == overdue)
            #expect(sections.first { $0.kind == .today }?.tasks.map(\.id) ?? [] == dueToday)
        case (nil, .ids(let ids)?):
            let filter = try ListFilter(text: c.filter ?? [:])
            let sort = try TaskSort(c.sort ?? "")
            #expect(tasks.filter { filter.matches($0, today: today) }.sorted(by: sort).map(\.id) == ids)
        default:
            Issue.record("a case is a list with ids, or the \"today\" view with its groups")
        }
    }

    @Test("there are enough cases for this to mean something")
    func enough() {
        #expect(SharedCases.fixture.cases.count > 50)
    }

    @Test("a sort reads and writes its text form, and is kept as that")
    func sortText() throws {
        let sort = try TaskSort(" Due , -PRIORITY ")
        #expect(sort.description == "due,-priority" && !sort.isDefault)
        #expect(try TaskSort("").isDefault && TaskSort.default.description == "default")
        let saved = try JSONEncoder().encode(sort)
        #expect(String(decoding: saved, as: UTF8.self) == #""due,-priority""#)
        #expect(try JSONDecoder().decode(TaskSort.self, from: saved) == sort)
        #expect(throws: ListRuleError(description: #"Unknown sort key "dew". Sort by any of: default, status, priority, due, created, updated, completed, title, project, id. Separate keys with commas, and put - in front of one to reverse it, as in "due,-priority"."#)) {
            try TaskSort("due,dew")
        }
    }
}
