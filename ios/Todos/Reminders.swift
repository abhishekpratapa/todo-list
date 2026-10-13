// Reminders on this iPhone: local notifications for tasks and for habits,
// scheduled from what the phone has, so they fire even when the Mac is asleep
// or out of reach.
//
// Which ones, and how they share the 64 that iOS will keep, is worked out by
// TodosKit's NotificationPlan. This file keeps the notification centre in line
// with that plan, and answers the buttons on a habit's reminder: Done checks
// in without opening the app, and Snooze brings it back in a quarter of an hour.
//
// Task reminders are a setting on this device, off until turned on. The Mac has
// its own (Todos > Reminder Notifications on This Mac), so nobody has to be
// reminded twice. Habit reminders are on unless turned off: the phone is where
// they are meant to come from.

import Foundation
import TodosKit
import UserNotifications

/// A notification that is waiting to fire, as far as the scheduler needs to know it.
struct WaitingNotification: Sendable, Equatable {
    var id: String
    var title: String
    var body: String
    /// Changes whenever the time it fires at does.
    var stamp: String
}

enum NotificationPermission: Sendable {
    case allowed, refused, notAsked
}

/// What the scheduler needs of the notification centre. The real one is iOS's; tests use a stand-in.
protocol NotificationCentre: Sendable {
    func permission() async -> NotificationPermission
    /// Asks the user. Returns whether they agreed.
    func askPermission() async -> Bool
    func waiting() async -> [WaitingNotification]
    /// Identifiers of notifications that have fired and are still on screen or in Notification Centre.
    func delivered() async -> [String]
    func schedule(_ notification: PlannedNotification) async
    /// Schedules a copy of a habit's reminder to fire `seconds` from now.
    func snooze(id: String, habit: Int, title: String, body: String, after seconds: TimeInterval) async
    /// Shows something straight away.
    func say(id: String, title: String, body: String) async
    /// Takes notifications away, whether they are waiting or already shown.
    func cancel(_ ids: [String]) async
}

enum HabitNotification {
    /// The category that gives a habit's reminder its buttons.
    static let category = "habit"
    static let done = "habit.done"
    static let snooze = "habit.snooze"
    static let snoozeSeconds: TimeInterval = 15 * 60
}

extension PlannedNotification {
    /// When it fires, as text: the same text for the same time, different for a different one.
    var stamp: String {
        if let wallClock { return "\(wallClock.year ?? 0)-\(wallClock.month ?? 0)-\(wallClock.day ?? 0) \(wallClock.hour ?? 0):\(wallClock.minute ?? 0)" }
        return String(fireDate.timeIntervalSince1970)
    }
}

@MainActor
final class Reminders {
    static let shared = Reminders()
    private static let enabledKey = "remindersOnThisIPhone"
    private static let habitsOffKey = "habitRemindersOffOnThisIPhone"

    private let centre: any NotificationCentre
    private let defaults: UserDefaults
    /// The plan as last laid out: for Settings to say how far ahead habit reminders reach.
    private(set) var plan: NotificationPlan?

    init(centre: any NotificationCentre = SystemNotificationCentre(), defaults: UserDefaults = .standard) {
        self.centre = centre
        self.defaults = defaults
    }

    /// Whether the user wants task reminders here. iOS's own permission is a separate matter: see `isAllowed`.
    var isEnabled: Bool {
        defaults.bool(forKey: Self.enabledKey)
    }

    /// Whether the user wants habit reminders here. They do unless they have said otherwise.
    var habitsEnabled: Bool {
        !defaults.bool(forKey: Self.habitsOffKey)
    }

    /// Whether iOS will actually show them.
    func isAllowed() async -> Bool {
        await centre.permission() == .allowed
    }

    /// Turns task reminders on or off here. Turning them on asks iOS for permission the first
    /// time; returns false if the user has refused it, in which case the setting stays off.
    func setEnabled(_ on: Bool, tasks: [TodoTask], habits: [Habit] = []) async -> Bool {
        if on, await centre.permission() != .allowed {
            guard await centre.askPermission() else {
                defaults.set(false, forKey: Self.enabledKey)
                return false
            }
        }
        defaults.set(on, forKey: Self.enabledKey)
        await reschedule(tasks: tasks, habits: habits)
        return true
    }

    /// Turns habit reminders on or off here. Returns false if they are wanted and iOS won't show them.
    func setHabitsEnabled(_ on: Bool, tasks: [TodoTask], habits: [Habit]) async -> Bool {
        defaults.set(!on, forKey: Self.habitsOffKey)
        var allowed = true
        if on {
            switch await centre.permission() {
            case .allowed: break
            case .refused: allowed = false
            case .notAsked: allowed = await centre.askPermission()
            }
        }
        await reschedule(tasks: tasks, habits: habits)
        return allowed
    }

    /// Habits that have reminder times need iOS's permission to keep them. The first time
    /// there are any, and the app is on screen, the user is asked.
    func askForHabits(_ habits: [Habit], tasks: [TodoTask]) async {
        guard habitsEnabled, await centre.permission() == .notAsked, !HabitReminderPlan.plan(for: habits, days: 8).isEmpty else { return }
        if await centre.askPermission() { await reschedule(tasks: tasks, habits: habits) }
    }

