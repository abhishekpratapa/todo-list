// What the iOS extras rely on: which reminders to schedule, where shared files live,
// and tasks added from outside the app.

import Foundation
import Testing
@testable import TodosKit

@Suite("Reminders to schedule on the iPhone")
struct ReminderPlanTests {
    let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }()
    var now: Date { calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 10))! }

    private func at(_ day: Int, _ hour: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
    }

    private func task(_ id: Int, _ title: String, remind: Date?, due: String? = nil, status: TaskStatus = .todo) -> TodoTask {
        var task = Sample.task(id, title, status: status, due: due)
        task.remindAt = remind
        return task
    }

    @Test("open tasks with a reminder still to come are scheduled, soonest first")
    func plan() {
        let tasks = [
            task(1, "Later", remind: at(14, 9)),
            task(2, "Sooner", remind: at(12, 15)),
            task(3, "Already passed", remind: at(12, 9)),
            task(4, "No reminder", remind: nil),
            task(5, "Finished", remind: at(13, 9), status: .done),
            task(6, "Blocked still counts", remind: at(13, 9), status: .blocked),
        ]
        let plan = ReminderPlan.plan(for: tasks, now: now, calendar: calendar)
        #expect(plan.map(\.taskID) == [2, 6, 1])
        #expect(plan.map(\.id) == ["reminder-2", "reminder-6", "reminder-1"])
        #expect(plan[0].title == "Sooner" && plan[0].fireDate == at(12, 15))
    }

    @Test("the text says when the task is due, as of when the reminder fires")
    func body() {
        func body(due: String?, remind: Date) -> String? {
            ReminderPlan.plan(for: [task(1, "T", remind: remind, due: due)], now: now, calendar: calendar).first?.body
        }
        #expect(body(due: nil, remind: at(13, 9)) == "Reminder")
        #expect(body(due: "2026-10-13", remind: at(13, 9)) == "Due today")
        #expect(body(due: "2026-10-14", remind: at(13, 9)) == "Due tomorrow")
        #expect(body(due: "2026-10-16", remind: at(13, 9)) == "Due Friday")
        #expect(body(due: "2026-10-12", remind: at(13, 9)) == "Overdue")
    }

    @Test("no more are scheduled than iOS will keep, and a reminder that has not changed keeps its identity")
    func limit() {
        let many = (1...100).map { task($0, "Task \($0)", remind: now.addingTimeInterval(Double($0) * 3600)) }
        let plan = ReminderPlan.plan(for: many, now: now, calendar: calendar)
        #expect(plan.count == 60 && plan.first?.taskID == 1 && plan.last?.taskID == 60)
        #expect(ReminderPlan.limit <= 64)
        #expect(ReminderPlan.plan(for: many, now: now, calendar: calendar) == plan)
        #expect(PlannedReminder.identifier(for: 7) == "reminder-7")
    }

    @Test("a reminder set offline is planned from what the phone shows, before the Mac has it")
    func fromPendingChange() {
        let cached = [task(1, "Call back", remind: nil)]
        let change = PendingChange(kind: .update(task: 1, baseRev: 1, base: TaskPatch(remindAt: .clear), patch: TaskPatch(remindAt: .set(at(12, 16)))))
        #expect(ReminderPlan.plan(for: cached.applying([change]), now: now, calendar: calendar).map(\.fireDate) == [at(12, 16)])
    }
}

@Suite("What the app, widget and extensions share")
struct SharedContainerTests {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-shared-\(UUID().uuidString)", isDirectory: true)

    @Test("each Mac gets a folder of its own, named safely after its address")
    func hubFolders() throws {
        let first = SharedContainer.hubDirectory(for: try HubAddress("my-mac.tail1234.ts.net"), in: directory)
        let second = SharedContainer.hubDirectory(for: try HubAddress("my-mac.tail1234.ts.net:8443"), in: directory)
        #expect(first.path.hasSuffix("/Hubs/my-mac.tail1234.ts.net"))
        #expect(second.lastPathComponent == "my-mac.tail1234.ts.net_8443")
        #expect(first != second)
    }

