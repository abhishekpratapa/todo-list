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
            tasks.sections(for: TaskQuery(filter: filter, focus: focus), today: today).flatMap(\.tasks).map(\.id)
        }
        #expect(ids(.dueToday) == [7, 1])
        #expect(ids(.overdue) == [3])
        #expect(ids(.withClaude) == [2])
        #expect(ids(.overdue, .done).isEmpty, "a finished task is never overdue")
    }

    @Test("projects filter without regard to case, and are listed once each")
    func projects() {
        #expect(tasks.sections(for: TaskQuery(project: "work"), today: today).flatMap(\.tasks).map(\.id) == [2, 1])
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
        #expect(TaskQuery(search: "x").isNarrowed && TaskQuery(focus: .overdue).isNarrowed && TaskQuery(project: "p").isNarrowed)
    }

    @Test("counts match the Mac's tiles")
    func counts() {
        let now = Date(timeIntervalSince1970: 200 + 3 * 86_400)
        let counts = tasks.counts(today: today, now: now)
        #expect(counts == Counts(open: 6, inProgress: 1, blocked: 1, overdue: 1, dueToday: 2, claude: 1, doneThisWeek: 2))
        #expect(tasks.counts(today: today, now: Date(timeIntervalSince1970: 150 + 7 * 86_400)).doneThisWeek == 1)
    }
}
