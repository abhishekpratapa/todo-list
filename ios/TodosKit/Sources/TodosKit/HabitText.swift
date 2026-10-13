// How habits read on screen: the order of the Today list, and the words for
// progress, schedules and streaks. Kept here, away from the views, so that the
// app, the widgets and the notifications all say the same thing.

import Foundation

extension ClockTime {
    /// "7:30 AM", or "07:30" where that is how times are written.
    public func formatted(locale: Locale = .current) -> String {
        let date = Calendar.utc.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute)) ?? Date(timeIntervalSince1970: 0)
        return date.formatted(Date.FormatStyle(locale: locale, calendar: .utc, timeZone: Calendar.utc.timeZone).hour().minute())
    }

    /// Minutes from `start` to this time, going forward round the clock.
    func minutes(after start: ClockTime) -> Int {
        (minutes - start.minutes + 24 * 60) % (24 * 60)
    }
}

extension Day {
    /// "Sunday".
    public func weekdayName(locale: Locale = .current) -> String {
        date(calendar: .utc).formatted(Date.FormatStyle(locale: locale, calendar: .utc, timeZone: Calendar.utc.timeZone).weekday(.wide))
    }
}

extension Habit {
    /// True when something is still to do today: an open day, or for a habit counted
    /// in weeks, a week not yet met on a day without a check-in.
    public var isDueToday: Bool {
        guard !paused, !archived else { return false }
        if isWeekly { return today.state != .done && week?.state == .open }
        return today.state == .open
    }

    /// True when today asks nothing more: done, or for a habit counted in weeks,
    /// checked in today or the week already met.
    public var isDoneToday: Bool {
        guard !paused, !archived else { return false }
        if isWeekly { return today.state == .done || week?.state == .met }
        return today.state == .done
    }

    /// When the next thing still to do today is due, in minutes after the habit's day
    /// start: the next open slot's reminder time, else the start of its window. Nil
    /// when nothing has a time, or nothing is left.
    public var nextDue: Int? {
        if case .weekly(_, let remind) = schedule {
            guard let remind, remind.days.contains(Weekday(today.day)) else { return nil }
            return remind.time.minutes(after: dayStart)
        }
        return today.remaining.compactMap { open in slot(open.id).flatMap { $0.remind ?? $0.from } }.map { $0.minutes(after: dayStart) }.min()
    }
}

extension [Habit] {
    /// The Today list: what is still to do, soonest first (anything without a time
    /// last); then what is done; then what expects nothing today.
    public func forToday() -> (due: [Habit], done: [Habit], off: [Habit]) {
        let shown = filter { !$0.archived }
        let due = shown.filter(\.isDueToday).sorted { ($0.nextDue ?? .max, $0.id) < ($1.nextDue ?? .max, $1.id) }
        let done = shown.filter { !$0.isDueToday && $0.isDoneToday }
        let off = shown.filter { !$0.isDueToday && !$0.isDoneToday }
        return (due, done, off)
    }

    /// Slots (or, in weeks, visits) still to do today, across every habit.
    public var leftToday: Int {
        filter(\.isDueToday).reduce(0) { $0 + ($1.isWeekly ? 1 : $1.today.remaining.count) }
    }
}

public enum HabitText {
    /// "12 days", "1 week".
    public static func length(_ count: Int, _ unit: HabitStreak.Unit) -> String {
        "\(count) \(unit == .days ? "day" : "week")\(count == 1 ? "" : "s")"
    }

    /// "12-day", "3-week": for "your 12-day streak".
    static func lengthAdjective(_ count: Int, _ unit: HabitStreak.Unit) -> String {
        "\(count)-\(unit == .days ? "day" : "week")"
    }

    /// The line under a habit's name: how today stands.
    public static func progress(_ habit: Habit, locale: Locale = .current) -> String {
        if habit.paused { return "Paused" }
        if let week = habit.week {
            switch week.state {
            case .met: return "\(week.count) of \(week.target) this week · done"
            case .skipped: return "Rest week"
            case .off: return "\(week.count) this week"
            case .open, .missed: return "\(week.count) of \(week.target) this week"
            }
        }
        switch habit.today.state {
        case .off: return "Not today"
        case .skipped: return "Rest day"
        case .done: return habit.today.total > 1 ? "\(habit.today.total) of \(habit.today.total) · done" : "Done today"
        case .open, .partial, .missed:
            // What is next: the first slot still to do, and when it is due.
            let next = habit.today.remaining.first.flatMap { open in habit.slot(open.id) }
            let when = next.flatMap { slot in [slot.name.nonEmpty, slot.remind?.formatted(locale: locale)].compactMap { $0 }.joined(separator: " ").nonEmpty }
            let count = habit.today.total > 1 ? "\(habit.today.done) of \(habit.today.total)" : nil
            return [count, when].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "To do today"
        }
    }

    /// When a habit is done, in a line: "Every day · Morning 7:30 AM, Evening 9:30 PM".
    public static func schedule(_ schedule: HabitSchedule, locale: Locale = .current) -> String {
        func times(_ slots: [HabitSlot]) -> String? {
            let parts = slots.compactMap { slot -> String? in
                let time = slot.remind?.formatted(locale: locale)
                return [slot.name.nonEmpty, time].compactMap { $0 }.joined(separator: " ").nonEmpty
            }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }
        switch schedule {
        case .daily(let slots):
            return ["Every day", times(slots)].compactMap { $0 }.joined(separator: " · ")
        case .days(let days, let slots):
            return [days.map(\.label).joined(separator: ", "), times(slots)].compactMap { $0 }.joined(separator: " · ")
        case .weekly(let target, let remind):
            let often = target == 7 ? "Every day of the week" : "\(target) day\(target == 1 ? "" : "s") a week"
            let reminded = remind.map { "reminders \($0.days.map(\.label).joined(separator: ", ")) at \($0.time.formatted(locale: locale))" }
            return [often, reminded].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// Yesterday is unfinished and a streak hangs on it: what to do about it.
    public static func atRisk(_ habit: Habit) -> String? {
        guard let risk = habit.streak.atRisk, habit.streak.current > 0 else { return nil }
        let streak = "your \(lengthAdjective(habit.streak.current, habit.streak.unit)) streak"
        if habit.isWeekly { return "Log yesterday’s visit by the end of today to keep \(streak)." }
        let slots = risk.missing.map { habit.slotName($0).lowercased() }
        let what = habit.yesterday.total > 1 && !slots.isEmpty ? "yesterday’s \(slots.formatted(.list(type: .and)))" : "yesterday"
        return "Log \(what) by the end of today to keep \(streak)."
    }

    /// A streak has ended: said kindly, with the best and a new start. Nil unless
    /// there is nothing running now and something worth mentioning behind it.
    public static func ended(_ habit: Habit, locale: Locale = .current) -> String? {
        guard habit.streak.current == 0, let previous = habit.streak.previous, previous.length > 1 else { return nil }
        let unit = habit.streak.unit
        var first = "Your \(lengthAdjective(previous.length, unit)) streak ended"
        if let last = previous.lastDay, unit == .days, habit.today.day.days(since: last, calendar: .utc) <= 7 {
            first += " after \(last.weekdayName(locale: locale))"
        }
        let best = previous.length >= habit.streak.best ? "That is your best so far." : "Your best is \(length(habit.streak.best, unit))."
        return "\(first). \(best) \(unit == .days ? "Today" : "This week") starts a new one."
    }

    /// "93%", or a dash when nothing was expected.
    public static func rate(_ value: Double?) -> String {
        value.map { "\(Int(($0 * 100).rounded()))%" } ?? "–"
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