    @Test("the widget and extensions can find the paired Mac's folder, and nothing when unpaired")
    func currentHub() throws {
        #expect(SharedContainer.currentHubDirectory(in: directory) == nil)
        let address = try HubAddress("my-mac.tail1234.ts.net:8443")
        SharedContainer.setCurrentHub(address, in: directory)
        #expect(SharedContainer.currentHubDirectory(in: directory) == SharedContainer.hubDirectory(for: address, in: directory))
        // Only the folder's name is written there: nothing secret.
        let pointer = directory.appendingPathComponent("current-hub.txt")
        #expect(try String(contentsOf: pointer, encoding: .utf8) == "my-mac.tail1234.ts.net_8443")
        SharedContainer.setCurrentHub(nil, in: directory)
        #expect(SharedContainer.currentHubDirectory(in: directory) == nil)

        // Whatever that file says, it can only ever name a folder inside Hubs.
        for bad in ["", "..", "../../elsewhere", "a/b", "name with spaces"] {
            try Data(bad.utf8).write(to: pointer)
            #expect(SharedContainer.currentHubDirectory(in: directory) == nil, "\(bad)")
        }
    }

    @Test("the widget reads the same list and waiting changes the app wrote, without changing anything")
    func readOnly() async throws {
        let folder = SharedContainer.hubDirectory(for: try HubAddress("my-mac.tail1234.ts.net"), in: directory)
        #expect(LocalStore.read(directory: folder).list.tasks.isEmpty, "nothing there yet is not an error")
        #expect(!FileManager.default.fileExists(atPath: folder.path), "and looking creates nothing")

        let store = LocalStore(directory: folder)
        await store.replaceList([Sample.task(1, "Due today", due: "2026-10-12"), Sample.task(2, "Other")], version: 3)
        await store.add(.complete(task: 1))
        await store.add(.add(title: "Shared link", notes: "https://example.com"))

        let seen = LocalStore.read(directory: folder)
        #expect(seen.list.tasks.map(\.title) == ["Due today", "Other"])
        #expect(seen.list.version == 3)
        #expect(seen.changes.map(\.kind) == [.complete(task: 1), .add(title: "Shared link", notes: "https://example.com")])
        #expect(seen.list.tasks.applying(seen.changes).first?.status == .done, "the widget shows what the app shows")
    }
}

@Suite("Tasks added from outside the app")
struct AddedTaskTests {
    @Test("a task added from the share sheet is created as given, not parsed as a line, and only once")
    func sharedTask() async throws {
        let stub = StubTransport()
        let store = LocalStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("todoskit-add-\(UUID().uuidString)", isDirectory: true))
        let change = await store.add(.add(title: "Read: fri !high #notaproject", notes: "https://example.com/article"))
        #expect(change.taskID == nil && change.summary == "Add “Read: fri !high #notaproject”")
        var created = Sample.task(9, "Read: fri !high #notaproject")
        created.notes = "https://example.com/article"
        stub.reply(201, #"{"task":\#(String(decoding: try HubJSON.encoder().encode(created), as: UTF8.self))}"#)

        #expect(await SyncEngine(client: Sample.client(stub), store: store).replay() == .finished)
        #expect(stub.last.httpMethod == "POST" && stub.last.url?.path == "/api/v1/tasks", "created directly, not through quick capture")
        #expect(stub.body()["title"] as? String == "Read: fri !high #notaproject")
        #expect(stub.body()["notes"] as? String == "https://example.com/article")
        #expect(stub.last.value(forHTTPHeaderField: "Idempotency-Key") == change.id.uuidString)
        #expect(await store.changes.isEmpty)
        #expect(await store.task(9)?.notes == "https://example.com/article")
    }

    @Test("the kind survives being saved and loaded")
    func coding() throws {
        let change = PendingChange(kind: .add(title: "t", notes: "n"))
        #expect(try HubJSON.decoder().decode(PendingChange.self, from: HubJSON.encoder().encode(change)).kind == change.kind)
    }
}

@Suite("Links and shared content")
struct SharingTests {
    @Test("a link into the app names a task, and nothing else is accepted")
    func links() {
        #expect(AppLinks.task(7).absoluteString == "todos-app://task/7")
        #expect(AppLinks.task(from: AppLinks.task(42)) == 42)
        #expect(AppLinks.task(from: URL(string: "todos-app://task/abc")!) == nil)
        #expect(AppLinks.task(from: URL(string: "todos-app://settings/7")!) == nil)
        #expect(AppLinks.task(from: URL(string: "https://example.com/task/7")!) == nil)
        #expect(AppLinks.task(from: URL(string: "todos-pair:?v=1&t=secret")!) == nil)
    }

