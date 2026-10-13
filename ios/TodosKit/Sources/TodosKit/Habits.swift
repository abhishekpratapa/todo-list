// Habits, as the Todos app on the Mac sends them (docs/openapi.json, API revision 5).
//
// A habit is a routine to check in on. It is done at set times of day (its slots)
// every day or on chosen weekdays, or a number of days a week. The Mac keeps the
// check-ins and works the streaks out; what arrives here is the habit, how today
// and yesterday stand, and the numbers.

import Foundation

/// A time of day, "07:30". Floating: it means 07:30 wherever the user is.
public struct ClockTime: Sendable, Hashable, Comparable, Codable, CustomStringConvertible {
    public let hour: Int
    public let minute: Int

    public init?(hour: Int, minute: Int) {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        self.hour = hour
        self.minute = minute
    }

    /// Parses "HH:MM" (or "H:MM"). Anything else is nil.
    public init?(_ text: String) {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, (1...2).contains(parts[0].count), parts[1].count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        self.init(hour: h, minute: m)
    }

    /// What a clock in `zone` says at `date`.
    public init(_ date: Date, zone: TimeZone) {
        let parts = Calendar.gregorian(in: zone).dateComponents([.hour, .minute], from: date)
        hour = parts.hour ?? 0
        minute = parts.minute ?? 0
    }

    /// When a habit's day begins unless it says otherwise: brushing after midnight is still last night.
    public static let defaultDayStart = ClockTime(hour: 3, minute: 0)!

    public var description: String { String(format: "%02d:%02d", hour, minute) }
    public var minutes: Int { hour * 60 + minute }

    public static func < (a: ClockTime, b: ClockTime) -> Bool { a.minutes < b.minutes }

    /// True when this time is in the window from `from` to `until`, which may run past midnight.
    public func isWithin(_ from: ClockTime, _ until: ClockTime) -> Bool {
        from <= until ? (self >= from && self < until) : (self >= from || self < until)
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let parsed = ClockTime(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected a time as HH:MM"))
        }
        self = parsed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}

public enum Weekday: String, Codable, Sendable, CaseIterable, Hashable {
    case mon, tue, wed, thu, fri, sat, sun

    public var label: String { rawValue.capitalized }

    /// The day of the week a date falls on.
    public init(_ day: Day) {
        // Calendar counts Sunday as 1.
        let number = Calendar.utc.component(.weekday, from: day.date(calendar: .utc))
        self = [.sun, .mon, .tue, .wed, .thu, .fri, .sat][number - 1]
    }
}

extension Calendar {
    /// For arithmetic on calendar days, which have no time zone.
    static let utc = Calendar.gregorian(in: TimeZone(identifier: "UTC")!)

    static func gregorian(in zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
}

extension Day {
    public func adding(days: Int) -> Day {
        Day(Calendar.utc.date(byAdding: .day, value: days, to: date(calendar: .utc)) ?? date(calendar: .utc), calendar: .utc)
    }

    /// The Monday of the week this day is in. Habit weeks run Monday to Sunday.
    public var weekStart: Day {
        adding(days: -((Weekday.allCases.firstIndex(of: Weekday(self)) ?? 0)))
    }
}

/// A time of day a habit is done at.
public struct HabitSlot: Codable, Sendable, Hashable, Identifiable {
    /// Stable and lower-case, e.g. "morning". The Mac makes one from the name if it is left empty.
    public var id: String
    public var name: String
    /// When to be reminded.
    public var remind: ClockTime?
    /// The window the slot belongs in. It may run past midnight.
    public var from: ClockTime?
    public var until: ClockTime?
    /// When to be reminded again if it still isn't done.
    public var nudge: ClockTime?

    public init(id: String = "", name: String, remind: ClockTime? = nil, from: ClockTime? = nil, until: ClockTime? = nil, nudge: ClockTime? = nil) {
        self.id = id
        self.name = name
        self.remind = remind
        self.from = from
        self.until = until
        self.nudge = nudge
    }

    private enum CodingKeys: String, CodingKey { case id, name, remind, from, until, nudge }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        remind = try c.decodeIfPresent(ClockTime.self, forKey: .remind)
        from = try c.decodeIfPresent(ClockTime.self, forKey: .from)
        until = try c.decodeIfPresent(ClockTime.self, forKey: .until)
        nudge = try c.decodeIfPresent(ClockTime.self, forKey: .nudge)
    }

    /// The Mac reads a missing id as "make one"; an empty one would be refused.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if !id.isEmpty { try c.encode(id, forKey: .id) }
        try c.encode(name, forKey: .name)
        try c.encode(remind, forKey: .remind)
        try c.encode(from, forKey: .from)
        try c.encode(until, forKey: .until)
        try c.encode(nudge, forKey: .nudge)
    }
}

