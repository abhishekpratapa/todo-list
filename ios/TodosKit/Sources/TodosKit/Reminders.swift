// Working out which reminders this iPhone should schedule as local notifications,
// from the list it has. They are scheduled on the phone so they fire even when the
// Mac is asleep. (Scheduling itself needs the notification centre, so it is in the app.)

import Foundation

public struct PlannedReminder: Sendable, Equatable, Identifiable {
    /// Also the notification's identifier: one per task, so a changed reminder replaces the old one.
    public var id: String
    public var taskID: Int
    public var title: String
    public var body: String
    public var fireDate: Date

    public static func identifier(for task: Int) -> String { "reminder-\(task)" }
}

public enum ReminderPlan {
    /// iOS keeps at most 64 pending notifications for an app. The soonest ones are scheduled;
    /// the rest follow as those fire and the list is synced again.
    public static let limit = 60

    /// Reminders still to come, soonest first: open tasks whose reminder time has not passed.
    public static func plan(for tasks: [TodoTask], now: Date = Date(), calendar: Calendar = .current, limit: Int = ReminderPlan.limit) -> [PlannedReminder] {
        tasks.compactMap { task -> PlannedReminder? in
            guard task.status.isOpen, let fire = task.remindAt, fire > now else { return nil }
            let day = Day(fire, calendar: calendar)
            // Read as of the day the reminder fires, since that is when it will be seen.
            let body = task.due.map { $0 < day ? "Overdue" : $0 == day ? "Due today" : "Due \($0.label(relativeTo: day, calendar: calendar).lowercasedUnlessDate)" } ?? "Reminder"
            return PlannedReminder(id: PlannedReminder.identifier(for: task.id), taskID: task.id, title: task.title, body: body, fireDate: fire)
        }
        .sorted { ($0.fireDate, $0.taskID) < ($1.fireDate, $1.taskID) }
        .prefix(limit)
        .map { $0 }
    }
}

private extension String {
    /// "Tomorrow" and "Friday" read better mid-sentence in lower case for the first; a date like "Oct 20" stays as it is.
    var lowercasedUnlessDate: String {
        ["Today", "Tomorrow", "Yesterday"].contains(self) ? lowercased() : self
    }
}