    @Test("a shared link becomes a task named after the page, with the link in its notes")
    func sharedLink() {
        let url = URL(string: "https://example.com/articles/42")!
        let page = SharedContent.task(url: url, text: nil, pageTitle: "How to renew a passport")
        #expect(page.title == "How to renew a passport" && page.notes == "https://example.com/articles/42")

        let bare = SharedContent.task(url: url, text: nil, pageTitle: nil)
        #expect(bare.title == "example.com" && bare.notes == "https://example.com/articles/42")

        let selection = SharedContent.task(url: url, text: "Bring two photos and the old passport.", pageTitle: "How to renew a passport")
        #expect(selection.title == "How to renew a passport")
        #expect(selection.notes == "https://example.com/articles/42\n\nBring two photos and the old passport.")

        // Some apps give the link itself as the title.
        #expect(SharedContent.task(url: url, text: nil, pageTitle: "https://example.com/articles/42").title == "example.com")
    }

    @Test("shared text becomes the title, and the notes too when there is more of it")
    func sharedText() {
        let short = SharedContent.task(url: nil, text: "  Buy stamps  ", pageTitle: nil)
        #expect(short.title == "Buy stamps" && short.notes.isEmpty)

        let long = SharedContent.task(url: nil, text: "Trip ideas\n- Lisbon\n- Porto", pageTitle: nil)
        #expect(long.title == "Trip ideas" && long.notes == "Trip ideas\n- Lisbon\n- Porto")

        let huge = SharedContent.task(url: nil, text: String(repeating: "word ", count: 100), pageTitle: nil)
        #expect(huge.title.count == 200 && huge.title.hasSuffix("…"))
        #expect(huge.notes.count > 400, "nothing is lost: the whole text is in the notes")

        let nothing = SharedContent.task(url: nil, text: nil, pageTitle: nil)
        #expect(nothing.title.isEmpty && nothing.notes.isEmpty)
    }
}

@Suite("What the widget shows")
struct DueOverviewTests {
    let today = Day("2026-10-12")!
    let tasks: [TodoTask] = [
        Sample.task(1, "Overdue, older", due: "2026-10-01"),
        Sample.task(2, "Overdue, newer", priority: .high, due: "2026-10-10"),
        Sample.task(3, "Today, low", priority: .low, due: "2026-10-12"),
        Sample.task(4, "Today, high", priority: .high, due: "2026-10-12"),
        Sample.task(5, "Tomorrow", due: "2026-10-13"),
        Sample.task(6, "In a week", due: "2026-10-19"),
        Sample.task(7, "In eight days", due: "2026-10-20"),
        Sample.task(8, "No date"),
        Sample.task(9, "Done today", status: .done, due: "2026-10-12"),
        Sample.task(10, "Done, was overdue", status: .done, due: "2026-10-01"),
        Sample.task(11, "Friday, blocked", status: .blocked, due: "2026-10-16"),
        Sample.task(12, "Friday, high", priority: .high, due: "2026-10-16"),
    ]
    var overview: DueOverview { DueOverview(tasks: tasks, on: today) }

    @Test("open tasks are sorted into overdue, today, the week ahead and the rest; finished ones are left out")
    func sorting() {
        #expect(overview.overdue.map(\.id) == [1, 2], "longest overdue first")
        #expect(overview.today.map(\.id) == [4, 3], "by priority, like the list")
        #expect(overview.upcoming.map(\.id) == [5, 11, 12, 6], "soonest first; within a day, the list's order")
        #expect(overview.dueNow.map(\.id) == [1, 2, 4, 3])
        #expect(overview.later.map(\.id) == [7, 8], "more than a week out, and undated: the list's order")
        let all = overview.overdue + overview.today + overview.upcoming + overview.later
        #expect(all.map(\.id).sorted() == [1, 2, 3, 4, 5, 6, 7, 8, 11, 12], "each open task appears once")
    }

