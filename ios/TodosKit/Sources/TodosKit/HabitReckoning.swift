// What this iPhone shows for a habit between one answer from the Mac and the next.
//
// The Mac works streaks out, and what it last said is kept here. But this iPhone
// may hold check-ins the Mac hasn't heard of yet, and days may have gone by since
// the Mac was last reached. So what is shown is the Mac's last word brought up to
// date: this iPhone's waiting changes applied, and the days since walked forward
// by the same rules as src/streaks.js. Whatever the Mac says next replaces it.
//
// It agrees with the Mac as long as nothing else touched the habit meanwhile,
// which is all that can be known offline. An integration test holds the two to
// the same answers against the real server, over stretches of several days.

import Foundation

public enum HabitClock {
    /// The habit day an instant belongs to: the calendar date where the user is,
    /// or the one before if it is not yet the habit's day start.
    public static func day(of date: Date, zone: TimeZone, dayStart: ClockTime) -> Day {
        let day = Day(date, calendar: .gregorian(in: zone))
        return ClockTime(date, zone: zone) < dayStart ? day.adding(days: -1) : day
    }

    /// When a habit day ends: its day start on the next calendar date.
    public static func end(of day: Day, zone: TimeZone, dayStart: ClockTime) -> Date? {
        let next = day.adding(days: 1)
        return Calendar.gregorian(in: zone).date(from: DateComponents(year: next.year, month: next.month, day: next.day, hour: dayStart.hour, minute: dayStart.minute))
    }
}

extension Habit {
    /// The habit as it should be shown at `now`: the Mac's last word, with this
    /// iPhone's waiting changes on top and the days since walked forward.
    public func reckoned(with changes: [PendingChange] = [], now: Date = Date(), zone: TimeZone = .current) -> Habit {
        let mine = changes.filter { $0.isWaiting && $0.habitID == id }
        // Never earlier than the day the Mac spoke of: a clock set back can't unwind it.
        let day = max(today.day, HabitClock.day(of: now, zone: zone, dayStart: dayStart))
        var shown = isWeekly ? reckonedWeeks(mine, today: day) : reckonedDays(mine, today: day)
        if let risk = shown.streak.atRisk, risk.until == nil {
            shown.streak.atRisk?.until = HabitClock.end(of: day, zone: zone, dayStart: dayStart)
        }
        return shown
    }

    /// The slot a check-in that names none goes to: the one still to do today. If
    /// several are, the one whose window this is, else the earliest. Nil when
    /// nothing is left, and for a habit with no slots.
    public func slotToCheckIn(at date: Date = Date(), zone: TimeZone = .current) -> String? {
        let open = today.remaining
        guard open.count > 1 else { return open.first?.id }
        let time = ClockTime(date, zone: zone)
        return open.first { candidate in
            guard let slot = slot(candidate.id), let from = slot.from, let until = slot.until else { return false }
            return time.isWithin(from, until)
        }?.id ?? open.first?.id
    }

    /// Whether anything is expected on a day the Mac has not spoken of yet.
    private func expects(_ day: Day) -> Bool {
        !paused && !archived && schedule.includes(Weekday(day))
    }

    // MARK: Habits with slots

    private struct DayBox {
        var scheduled: Bool
        var skipped: Bool
        var slots: [HabitDay.Slot]
        /// Check-ins made here that the Mac hasn't confirmed, by slot: the ids of those changes.
        var local: [String: Set<UUID>] = [:]

        init(_ day: HabitDay) {
            scheduled = day.state != .off
            skipped = day.state == .skipped
            slots = day.slots
        }

        init(fresh slots: [HabitSlot]?) {
            scheduled = slots != nil
            skipped = false
            self.slots = (slots ?? []).map { HabitDay.Slot(id: $0.id) }
        }

        func state(on day: Day, today: Day) -> HabitDay.State {
            guard scheduled else { return .off }
            if slots.allSatisfy(\.done) { return .done }
            if skipped { return .skipped }
            if day >= today.adding(days: -1) { return .open }
            return slots.contains(where: \.done) ? .partial : .missed
        }
    }

