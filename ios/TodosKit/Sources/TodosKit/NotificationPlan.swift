// Which local notifications this iPhone should have waiting: reminders for tasks,
// and for habits a reminder at each slot's time and a nudge if it still isn't done.
//
// iOS keeps at most 64 for an app and silently forgets the rest, so they can't
// all be scheduled forever ahead. Instead the nearest ones are, and the schedule
// is laid out again every time the app runs: when it is opened, when iOS wakes
// it to refresh, after every check-in, and after every tap on a notification.
// What makes that safe to rely on:
//
//   - Soonest first. What is left out is always the furthest away, and it is
//     scheduled as the nearer ones fire and the app runs again.
//   - Never silent. The first reminder that did not fit is replaced by a notice
//     at its time, saying that reminders stop there until Todos is opened.
//   - Task reminders are not crowded out: they have first call on a share of
//     the places, and either side may use what the other leaves.
//   - If the places can't even cover today and tomorrow, nudges go before
//     reminders do, and the plan says so for the app to show.
//
// Working out the plan needs nothing but the tasks and habits on hand, so it is
// here, where it can be tested. Scheduling needs the notification centre, which
// is in the app.

import Foundation

public struct PlannedNotification: Sendable, Equatable, Identifiable {
    public enum Subject: Sendable, Equatable {
        case task(Int)
        /// A reminder for one slot of a habit (no slot, for a habit counted in weeks) on one habit day.
        case habit(id: Int, slot: String?, day: Day, isNudge: Bool)
        /// The notice that stands where the first reminder that didn't fit would have been.
        case endOfSchedule
    }

    /// Also the notification's identifier, so laying the plan out again replaces rather than repeats.
    public var id: String
    public var subject: Subject
    public var title: String
    public var body: String
    /// When it fires, as an instant, for putting them in order.
    public var fireDate: Date
    /// For a habit: the reading on the wall clock it fires at (year, month, day, hour,
    /// minute, and no time zone), so 07:30 is 07:30 wherever the phone is by then.
    public var wallClock: DateComponents?

    public static func identifier(habit: Int, slot: String?, day: Day, isNudge: Bool) -> String {
        "habit-\(habit)-\(slot ?? "visit")-\(day)\(isNudge ? "-nudge" : "")"
    }

    public static let noticeIdentifier = "habit-notice"
    /// A reminder put off for a quarter of an hour: one per slot per day.
    public static func snoozeIdentifier(habit: Int, slot: String?, day: Day) -> String {
        "snooze-\(habit)-\(slot ?? "visit")-\(day)"
    }

    /// What a habit's reminder, nudge or snooze is about, read back from its identifier.
    public struct HabitTarget: Sendable, Equatable {
        public var habit: Int
        public var slot: String?
        public var day: Day
        public var isSnooze: Bool
    }

    /// Nil for anything that is not one of a habit's: a task's reminder, the notice.
    public static func habitTarget(of identifier: String) -> HabitTarget? {
        let isSnooze = identifier.hasPrefix("snooze-")
        guard isSnooze || identifier.hasPrefix("habit-"), identifier != noticeIdentifier else { return nil }
        var rest = identifier.dropFirst(isSnooze ? 7 : 6)
        if rest.hasSuffix("-nudge") { rest = rest.dropLast(6) }
        // <habit>-<slot, which may contain hyphens>-<YYYY-MM-DD>
        guard rest.count > 12, let day = Day(String(rest.suffix(10))), let dash = rest.firstIndex(of: "-"), let habit = Int(rest[..<dash]) else { return nil }
        let slot = String(rest[rest.index(after: dash)...].dropLast(11))
        return HabitTarget(habit: habit, slot: slot == "visit" ? nil : slot, day: day, isSnooze: isSnooze)
    }
}

extension Habit {
    /// Whether something can still be checked in for that slot on that day: it is today or
    /// yesterday, and not done. What a reminder for it should stay or go by.
    public func isOpen(slot: String?, on day: Day) -> Bool {
        guard !paused, !archived, let shown = [today, yesterday].first(where: { $0.day == day }) else { return false }
        if shown.isSession { return shown.state != .done }
        guard shown.state == .open else { return false }
        return slot.map { id in shown.slots.contains { $0.id == id && !$0.done } } ?? !shown.remaining.isEmpty
    }
}

