// A calendar day, the way the Mac stores due dates: "2026-10-20", with no time or zone.

import Foundation

public struct Day: Sendable, Hashable, Comparable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init?(year: Int, month: Int, day: Int) {
        guard (1...9999).contains(year), (1...12).contains(month), (1...31).contains(day) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses "YYYY-MM-DD". Anything else is nil.
    public init?(_ text: String) {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        self.init(year: y, month: m, day: d)
    }

    /// The day `date` falls on, in the given calendar's time zone.
    public init(_ date: Date, calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        year = c.year ?? 1970
        month = c.month ?? 1
        day = c.day ?? 1
    }

    public static func today(calendar: Calendar = .current) -> Day {
        Day(Date(), calendar: calendar)
    }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// Noon on this day, which stays on the same day in any calendar arithmetic near midnight.
    public func date(calendar: Calendar = .current) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) ?? Date(timeIntervalSince1970: 0)
    }

    /// Whole days from `other` to this day: 1 for tomorrow, -1 for yesterday.
    public func days(since other: Day, calendar: Calendar = .current) -> Int {
        calendar.dateComponents([.day], from: other.date(calendar: calendar), to: date(calendar: calendar)).day ?? 0
    }

    /// How a due date reads next to today: "Today", "Tomorrow", "Yesterday", the weekday
    /// for the rest of the coming week, and otherwise the date ("Oct 20", with the year if it isn't this one).
    public func label(relativeTo today: Day, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let date = date(calendar: calendar)
        switch days(since: today, calendar: calendar) {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        case 2...6: return date.formatted(style.weekday(.wide))
        default: return date.formatted(year == today.year ? style.month(.abbreviated).day() : style.month(.abbreviated).day().year())
        }
    }

    public static func < (a: Day, b: Day) -> Bool {
        (a.year, a.month, a.day) < (b.year, b.month, b.day)
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let parsed = Day(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected a date as YYYY-MM-DD"))
        }
        self = parsed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}