    /// Brings the notifications that are waiting in line with the plan: adds new and changed
    /// ones, and takes away those for a task that was finished or a slot that was checked
    /// in, including a nudge or a snoozed reminder already on screen for it.
    func reschedule(tasks: [TodoTask], habits: [Habit], now: Date = Date()) async {
        let waiting = await centre.waiting()
        let allowed = await isAllowed()
        let snoozes = waiting.filter { $0.id.hasPrefix("snooze-") }
        let plan = NotificationPlan.make(tasks: tasks, habits: habits, taskReminders: isEnabled && allowed, habitReminders: habitsEnabled && allowed,
                                         snoozed: snoozes.count, now: now)
        self.plan = plan
        let wanted = Dictionary(plan.notifications.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        // What a habit's reminder is about may be done by now, or no longer loggable.
        func stale(_ id: String) -> Bool {
            guard let target = PlannedNotification.habitTarget(of: id) else { return false }
            return habits.first { $0.id == target.habit }?.isOpen(slot: target.slot, on: target.day) != true
        }
        var cancel = waiting.map(\.id).filter { $0.hasPrefix("snooze-") ? stale($0) || !habitsEnabled : wanted[$0] == nil }
        cancel += await centre.delivered().filter(stale)
        if !cancel.isEmpty { await centre.cancel(Array(Set(cancel))) }

        let scheduled = Dictionary(waiting.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for notification in plan.notifications {
            if let existing = scheduled[notification.id], existing.title == notification.title, existing.body == notification.body, existing.stamp == notification.stamp { continue }
            await centre.schedule(notification) // one with an identifier already in use replaces the old one
        }
    }

    // MARK: The buttons on a habit's reminder

    /// "Done": checks the habit in without opening the app, through the same queue as a
    /// check-in made in the app, so it waits if the Mac can't be reached.
    func done(_ identifier: String, model: AppModel) async {
        guard let target = PlannedNotification.habitTarget(of: identifier) else { return }
        switch await model.checkInFromOutside(habit: target.habit, slot: target.slot, day: target.day, source: .notification) {
        case .checkedIn, .alreadyDone, .notPaired, .noSuchSlot:
            break // rescheduling, which the check-in sets off, clears what is left for this slot
        case .tooLate:
            await centre.say(id: "habit-info", title: "Too late to log that one", body: "Yesterday can be logged until the end of today, and no further back. Today’s is still open in Todos.")
        case .notFound:
            await centre.cancel([identifier])
        }
    }

    /// "Snooze 15 min": the same reminder again in a quarter of an hour.
    func snooze(_ identifier: String, title: String, body: String) async {
        guard let target = PlannedNotification.habitTarget(of: identifier) else { return }
        await centre.snooze(id: PlannedNotification.snoozeIdentifier(habit: target.habit, slot: target.slot, day: target.day), habit: target.habit,
                            title: title, body: body, after: HabitNotification.snoozeSeconds)
    }
}

/// The real notification centre.
struct SystemNotificationCentre: NotificationCentre {
    private var center: UNUserNotificationCenter { .current() }

    func permission() async -> NotificationPermission {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .allowed
        case .notDetermined: .notAsked
        default: .refused
        }
    }

    func askPermission() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func waiting() async -> [WaitingNotification] {
        await center.pendingNotificationRequests()
            .filter { $0.identifier.hasPrefix("reminder-") || $0.identifier.hasPrefix("habit-") || $0.identifier.hasPrefix("snooze-") }
            .map { WaitingNotification(id: $0.identifier, title: $0.content.title, body: $0.content.body, stamp: $0.content.userInfo["stamp"] as? String ?? "") }
    }

    func delivered() async -> [String] {
        await center.deliveredNotifications().map(\.request.identifier)
    }

    func schedule(_ notification: PlannedNotification) async {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        var info: [String: Any] = ["stamp": notification.stamp]
        switch notification.subject {
        case .task(let id):
            info["task"] = id
            info["fire"] = notification.fireDate.timeIntervalSince1970
        case .habit(let id, _, _, _):
            info["habit"] = id
            content.categoryIdentifier = HabitNotification.category
            content.threadIdentifier = "habit-\(id)"
        case .endOfSchedule:
            break
        }
        content.userInfo = info
        // A habit's reminder is a reading on the wall clock, with no time zone, so it fires at
        // that time wherever the phone is. A task's is the instant its reminder was set for.
        let when = notification.wallClock ?? Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: notification.fireDate)
        try? await center.add(UNNotificationRequest(identifier: notification.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
    }

    func snooze(id: String, habit: Int, title: String, body: String, after seconds: TimeInterval) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = HabitNotification.category
        content.threadIdentifier = "habit-\(habit)"
        content.userInfo = ["habit": habit]
        try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)))
    }

    func say(id: String, title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    func cancel(_ ids: [String]) async {
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

/// Shows reminders while the app is open, opens the task or habit when one is tapped,
/// and answers the buttons on a habit's reminder.
final class Notifications: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = Notifications()

    func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Neither button brings the app to the front: both are dealt with in the background.
        center.setNotificationCategories([UNNotificationCategory(identifier: HabitNotification.category, actions: [
            UNNotificationAction(identifier: HabitNotification.done, title: "Done", options: []),
            UNNotificationAction(identifier: HabitNotification.snooze, title: "Snooze 15 min", options: []),
        ], intentIdentifiers: [])])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let request = response.notification.request
        let (identifier, title, body, action) = (request.identifier, request.content.title, request.content.body, response.actionIdentifier)
        let task = request.content.userInfo["task"] as? Int
        let habit = request.content.userInfo["habit"] as? Int
        if let task {
            await MainActor.run { AppModel.shared.requestedTask = task }
        }
        guard let habit else { return }
        switch action {
        case HabitNotification.done:
            await Reminders.shared.done(identifier, model: .shared)
        case HabitNotification.snooze:
            await Reminders.shared.snooze(identifier, title: title, body: body)
        default:
            await MainActor.run { AppModel.shared.requestedHabit = habit }
        }
    }
}
