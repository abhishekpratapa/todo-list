import Foundation
import Testing
@testable import TodosKit

@Suite("The list on the phone")
struct TaskListTests {
    let today = Day("2026-10-12")!
    let tasks: [TodoTask] = [
        Sample.task(1, "Write report", status: .todo, priority: .low, due: "2026-10-12", project: "Work", tags: ["writing"]),
        Sample.task(2, "Fix login bug", status: .inProgress, priority: .high, project: "work", assignee: .claude),
        Sample.task(3, "Renew passport", status: .todo, priority: .high, due: "2026-10-01", project: "Personal"),
        Sample.task(4, "Waiting on design", status: .blocked, priority: .medium, due: "2026-10-20"),
        Sample.task(5, "Old thing", status: .done, completedAt: Date(timeIntervalSince1970: 100)),
        Sample.task(6, "Recent thing", status: .done, due: "2026-10-01", completedAt: Date(timeIntervalSince1970: 200)),
        Sample.task(7, "Call dentist", status: .todo, priority: .high, due: "2026-10-12"),
        Sample.task(8, "Undated", status: .todo, priority: .high),
    ]

    @Test("the four columns become sections: under way first, then blocked, then to do")
    func openSections() {
        let sections = tasks.sections(for: TaskQuery(), today: today)
        #expect(sections.map(\.status) == [.inProgress, .blocked, .todo])
        #expect(sections.map { $0.tasks.map(\.id) } == [[2], [4], [3, 7, 8, 1]], "to do: by priority, then due date, undated last")
        #expect(sections.allSatisfy { section in section.tasks.allSatisfy { $0.status == section.status } })
    }

    @Test("each segment shows one status, and empty sections are left out")
    func segments() {
        #expect(tasks.sections(for: TaskQuery(filter: .todo), today: today).map(\.status) == [.todo])
        #expect(tasks.sections(for: TaskQuery(filter: .inProgress), today: today).flatMap(\.tasks).map(\.id) == [2])
        #expect(tasks.sections(for: TaskQuery(filter: .blocked), today: today).flatMap(\.tasks).map(\.id) == [4])
        #expect(tasks.sections(for: TaskQuery(filter: .done), today: today).flatMap(\.tasks).map(\.id) == [6, 5], "most recently finished first")
        #expect(tasks.filter { $0.status != .blocked }.sections(for: TaskQuery(filter: .blocked), today: today).isEmpty)
        #expect(TaskFilter.allCases.map(\.label) == ["Open", "To do", "Doing", "Blocked", "Done"])
    }

    @Test("the order matches the Mac's")
    func order() {
        #expect(tasks.inListOrder().map(\.id) == [2, 4, 3, 7, 8, 1, 6, 5])
    }

    @Test("due today, overdue and with Claude narrow the list like the Mac's tiles")
    func focus() {
        func ids(_ focus: TaskFocus, _ filter: TaskFilter = .open) -> [Int] {
            tasks.sections(for: TaskQuery(filter: filter, focus: [focus]), today: today).flatMap(\.tasks).map(\.id)
        }
        #expect(ids(.dueToday) == [7, 1])
        #expect(ids(.overdue) == [3])
        #expect(ids(.withClaude) == [2])
        #expect(ids(.overdue, .done).isEmpty, "a finished task is never overdue")
    }

    @Test("projects filter without regard to case, and are listed once each")
    func projects() {
        #expect(tasks.sections(for: TaskQuery(projects: ["work"]), today: today).flatMap(\.tasks).map(\.id) == [2, 1])
        #expect(tasks.projects == ["Personal", "Work"])
    }

    @Test("search needs every word, and looks where the Mac looks")
    func search() {
        var searchable = tasks
        searchable[0].notes = "Use the Q3 numbers"
        searchable[3].subtasks = [Subtask(id: 1, title: "Ping Sam", done: false)]
        func ids(_ text: String) -> [Int] {
            searchable.sections(for: TaskQuery(search: text), today: today).flatMap(\.tasks).map(\.id)
        }
        #expect(ids("report") == [1])
        #expect(ids("  REPORT   q3 ") == [1], "title and notes")
        #expect(ids("report q4").isEmpty)
        #expect(ids("writing") == [1], "tags")
        #expect(ids("personal") == [3], "project")
        #expect(ids("sam") == [4], "subtask titles")
        #expect(ids("").count == 6)
        #expect(TaskQuery(search: "  ").isNarrowed == false)
        #expect(TaskQuery(search: "x").isNarrowed && TaskQuery(focus: [.overdue]).isNarrowed && TaskQuery(projects: ["p"]).isNarrowed)
    }