    @Test("the small print under a title says only what the title does not")
    func detail() {
        #expect(Sample.task(1, "Plain").widgetDetail == "")
        #expect(Sample.task(1, status: .inProgress).widgetDetail == "In progress")
        #expect(Sample.task(1, status: .blocked, project: "taxes").widgetDetail == "Blocked · #taxes")
        #expect(Sample.task(1, project: "home", tags: ["errand"], assignee: .claude).widgetDetail == "With Claude · #home", "tags are left to the app")
        var listed = Sample.task(1, status: .inProgress, project: "taxes")
        listed.subtasks = [Subtask(id: 1, title: "a", done: true), Subtask(id: 2, title: "b", done: false), Subtask(id: 3, title: "c", done: true)]
        #expect(listed.widgetDetail == "In progress · #taxes · 2/3")
        #expect(Sample.task(1, project: "").widgetDetail == "")
    }

    @Test("the summary counts what is due")
    func summary() {
        #expect(overview.summary == "2 due today · 2 overdue")
        #expect(DueOverview(tasks: [Sample.task(1, due: "2026-10-12")], on: today).summary == "1 due today")
        #expect(DueOverview(tasks: [Sample.task(1, due: "2026-10-20")], on: today).summary == "Nothing due today")
        #expect(DueOverview(tasks: [], on: today) == DueOverview())
    }

    @Test("with plenty of room, everything is shown under its heading")
    func fits() {
        let (sections, hidden) = overview.sections(fitting: 14)
        #expect(sections.map(\.kind) == [.overdue, .today, .upcoming, .later])
        #expect(sections.map { $0.tasks.map(\.id) } == [[1, 2], [4, 3], [5, 11, 12, 6], [7, 8]])
        #expect(hidden == 0)
        #expect(sections.map(\.kind.label) == ["Overdue", "Today", "Coming up", "Also open"])
    }

    @Test("with less room, what is due now comes first and the rest is counted as hidden")
    func truncates() {
        var (sections, hidden) = overview.sections(fitting: 13) // 4 headings + 9 tasks
        #expect(sections.map { $0.tasks.map(\.id) } == [[1, 2], [4, 3], [5, 11, 12, 6], [7]])
        #expect(hidden == 1)

        (sections, hidden) = overview.sections(fitting: 12) // no room for a fourth heading with a task under it
        #expect(sections.map(\.kind) == [.overdue, .today, .upcoming])
        #expect(hidden == 2)

        (sections, hidden) = overview.sections(fitting: 8) // 3 headings + 5 tasks
        #expect(sections.map { $0.tasks.map(\.id) } == [[1, 2], [4, 3], [5]])
        #expect(hidden == 5)

        (sections, hidden) = overview.sections(fitting: 6)
        #expect(sections.map(\.kind) == [.overdue, .today])
        #expect(hidden == 6)

        (sections, hidden) = overview.sections(fitting: 2)
        #expect(sections.map { $0.tasks.map(\.id) } == [[1]])
        #expect(hidden == 9)

        (sections, hidden) = overview.sections(fitting: 1)
        #expect(sections.isEmpty && hidden == 10)
    }

    @Test("when nothing is due, the room goes to the rest of the open tasks")
    func nothingDue() {
        let undated = DueOverview(tasks: [Sample.task(1, "Someday"), Sample.task(2, "Urgent, no date", priority: .high), Sample.task(3, "Finished", status: .done)], on: today)
        #expect(undated.dueNow.isEmpty && undated.summary == "Nothing due today")
        let (sections, hidden) = undated.sections(fitting: 10)
        #expect(sections.map(\.kind) == [.later])
        #expect(sections[0].tasks.map(\.id) == [2, 1] && hidden == 0)
    }

    @Test("an empty section takes no room")
    func emptySections() {
        let quiet = DueOverview(tasks: [Sample.task(5, "Tomorrow", due: "2026-10-13"), Sample.task(6, "In a week", due: "2026-10-19")], on: today)
        let (sections, hidden) = quiet.sections(fitting: 3)
        #expect(sections.map(\.kind) == [.upcoming])
        #expect(sections[0].tasks.count == 2 && hidden == 0)
    }

    @Test("the week ahead is counted in calendar days, across a month end")
    func weekAhead() {
        let end = Day("2026-10-28")!
        let tasks = [Sample.task(1, "Next month", due: "2026-11-04"), Sample.task(2, "Too far", due: "2026-11-05")]
        #expect(DueOverview(tasks: tasks, on: end).upcoming.map(\.id) == [1])
    }
}