    private func reckonedDays(_ mine: [PendingChange], today: Day) -> Habit {
        // What is known: yesterday and today as the Mac last saw them, and every day since.
        var days: [Day: DayBox] = [self.yesterday.day: DayBox(self.yesterday), self.today.day: DayBox(self.today)]
        var next = self.today.day.adding(days: 1)
        while next <= today {
            days[next] = DayBox(fresh: expects(next) ? schedule.slots : nil)
            next = next.adding(days: 1)
        }

        var skips = skipsLeft
        for change in mine {
            switch change.kind {
            case .checkIn(_, _, let slot, let day, let at, _, let source, _):
                guard var box = days[day], let id = slot ?? box.slots.first(where: { !$0.done })?.id,
                      let index = box.slots.firstIndex(where: { $0.id == id }) else { continue }
                box.local[id, default: []].insert(change.id)
                if !box.slots[index].done {
                    box.slots[index] = HabitDay.Slot(id: id, done: true, at: at, by: "me", via: HubClient.defaultClientName, source: source.rawValue)
                }
                days[day] = box
            case .undoCheckIn(_, _, let slot, let day, let checkins, let keys, _):
                guard var box = days[day] else { continue }
                for index in box.slots.indices where slot == nil || box.slots[index].id == slot {
                    let id = box.slots[index].id
                    box.slots[index].checkins.removeAll(where: checkins.contains)
                    box.local[id]?.subtract(keys)
                    if box.slots[index].checkins.isEmpty, box.local[id, default: []].isEmpty { box.slots[index] = HabitDay.Slot(id: id) }
                }
                days[day] = box
            case .skipHabit(_, _, let day, _, _, _):
                if days[day]?.skipped == false { skips -= 1 }
                days[day]?.skipped = true
            case .undoSkip(_, _, let day, _, _):
                if days[day]?.skipped == true { skips += 1 }
                days[day]?.skipped = false
            default:
                break
            }
        }

        // The run as it stood before yesterday and today, which the Mac counted in or passed over.
        var run = max(0, streak.current - (self.yesterday.state == .done ? 1 : 0) - (self.today.state == .done ? 1 : 0))
        var best = streak.best
        var previous = streak.previous
        var lastDone: Day?
        var runBeforeYesterday = 0
        let yesterday = today.adding(days: -1)
        for day in days.keys.sorted() {
            if day == yesterday { runBeforeYesterday = run }
            switch days[day]!.state(on: day, today: today) {
            case .done:
                run += 1
                lastDone = day
                best = max(best, run)
            case .partial, .missed:
                if run > 0 { previous = HabitStreak.Previous(length: run, lastDay: lastDone) }
                run = 0
            case .off, .skipped, .open:
                break
            }
        }

        func shown(_ day: Day) -> HabitDay {
            guard let box = days[day] else { return HabitDay(day: day, state: .off) }
            return HabitDay(day: day, state: box.state(on: day, today: today), slots: box.slots)
        }
        var habit = self
        habit.today = shown(today)
        habit.yesterday = shown(yesterday)
        let risk = habit.yesterday.state == .open && runBeforeYesterday > 0
        habit.streak = HabitStreak(current: run, best: best, unit: .days,
                                   atRisk: risk ? HabitStreak.AtRisk(day: yesterday, missing: habit.yesterday.remaining.map(\.id)) : nil, previous: previous)
        habit.skipsLeft = max(0, skips)
        return habit
    }

    // MARK: Habits counted in weeks

    private struct WeekBox {
        var target: Int
        var days: Set<Day>
        var skipped: Bool
        /// False for a week the habit began or was paused in.
        var whole: Bool
        /// Nothing is expected at all: paused throughout.
        var inactive: Bool

        func state(of week: Day, today: Day) -> HabitWeek.State {
            if inactive { return .off }
            if days.count >= target { return .met }
            if skipped { return .skipped }
            if today <= week.adding(days: 7) { return .open }
            return whole ? .missed : .off
        }
    }