public enum HabitReminderPlan {
    /// How far ahead reminders are worked out. The places usually run out long before.
    public static let horizonDays = 45

    /// Every reminder and nudge still to come over the next `days` days, soonest first.
    /// `habits` are as shown now (see `Habit.reckoned`), so what is already done today
    /// is left out, and so is a rest day, a paused habit, and a week already met.
    public static func plan(for habits: [Habit], now: Date = Date(), zone: TimeZone = .current, days: Int = horizonDays, nudges: Bool = true) -> [PlannedNotification] {
        let calendar = Calendar.gregorian(in: zone)
        var planned: [PlannedNotification] = []

        for habit in habits where !habit.paused && !habit.archived {
            let today = habit.today.day
            // A time before the habit's day start belongs to the day before: 01:00 on the 13th is the 12th's.
            func moment(_ time: ClockTime, on day: Day) -> (date: Date, wall: DateComponents)? {
                let date = time < habit.dayStart ? day.adding(days: 1) : day
                let wall = DateComponents(year: date.year, month: date.month, day: date.day, hour: time.hour, minute: time.minute)
                guard let instant = calendar.date(from: wall), instant > now else { return nil }
                return (instant, wall)
            }
            func add(_ slot: String?, _ day: Day, _ time: ClockTime, nudge: Bool, _ body: String) {
                guard let when = moment(time, on: day) else { return }
                planned.append(PlannedNotification(
                    id: PlannedNotification.identifier(habit: habit.id, slot: slot, day: day, isNudge: nudge),
                    subject: .habit(id: habit.id, slot: slot, day: day, isNudge: nudge),
                    title: [habit.icon, habit.name].compactMap { $0 }.joined(separator: " "), body: body, fireDate: when.date, wallClock: when.wall
                ))
            }

            for offset in 0..<days {
                let day = today.adding(days: offset)
                // The streak is only known for today; further ahead it is spoken of without a number.
                let streak = offset == 0 ? habit.streak.current : 0
                let running = habit.streak.current > 0

                if case .weekly(_, let remind) = habit.schedule {
                    guard let remind, remind.days.contains(Weekday(day)) else { continue }
                    let thisWeek = day.weekStart == today.weekStart ? habit.week : nil
                    if thisWeek?.state == .met || thisWeek?.state == .skipped { continue }
                    if offset == 0, habit.today.state == .done { continue }
                    let progress = thisWeek.map { "\($0.count) of \($0.target) this week" } ?? "Planned for today"
                    add(nil, day, remind.time, nudge: false, streak > 0 ? "\(progress) · \(HabitText.length(streak, .weeks)) so far" : progress)
                    continue
                }

                guard habit.schedule.includes(Weekday(day)) else { continue }
                if offset == 0, habit.today.state == .skipped || habit.today.state == .off { continue }
                for slot in habit.schedule.slots {
                    if offset == 0, habit.today.slots.first(where: { $0.id == slot.id })?.done != false { continue } // done, or not one of today's
                    let named = !slot.name.isEmpty
                    if let remind = slot.remind {
                        let keeps = streak > 0 ? "Keeps your \(HabitText.lengthAdjective(streak, .days)) streak going." : running ? "Keeps your streak going." : nil
                        add(slot.id, day, remind, nudge: false, [named ? slot.name : nil, keeps].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "Time to check in.")
                    }
                    if nudges, let nudge = slot.nudge {
                        let open = named ? "\(slot.name) is still open" : "Still open today"
                        add(slot.id, day, nudge, nudge: true, streak > 0 ? "\(open), and so is your \(HabitText.lengthAdjective(streak, .days)) streak." : "\(open).")
                    }
                }
            }
        }
        return planned.sorted { ($0.fireDate, $0.id) < ($1.fireDate, $1.id) }
    }
}

public struct NotificationPlan: Sendable, Equatable {
    /// Everything that should be waiting, soonest first.
    public var notifications: [PlannedNotification] = []
    /// The last habit day whose reminders are all scheduled. Nil when there are none to schedule.
    public var habitsCoveredThrough: Day?
    /// True when nudges were left out to make room for reminders.
    public var withoutNudges = false
    /// True when even today's and tomorrow's reminders did not all fit.
    public var isShort = false