/// When a habit is meant to be done.
public enum HabitSchedule: Sendable, Hashable, Codable {
    /// Every day. A day counts when every slot has a check-in.
    case daily(slots: [HabitSlot])
    /// On those days of the week.
    case days([Weekday], slots: [HabitSlot])
    /// That many days a week, whichever they are. It has no slots, and its streak is counted in weeks.
    case weekly(target: Int, remind: WeeklyReminder?)

    public struct WeeklyReminder: Codable, Sendable, Hashable {
        public var days: [Weekday]
        public var time: ClockTime

        public init(days: [Weekday], time: ClockTime) {
            self.days = days
            self.time = time
        }
    }

    public var slots: [HabitSlot] {
        switch self {
        case .daily(let slots), .days(_, let slots): slots
        case .weekly: []
        }
    }

    public var isWeekly: Bool {
        if case .weekly = self { return true }
        return false
    }

    /// Whether anything is expected on that day of the week. Always true for a habit counted in weeks.
    public func includes(_ weekday: Weekday) -> Bool {
        if case .days(let days, _) = self { return days.contains(weekday) }
        return true
    }

    private enum CodingKeys: String, CodingKey { case kind, slots, days, target, remind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "daily": self = .daily(slots: try c.decode([HabitSlot].self, forKey: .slots))
        case "days": self = .days(try c.decode([Weekday].self, forKey: .days), slots: try c.decode([HabitSlot].self, forKey: .slots))
        case "weekly": self = .weekly(target: try c.decode(Int.self, forKey: .target), remind: try c.decodeIfPresent(WeeklyReminder.self, forKey: .remind))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "A kind of schedule this app does not know")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .daily(let slots):
            try c.encode("daily", forKey: .kind)
            try c.encode(slots, forKey: .slots)
        case .days(let days, let slots):
            try c.encode("days", forKey: .kind)
            try c.encode(days, forKey: .days)
            try c.encode(slots, forKey: .slots)
        case .weekly(let target, let remind):
            try c.encode("weekly", forKey: .kind)
            try c.encode(target, forKey: .target)
            try c.encode(remind, forKey: .remind)
        }
    }
}

public enum HabitColor: String, Codable, Sendable, CaseIterable, Hashable {
    case red, orange, yellow, green, mint, teal, blue, indigo, purple, pink, gray

    /// A color added on the Mac later reads as the default rather than failing the whole list.
    public init(from decoder: Decoder) throws {
        self = HabitColor(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .indigo
    }
}

/// How a check-in was made.
public enum HabitSource: String, Codable, Sendable, Hashable {
    case manual, notification, widget, shortcut, claude, health
}

/// One day of a habit: how each slot stands, or for a habit counted in weeks,
/// whether there was a check-in that day.
public struct HabitDay: Sendable, Equatable, Codable {
    public enum State: String, Codable, Sendable {
        /// Not scheduled, paused, or before the habit began.
        case off
        /// Every slot has a check-in.
        case done
        /// A rest day.
        case skipped
        /// Not done, and still loggable: today, or yesterday until today ends.
        case open
        /// Some slots, and too late for the rest.
        case partial
        case missed
    }

    public struct Slot: Sendable, Equatable, Codable, Identifiable {
        public var id: String
        public var done: Bool
        /// When it was first checked in, by whom and how.
        public var at: Date?
        public var by: String?
        public var via: String?
        public var source: String?
        /// The check-ins it has on the Mac: what an undo names.
        public var checkins: [Int]

        public init(id: String, done: Bool = false, at: Date? = nil, by: String? = nil, via: String? = nil, source: String? = nil, checkins: [Int] = []) {
            self.id = id
            self.done = done
            self.at = at
            self.by = by
            self.via = via
            self.source = source
            self.checkins = checkins
        }

        private enum CodingKeys: String, CodingKey { case id, done, at, by, via, source, checkins }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            done = try c.decode(Bool.self, forKey: .done)
            at = try c.decodeIfPresent(Date.self, forKey: .at)
            by = try c.decodeIfPresent(String.self, forKey: .by)
            via = try c.decodeIfPresent(String.self, forKey: .via)
            source = try c.decodeIfPresent(String.self, forKey: .source)
            checkins = try c.decodeIfPresent([Int].self, forKey: .checkins) ?? []
        }
    }

    public var day: Day
    public var state: State
    public var slots: [Slot]
    /// For a habit counted in weeks, which has no slots: the check-ins made this day.
    public var checkins: [Int]
    /// True for a day of a habit counted in weeks.
    public var isSession: Bool

    public init(day: Day, state: State, slots: [Slot] = [], checkins: [Int] = [], isSession: Bool = false) {
        self.day = day
        self.state = state
        self.slots = slots
        self.checkins = checkins
        self.isSession = isSession
    }

