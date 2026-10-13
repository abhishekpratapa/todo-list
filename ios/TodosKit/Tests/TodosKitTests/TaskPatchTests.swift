import Foundation
import Testing
@testable import TodosKit

@Suite("Task edits")
struct TaskPatchTests {
    private func json(_ patch: TaskPatch) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: HubJSON.encoder().encode(patch)) as! [String: Any]
    }

    @Test("only the fields that change are sent")
    func encodesOnlyChanges() throws {
        let body = try json(TaskPatch(title: "New title", priority: .low))
        #expect(body.keys.sorted() == ["priority", "title"])
        #expect(body["title"] as? String == "New title")
        #expect(body["priority"] as? String == "low")
        #expect(try json(TaskPatch()).isEmpty)
    }

    @Test("clearing a field sends null; setting it sends the value")
    func clearing() throws {
        let cleared = try json(TaskPatch(due: .clear, project: .clear, repeats: .clear, remindAt: .clear))
        #expect(cleared.keys.sorted() == ["due", "project", "remindAt", "repeat"])
        #expect(cleared.values.allSatisfy { $0 is NSNull })

        let set = try json(TaskPatch(status: .inProgress, tags: ["a", "b"], due: .set(Day("2026-10-20")!), project: .set("Work"),
                                     repeats: .set(.biweekly), remindAt: .set(Date(timeIntervalSince1970: 1_792_072_800))))
        #expect(set["due"] as? String == "2026-10-20")
        #expect(set["project"] as? String == "Work")
        #expect(set["repeat"] as? String == "biweekly")
        #expect(set["remindAt"] as? String == "2026-10-15T14:00:00.000Z", "a full timestamp with its zone, which the Mac reads as an exact moment")
        #expect(set["status"] as? String == "in_progress")
        #expect(set["tags"] as? [String] == ["a", "b"])
    }

    @Test("the difference between two versions of a task is the edit")
    func diff() {
        let old = Sample.task
        var new = old
        #expect(TaskPatch(from: old, to: new).isEmpty)

        new.title = "Renew passport today"
        new.due = nil
        new.project = "admin"
        new.tags = ["errand"]
        new.repeats = nil
        new.status = .blocked
        let patch = TaskPatch(from: old, to: new)
        #expect(patch == TaskPatch(title: "Renew passport today", status: .blocked, tags: ["errand"], due: .clear, project: .set("admin"), repeats: .clear))
        #expect(patch.fields == [.title, .status, .tags, .due, .project, .repeats])

        // Things only the Mac sets never become part of an edit.
        var touched = old
        touched.rev = 99
        touched.activity = []
        touched.subtasks = []
        touched.updatedAt = .distantFuture
        #expect(TaskPatch(from: old, to: touched).isEmpty)
    }

    @Test("applying an edit shows it straight away without touching what the Mac owns")
    func applied() {
        let old = Sample.task
        let patch = TaskPatch(notes: "", status: .done, assignee: .me, due: .clear, remindAt: .set(Date(timeIntervalSince1970: 5)))
        let new = patch.applied(to: old)
        #expect(new.notes == "" && new.status == .done && new.assignee == .me && new.due == nil)
        #expect(new.remindAt == Date(timeIntervalSince1970: 5))
        #expect(new.rev == old.rev && new.activity == old.activity && new.title == old.title && new.project == old.project)
        #expect(TaskPatch(from: old, to: new) == patch)
    }

    @Test("an edit survives being saved and loaded, including which fields are cleared")
    func roundTrip() throws {
        let patch = TaskPatch(title: "T", notes: "", status: .blocked, priority: .high, assignee: .claude, tags: [],
                              due: .clear, project: .set("p"), repeats: .set(.weekdays), remindAt: .clear)
        let data = try HubJSON.encoder().encode(patch)
        #expect(try HubJSON.decoder().decode(TaskPatch.self, from: data) == patch)
        #expect(try HubJSON.decoder().decode(TaskPatch.self, from: Data("{}".utf8)) == TaskPatch())
    }
}
