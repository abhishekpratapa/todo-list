// Reminders on this iPhone: local notifications scheduled from the list the phone
// has, so they fire even when the Mac is asleep or out of reach.
//
// It is a setting on this device, off until turned on. The Mac has its own
// (Todos > Reminder Notifications on This Mac), so each device can be chosen
// separately and nobody has to be reminded twice.

import Foundation
import TodosKit
import UserNotifications

@MainActor
final class Reminders {
    static let shared = Reminders()
    private static let enabledKey = "remindersOnThisIPhone"
    private let center = UNUserNotificationCenter.current()

    /// Whether the user wants reminders here. iOS's own permission is a separate matter: see `isAllowed`.
    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    /// Whether iOS will actually show them.
    func isAllowed() async -> Bool {
        let status = await center.notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    /// Turns reminders on or off here. Turning them on asks iOS for permission the first
    /// time; returns false if the user has refused it, in which case the setting stays off.
    func setEnabled(_ on: Bool, tasks: [TodoTask]) async -> Bool {
        if on {
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            guard granted else {
                UserDefaults.standard.set(false, forKey: Self.enabledKey)
                return false
            }
        }
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
        await reschedule(for: tasks)
        return true
    }

    /// Brings the scheduled notifications in line with the list: adds new and changed
    /// reminders, and removes ones whose task was finished, deleted or had its reminder cleared.
    func reschedule(for tasks: [TodoTask]) async {
        let pending = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix("reminder-") }
        guard isEnabled, await isAllowed() else {
            center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier))
            return
        }
        let plan = ReminderPlan.plan(for: tasks)
        let wanted = Set(plan.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { !wanted.contains($0) })

        let scheduled = Dictionary(pending.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
        for reminder in plan {
            if let existing = scheduled[reminder.id], Self.matches(existing, reminder) { continue }
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            content.userInfo = ["task": reminder.taskID, "fire": reminder.fireDate.timeIntervalSince1970]
            let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: reminder.fireDate)
            // Adding a request with an identifier already in use replaces the old one.
            try? await center.add(UNNotificationRequest(identifier: reminder.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
        }
    }

    private static func matches(_ request: UNNotificationRequest, _ reminder: PlannedReminder) -> Bool {
        request.content.title == reminder.title && request.content.body == reminder.body
            && (request.content.userInfo["fire"] as? Double) == reminder.fireDate.timeIntervalSince1970
    }
}

/// Shows reminders while the app is open, and opens the task when one is tapped.
final class Notifications: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = Notifications()

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let task = response.notification.request.content.userInfo["task"] as? Int else { return }
        await MainActor.run { AppModel.shared.requestedTask = task }
    }
}