    /// Slots checked in, of `total`. For a habit counted in weeks, 1 of 1 once there is a check-in.
    public var done: Int { isSession ? (state == .done ? 1 : 0) : slots.filter(\.done).count }
    public var total: Int { isSession ? 1 : slots.count }
    public var isComplete: Bool { state == .done }
    /// Slots still to do, in the habit's order.
    public var remaining: [Slot] { slots.filter { !$0.done } }

    private enum CodingKeys: String, CodingKey { case day, state, done, total, slots, checkins }

    // The Mac sends two shapes: { day, state, done, total, slots } for a habit with
    // slots, and { day, done: true|false, checkins } for one counted in weeks.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(Day.self, forKey: .day)
        if c.contains(.slots) {
            state = try c.decode(State.self, forKey: .state)
            slots = try c.decode([Slot].self, forKey: .slots)
            checkins = []
            isSession = false
        } else {
            state = try c.decode(Bool.self, forKey: .done) ? .done : .open
            slots = []
            checkins = try c.decodeIfPresent([Int].self, forKey: .checkins) ?? []
            isSession = true
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(day, forKey: .day)
        if isSession {
            try c.encode(state == .done, forKey: .done)
            try c.encode(checkins, forKey: .checkins)
        } else {
            try c.encode(state, forKey: .state)
            try c.encode(done, forKey: .done)
            try c.encode(total, forKey: .total)
            try c.encode(slots, forKey: .slots)
        }
    }
}

/// One week of a habit counted in weeks, named by its Monday.
public struct HabitWeek: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        /// Enough days have a check-in.
        case met
        case skipped
        /// Not met, and still loggable: this week, or last week until Monday ends.
        case open
        case missed
        /// Before the habit began or paused; or begun or paused partway through and not met, which is held against no one.
        case off
    }

    public var start: Day
    public var state: State
    /// Days with a check-in. Two check-ins on one day count once.
    public var count: Int
    public var target: Int
    public var days: [Day]
    /// False for a week the habit began or was paused in: such a week counts if it
    /// was met and is held against no one if not.
    public var whole: Bool?

    public init(start: Day, state: State, count: Int, target: Int, days: [Day], whole: Bool? = true) {
        self.start = start
        self.state = state
        self.count = count
        self.target = target
        self.days = days
        self.whole = whole
    }
}

public struct HabitStreak: Codable, Sendable, Equatable {
    public enum Unit: String, Codable, Sendable {
        case days, weeks
    }

    /// Yesterday is unfinished and there is a streak behind it. It survives if
    /// `missing` is logged for `day` before `until`.
    public struct AtRisk: Codable, Sendable, Equatable {
        public var day: Day
        /// For a habit counted in weeks: the Monday of the week that is one day short.
        public var week: Day?
        public var missing: [String]
        public var until: Date?

        public init(day: Day, week: Day? = nil, missing: [String] = [], until: Date? = nil) {
            self.day = day
            self.week = week
            self.missing = missing
            self.until = until
        }
    }

    /// The streak before this one: its length, and its last day (or, in weeks, its last week's Monday).
    public struct Previous: Codable, Sendable, Equatable {
        public var length: Int
        public var lastDay: Day?
        public var lastWeek: Day?

        public init(length: Int, lastDay: Day? = nil, lastWeek: Day? = nil) {
            self.length = length
            self.lastDay = lastDay
            self.lastWeek = lastWeek
        }
    }

    /// Days (or weeks) in a row that counted, up to now.
    public var current: Int
    public var best: Int
    public var unit: Unit
    public var atRisk: AtRisk?
    public var previous: Previous?

    public init(current: Int = 0, best: Int = 0, unit: Unit = .days, atRisk: AtRisk? = nil, previous: Previous? = nil) {
        self.current = current
        self.best = best
        self.unit = unit
        self.atRisk = atRisk
        self.previous = previous
    }
}

/// How much of what was expected got done over the last 7, 30 and 365 days, from 0
/// to 1. Nil when nothing was expected.
public struct HabitRates: Codable, Sendable, Equatable {
    public var d7: Double?
    public var d30: Double?
    public var d365: Double?

    public init(d7: Double? = nil, d30: Double? = nil, d365: Double? = nil) {
        self.d7 = d7
        self.d30 = d30
        self.d365 = d365
    }
}

