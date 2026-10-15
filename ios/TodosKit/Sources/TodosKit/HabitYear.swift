// A year of habits, a dot a day: the days every habit was done, the days some
// were, and the days none were. The Mac keeps the record and says how each day of
// each habit went; the phone adds today and yesterday from what it knows now,
// waiting check-ins included, so the year shows a check-in the moment it is made.

import Foundation

/// How each habit went on each day of a year so far, as the Mac said: what the year
/// widget is drawn from. Fetched once a day (see `SyncEngine.refreshCalendar`).
public struct HabitCalendar: Codable, Sendable, Equatable {
    public struct Marks: Codable, Sendable, Equatable {
        public var habit: Int
        /// One character per day from January 1 (see `HabitHistory.days`).
        public var days: String

        public init(habit: Int, days: String) {
            self.habit = habit
            self.days = days
        }
    }

    public var year: Int
    /// The habit day it was fetched on. Days after it are not in it.
    public var asOf: Day
    public var habits: [Marks]

    public init(year: Int, asOf: Day, habits: [Marks]) {
        self.year = year
        self.asOf = asOf
        self.habits = habits
    }

    /// January 1.
    var start: Day { Day(year: year, month: 1, day: 1)! }

    /// What the Mac said about one habit on one day, or nil if it said nothing.
    func mark(habit: Int, on day: Day) -> Character? {
        guard day <= asOf, let marks = habits.first(where: { $0.habit == habit })?.days else { return nil }
        let offset = day.days(since: start, calendar: .utc)
        guard offset >= 0, offset < marks.count else { return nil }
        return marks[marks.index(marks.startIndex, offsetBy: offset)]
    }
}

/// A year as the widget draws it: one mark for each day, January 1 first.
public struct HabitYear: Sendable, Equatable {
    public enum Mark: Sendable, Equatable {
        /// Every habit that asked for something that day was done.
        case complete
        /// Some of it was done, and it is too late for the rest.
        case partial
        /// Habits asked for something, and none of it was done.
        case missed
        /// Not finished, and still loggable: today, or yesterday until today ends.
        case open
        /// No habit asked for anything: before they began, a rest day, or no record.
        case none
        case future
    }

    public var year: Int
    public var marks: [Mark]
    /// Which mark is today.
    public var today: Int

    public init(year: Int, marks: [Mark], today: Int) {
        self.year = year
        self.marks = marks
        self.today = today
    }

    /// The day that is today.
    public var todayDay: Day { Day(year: year, month: 1, day: 1)!.adding(days: today) }

    /// Days with everything done, in a row up to today; today counts once it is done.
    /// A day that asked nothing, or one still open, neither breaks it nor adds to it.
    /// It counts back no further than January 1.
    public var streak: Int {
        var count = 0
        for index in stride(from: min(today, marks.count - 1), through: 0, by: -1) {
            switch marks[index] {
            case .complete: count += 1
            case .none, .open, .future: continue
            case .partial, .missed: return count
            }
        }
        return count
    }

    /// The last `weeks` weeks as a small calendar: a column for each week, Monday at
    /// the top, the current week last. Days outside this year are nil.
    public func recent(weeks: Int) -> [[Mark?]] {
        let january = Day(year: year, month: 1, day: 1)!
        let first = todayDay.weekStart.adding(days: -7 * (weeks - 1))
        return (0..<weeks).map { week in
            (0..<7).map { weekday in
                let index = first.adding(days: week * 7 + weekday).days(since: january, calendar: .utc)
                return marks.indices.contains(index) ? marks[index] : nil
            }
        }
    }

    /// Days on which everything was done.
    public var completed: Int { marks.filter { $0 == .complete }.count }
    /// Days that asked for something and are settled: what `completed` is out of.
    /// Today counts once it is complete; a day still open does not count yet.
    public var counted: Int { marks.filter { $0 == .complete || $0 == .partial || $0 == .missed }.count }

    /// Puts the year together for `today`: the Mac's record for the days it has
    /// said something about, and for today and yesterday the habits as they stand
    /// on this iPhone now.
    public init(calendar: HabitCalendar?, habits: [Habit], today: Day) {
        let start = Day(year: today.year, month: 1, day: 1)!
        let length = Day(year: today.year + 1, month: 1, day: 1)!.days(since: start, calendar: .utc)
        let shown = habits.filter { !$0.archived }
        let record = calendar?.year == today.year ? calendar : nil
        year = today.year
        self.today = today.days(since: start, calendar: .utc)
        marks = (0..<length).map { offset in
            let day = start.adding(days: offset)
            return day > today ? .future : Self.mark(on: day, habits: shown, record: record)
        }
    }

    /// How one habit went on one day, as far as the day as a whole is concerned.
    private enum Went {
        case done, partial, missed, open, openPartial, nothing
    }

    private static func went(_ habit: Habit, on day: Day, record: HabitCalendar?) -> Went {
        if let shown = [habit.today, habit.yesterday].first(where: { $0.day == day }) {
            switch shown.state {
            case .done: return .done
            case .partial: return .partial
            case .missed: return .missed
            case .open: return shown.done > 0 ? .openPartial : .open
            case .off, .skipped: return .nothing
            }
        }
        switch record?.mark(habit: habit.id, on: day) {
        case "d": return .done
        case "p": return .partial
        case "x": return .missed
        case "o": return .open
        default: return .nothing // s, ., _, or no record
        }
    }

    /// A day is complete when every habit done at set times that asked for something
    /// that day was done. A habit counted in weeks asks nothing of any one day: a visit
    /// counts on a day nothing else asked for, and otherwise neither helps nor hurts.
    private static func mark(on day: Day, habits: [Habit], record: HabitCalendar?) -> Mark {
        var asked = 0, done = 0, progress = false, open = false, visited = false
        for habit in habits {
            let went = went(habit, on: day, record: record)
            if habit.isWeekly {
                if went == .done { visited = true }
                continue
            }
            switch went {
            case .done: asked += 1; done += 1
            case .partial: asked += 1; progress = true
            case .missed: asked += 1
            case .open: asked += 1; open = true
            case .openPartial: asked += 1; open = true; progress = true
            case .nothing: break
            }
        }
        if asked == 0 { return visited ? .complete : .none }
        if done == asked { return .complete }
        if open { return .open }
        return done > 0 || progress ? .partial : .missed
    }
}