    private func reckonedWeeks(_ mine: [PendingChange], today: Day) -> Habit {
        guard case .weekly(let target, _) = schedule, let week else { return self }
        func box(_ known: HabitWeek) -> WeekBox {
            WeekBox(target: known.target, days: Set(known.days), skipped: known.state == .skipped, whole: known.whole ?? true,
                    inactive: known.state == .off && (paused || archived))
        }
        var weeks: [Day: WeekBox] = [week.start: box(week)]
        if let lastWeek { weeks[lastWeek.start] = box(lastWeek) }
        var next = week.start.adding(days: 7)
        while next <= today.weekStart {
            weeks[next] = WeekBox(target: target, days: [], skipped: false, whole: true, inactive: paused || archived)
            next = next.adding(days: 7)
        }

        // Which check-ins each day has: the Mac's for the two days it listed, and this iPhone's own.
        var onMac: [Day: [Int]] = [self.yesterday.day: self.yesterday.checkins, self.today.day: self.today.checkins]
        var local: [Day: Set<UUID>] = [:]
        var skips = skipsLeft
        for change in mine {
            switch change.kind {
            case .checkIn(_, _, _, let day, _, _, _, _):
                local[day, default: []].insert(change.id)
                weeks[day.weekStart]?.days.insert(day)
            case .undoCheckIn(_, _, _, let day, let checkins, let keys, _):
                onMac[day]?.removeAll(where: checkins.contains)
                local[day]?.subtract(keys)
                // A day the Mac never listed check-ins for keeps whatever it had.
                if onMac[day]?.isEmpty == true, local[day, default: []].isEmpty { weeks[day.weekStart]?.days.remove(day) }
            case .skipHabit(_, _, let day, _, _, _):
                if weeks[day.weekStart]?.skipped == false { skips -= 1 }
                weeks[day.weekStart]?.skipped = true
            case .undoSkip(_, _, let day, _, _):
                if weeks[day.weekStart]?.skipped == true { skips += 1 }
                weeks[day.weekStart]?.skipped = false
            default:
                break
            }
        }

        var run = max(0, streak.current - (lastWeek?.state == .met ? 1 : 0) - (week.state == .met ? 1 : 0))
        var best = streak.best
        var previous = streak.previous
        var lastMet: Day?
        var runBeforeLastWeek = 0
        let thisWeek = today.weekStart
        let lastWeekStart = thisWeek.adding(days: -7)
        for start in weeks.keys.sorted() {
            if start == lastWeekStart { runBeforeLastWeek = run }
            switch weeks[start]!.state(of: start, today: today) {
            case .met:
                run += 1
                lastMet = start
                best = max(best, run)
            case .missed:
                if run > 0 { previous = HabitStreak.Previous(length: run, lastWeek: lastMet) }
                run = 0
            case .off, .skipped, .open:
                break
            }
        }

        func shown(_ start: Day) -> HabitWeek? {
            guard let box = weeks[start] else { return nil }
            return HabitWeek(start: start, state: box.state(of: start, today: today), count: box.days.count, target: box.target, days: box.days.sorted(), whole: box.whole)
        }
        func session(_ day: Day) -> HabitDay {
            HabitDay(day: day, state: weeks[day.weekStart]?.days.contains(day) == true ? .done : .open, checkins: onMac[day] ?? [], isSession: true)
        }
        var habit = self
        habit.today = session(today)
        habit.yesterday = session(today.adding(days: -1))
        habit.week = shown(thisWeek)
        habit.lastWeek = shown(lastWeekStart)
        // Last week is one day short and its Sunday has no check-in yet: logging it today saves the streak.
        let sunday = lastWeekStart.adding(days: 6)
        var risk: HabitStreak.AtRisk?
        if let last = weeks[lastWeekStart], last.state(of: lastWeekStart, today: today) == .open, runBeforeLastWeek > 0,
           last.days.count == last.target - 1, !last.days.contains(sunday) {
            risk = HabitStreak.AtRisk(day: sunday, week: lastWeekStart)
        }
        habit.streak = HabitStreak(current: run, best: best, unit: .weeks, atRisk: risk, previous: previous)
        habit.skipsLeft = max(0, skips)
        return habit
    }
}

extension [Habit] {
    /// The habits as they should be shown at `now`. See `Habit.reckoned`.
    public func reckoned(with changes: [PendingChange] = [], now: Date = Date(), zone: TimeZone = .current) -> [Habit] {
        map { $0.reckoned(with: changes, now: now, zone: zone) }
    }
}