    /// What iOS will keep for one app.
    public static let systemLimit = 64
    /// Places task reminders can count on however many habits there are.
    public static let taskShare = 24
    /// Places kept free for reminders the user puts off for a quarter of an hour.
    public static let snoozeReserve = 3

    public var tasks: [PlannedNotification] { notifications.filter { if case .task = $0.subject { true } else { false } } }
    public var habits: [PlannedNotification] { notifications.filter { if case .habit = $0.subject { true } else { false } } }
    public var notice: PlannedNotification? { notifications.first { $0.subject == .endOfSchedule } }

    /// Lays the plan out. `snoozed` is how many put-off reminders are already waiting,
    /// which take places of their own.
    public static func make(tasks: [TodoTask], habits: [Habit], taskReminders: Bool = true, habitReminders: Bool = true,
                            snoozed: Int = 0, now: Date = Date(), zone: TimeZone = .current) -> NotificationPlan {
        let calendar = Calendar.gregorian(in: zone)
        let taskPlan = taskReminders ? ReminderPlan.plan(for: tasks, now: now, calendar: calendar) : []
        let taskItems = taskPlan.map {
            PlannedNotification(id: $0.id, subject: .task($0.taskID), title: $0.title, body: $0.body, fireDate: $0.fireDate, wallClock: nil)
        }
        // With no habit reminders, tasks have what they always had, less any places snoozes are holding.
        let tasksAlone = NotificationPlan(notifications: Array(taskItems.prefix(max(0, min(ReminderPlan.limit, systemLimit - snoozed)))))
        guard habitReminders else { return tasksAlone }

        func layOut(nudges: Bool) -> NotificationPlan {
            // Worked out a little past the horizon, so there is something to hang the notice on.
            let wanted = HabitReminderPlan.plan(for: habits, now: now, zone: zone, days: HabitReminderPlan.horizonDays + 15, nudges: nudges)
            guard !wanted.isEmpty else { return tasksAlone }
            let today = habits.map(\.today.day).min() ?? Day(now, calendar: calendar)
            let horizon = today.adding(days: HabitReminderPlan.horizonDays)
            let inHorizon = wanted.filter { day(of: $0) < horizon }.count

            // One place is the notice's; some are kept for snoozes; the rest are shared.
            let places = max(0, systemLimit - 1 - max(snoozeReserve, snoozed))
            let forTasks = min(taskItems.count, max(taskShare, places - inHorizon), places)
            let forHabits = min(inHorizon, places - forTasks)
            let taken = Array(wanted.prefix(forHabits))
            var plan = NotificationPlan(notifications: Array(taskItems.prefix(forTasks)) + taken)
            plan.withoutNudges = !nudges

            // The first reminder that didn't fit becomes the notice. Days before its day are covered in full.
            if forHabits < wanted.count {
                let first = wanted[forHabits]
                let firstDay = day(of: first)
                plan.habitsCoveredThrough = taken.isEmpty ? nil : firstDay.adding(days: -1)
                plan.isShort = firstDay <= today.adding(days: 1)
                plan.notifications.append(PlannedNotification(
                    id: PlannedNotification.noticeIdentifier, subject: .endOfSchedule,
                    title: "Open Todos to keep reminders coming",
                    body: "\(first.title) is due. This is as far ahead as Todos could schedule reminders; opening it schedules the next ones.",
                    fireDate: first.fireDate, wallClock: first.wallClock
                ))
            } else {
                plan.habitsCoveredThrough = taken.last.map(day(of:))
            }
            plan.notifications.sort { ($0.fireDate, $0.id) < ($1.fireDate, $1.id) }
            return plan
        }

        let full = layOut(nudges: true)
        // Not even tomorrow fits: nudges go before reminders do.
        return full.isShort ? layOut(nudges: false) : full
    }

    private static func day(of notification: PlannedNotification) -> Day {
        if case .habit(_, _, let day, _) = notification.subject { return day }
        return Day(notification.fireDate, calendar: .utc)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