public struct Habit: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var name: String
    /// An emoji, if it has one.
    public var icon: String?
    public var color: HabitColor
    /// When this habit's day begins. A check-in before it counts for the day before.
    public var dayStart: ClockTime
    public var schedule: HabitSchedule
    /// A paused habit expects nothing, and its streak waits.
    public var paused: Bool
    public var archived: Bool
    /// Bumped on each edit to the habit itself. Check-ins do not change it.
    public var rev: Int
    public var createdAt: Date?
    public var updatedAt: Date?
    public var today: HabitDay
    /// Still loggable until today ends.
    public var yesterday: HabitDay
    /// Only for a habit counted in weeks: this week so far, and last week while it can still change.
    public var week: HabitWeek?
    public var lastWeek: HabitWeek?
    public var streak: HabitStreak
    public var rates: HabitRates
    /// How many more days (or weeks) could be skipped right now.
    public var skipsLeft: Int

    public init(id: Int, name: String, icon: String? = nil, color: HabitColor = .indigo, dayStart: ClockTime = .defaultDayStart, schedule: HabitSchedule,
                paused: Bool = false, archived: Bool = false, rev: Int = 1, createdAt: Date? = nil, updatedAt: Date? = nil,
                today: HabitDay, yesterday: HabitDay, week: HabitWeek? = nil, lastWeek: HabitWeek? = nil,
                streak: HabitStreak = HabitStreak(), rates: HabitRates = HabitRates(), skipsLeft: Int = 0) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.dayStart = dayStart
        self.schedule = schedule
        self.paused = paused
        self.archived = archived
        self.rev = rev
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.today = today
        self.yesterday = yesterday
        self.week = week
        self.lastWeek = lastWeek
        self.streak = streak
        self.rates = rates
        self.skipsLeft = skipsLeft
    }

    public var isWeekly: Bool { schedule.isWeekly }

    /// A slot's definition, by id.
    public func slot(_ id: String) -> HabitSlot? {
        schedule.slots.first { $0.id == id }
    }

    /// What a slot is called on screen. A habit with one unnamed slot has nothing to add to its own name.
    public func slotName(_ id: String) -> String {
        let name = slot(id)?.name ?? ""
        return name.isEmpty ? id.capitalized : name
    }
}

/// What makes a habit, for creating one or saving an edit.
public struct HabitDraft: Codable, Sendable, Equatable {
    public var name: String
    /// Empty for none.
    public var icon: String
    public var color: HabitColor
    public var dayStart: ClockTime
    public var schedule: HabitSchedule

    public init(name: String = "", icon: String = "", color: HabitColor = .indigo, dayStart: ClockTime = .defaultDayStart, schedule: HabitSchedule) {
        self.name = name
        self.icon = icon
        self.color = color
        self.dayStart = dayStart
        self.schedule = schedule
    }

    public init(_ habit: Habit) {
        self.init(name: habit.name, icon: habit.icon ?? "", color: habit.color, dayStart: habit.dayStart, schedule: habit.schedule)
    }

    /// The presets the "new habit" form offers.
    public static func twiceADay(morning: ClockTime = ClockTime("07:30")!, evening: ClockTime = ClockTime("21:30")!) -> HabitDraft {
        HabitDraft(schedule: .daily(slots: [
            HabitSlot(name: "Morning", remind: morning, from: ClockTime("05:00"), until: ClockTime("11:00")),
            HabitSlot(name: "Evening", remind: evening, from: ClockTime("19:00"), until: ClockTime("02:00")),
        ]))
    }

    public static func everyDay(at time: ClockTime = ClockTime("09:00")!) -> HabitDraft {
        HabitDraft(schedule: .daily(slots: [HabitSlot(name: "", remind: time)]))
    }

    public static func timesAWeek(_ target: Int = 3) -> HabitDraft {
        HabitDraft(schedule: .weekly(target: target, remind: nil))
    }
}

/// One entry in a habit's history: a check-in, or a skipped day.
public struct HabitEvent: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case done, skip
    }

    public var id: Int
    public var kind: Kind
    public var slot: String?
    /// The habit day it counts for. For a skipped week, its Monday.
    public var day: Day
    public var at: Date
    public var zone: String?
    /// "me", or the Claude session that logged it.
    public var by: String?
    public var via: String?
    public var source: String?
    /// True when it was logged the day after.
    public var backfilled: Bool?
    public var reason: String?
    /// True when it has been taken back.
    public var undone: Bool?
}

/// A stretch of a habit's past, for a calendar.
public struct HabitHistory: Codable, Sendable, Equatable {
    public struct Week: Codable, Sendable, Equatable {
        public var start: Day
        public var state: HabitWeek.State
        public var count: Int
        public var target: Int
    }

    public var from: Day
    public var to: Day
    public var today: Day
    /// One character per day from `from` to `to`: d done, p partial, x missed, s skipped,
    /// o open, . nothing expected, _ still to come.
    public var days: String
    public var weeks: [Week]?
    public var events: [HabitEvent]

    /// The mark for one day, or nil outside the range.
    public func mark(for day: Day) -> Character? {
        let offset = day.days(since: from, calendar: .utc)
        guard offset >= 0, offset < days.count else { return nil }
        return days[days.index(days.startIndex, offsetBy: offset)]
    }
}