    @Test("several views, projects, priorities or tags: a task in any of them shows; different kinds must all match")
    func severalValues() {
        func ids(_ query: TaskQuery) -> [Int] {
            tasks.sections(for: query, today: today).flatMap(\.tasks).map(\.id)
        }
        #expect(ids(TaskQuery(focus: [.dueToday, .overdue])) == [3, 7, 1], "the Today view's tasks")
        #expect(ids(TaskQuery(focus: [.withClaude, .overdue])) == [2, 3])
        #expect(ids(TaskQuery(projects: ["Work", "personal"])) == [2, 3, 1])
        #expect(ids(TaskQuery(projects: [""])) == [4, 7, 8], "no project")
        #expect(ids(TaskQuery(priorities: [.high, .low])) == [2, 3, 7, 8, 1])
        #expect(ids(TaskQuery(projects: ["work"], priorities: [.high])) == [2])
        var tagged = tasks
        tagged[2].tags = ["errands", "writing"]
        func tagIDs(_ query: TaskQuery) -> [Int] { tagged.sections(for: query, today: today).flatMap(\.tasks).map(\.id) }
        #expect(tagIDs(TaskQuery(tags: ["writing", "errands"])) == [3, 1])
        #expect(tagIDs(TaskQuery(tags: ["writing", "errands"], tagMode: .all)) == [3])
        #expect(TaskQuery(priorities: [.low]).isFiltered && !TaskQuery(search: "x").isFiltered)
    }

    @Test("a sort orders each section on its own")
    func sortWithinSections() throws {
        let byDue = tasks.sections(for: TaskQuery(sort: try TaskSort("due")), today: today)
        #expect(byDue.map(\.status) == [.inProgress, .blocked, .todo], "the sections stay the statuses")
        #expect(byDue.last?.tasks.map(\.id) == [3, 1, 7, 8], "due first, ties by id, undated last")
        let byTitle = tasks.sections(for: TaskQuery(filter: .done, sort: try TaskSort("title")), today: today)
        #expect(byTitle.flatMap(\.tasks).map(\.id) == [5, 6])
        #expect(tasks.inListOrder().map(\.id) == tasks.sorted(by: .default).map(\.id))
    }

    @Test("what is kept between launches: everything but the search, read one field at a time")
    func kept() throws {
        let query = TaskQuery(filter: .todo, focus: [.overdue], projects: ["Work", ""], priorities: [.high], tags: ["errands"], tagMode: .all,
                              sort: try TaskSort("due,-priority"), search: "passport")
        let saved = try JSONEncoder().encode(query)
        var back = try JSONDecoder().decode(TaskQuery.self, from: saved)
        #expect(back.search == "", "an old search would hide tasks without saying why")
        back.search = "passport"
        #expect(back == query)
        // A sort key from a later version, and a field that isn't a list: the rest stands.
        var json = try JSONSerialization.jsonObject(with: saved) as! [String: Any]
        json["sort"] = "due,urgency"
        json["projects"] = "Work"
        let partly = try JSONDecoder().decode(TaskQuery.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(partly.sort.isDefault && partly.projects.isEmpty && partly.filter == .todo && partly.priorities == [.high] && partly.tagMode == .all)
        #expect(try JSONDecoder().decode(TaskQuery.self, from: Data("{}".utf8)) == TaskQuery())
    }

    @Test("counts match the Mac's tiles")
    func counts() {
        let now = Date(timeIntervalSince1970: 200 + 3 * 86_400)
        let counts = tasks.counts(today: today, now: now)
        #expect(counts == Counts(open: 6, inProgress: 1, blocked: 1, overdue: 1, dueToday: 2, claude: 1, doneThisWeek: 2))
        #expect(tasks.counts(today: today, now: Date(timeIntervalSince1970: 150 + 7 * 86_400)).doneThisWeek == 1)
    }
}
