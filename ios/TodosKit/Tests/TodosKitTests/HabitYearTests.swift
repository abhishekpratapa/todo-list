import Foundation
import Testing
@testable import TodosKit

@Suite("A year of habits, a dot a day")
struct HabitYearTests {
    /// Wednesday 7 October 2026, the day HabitSample is set on.
    let today = Day("2026-10-07")!

    /// What the Mac would say about one habit from January 1 to `asOf`: nothing expected
    /// (".") except on the days given.
    func marks(_ id: Int, _ days: [String: Character], asOf: String = "2026-10-07") -> HabitCalendar.Marks {
        let start = Day("2026-01-01")!
        let end = Day(asOf)!
        let text = (0...end.days(since: start, calendar: .utc)).map { offset in
            days[start.adding(days: offset).description] ?? "."
        }
        return HabitCalendar.Marks(habit: id, days: String(text))
    }

    func calendar(_ habits: HabitCalendar.Marks..., asOf: String = "2026-10-07") -> HabitCalendar {
        HabitCalendar(year: 2026, asOf: Day(asOf)!, habits: habits)
    }

    func index(_ day: String) -> Int { Day(day)!.days(since: Day("2026-01-01")!, calendar: .utc) }

    /// Brush teeth as HabitSample has it (yesterday done, today one of two), with a new id and name.
    func daily(_ id: Int, _ name: String) -> Habit {
        var habit = HabitSample.brush
        habit.id = id
        habit.name = name
        return habit
    }

    @Test("every day of the year has a mark, and the days to come are left for later")
    func shape() {
        let year = HabitYear(calendar: nil, habits: [HabitSample.brush], today: today)
        #expect(year.year == 2026 && year.marks.count == 365 && year.today == 279)
        #expect(year.marks[280...].allSatisfy { $0 == .future })
        #expect(year.marks[..<278].allSatisfy { $0 == .none }, "with no record from the Mac, the past says nothing")
        #expect(HabitYear(calendar: nil, habits: [], today: Day("2028-03-01")!).marks.count == 366, "a leap year has a day more")
    }

    @Test("a day is complete when every habit done at set times was done; some of it is partial; none of it, missed")
    func days() {
        let brush = daily(1, "Brush teeth"), floss = daily(3, "Floss")
        let record = calendar(
            marks(1, ["2026-09-01": "d", "2026-09-02": "d", "2026-09-03": "x", "2026-09-04": "p", "2026-09-05": "s", "2026-09-06": "d"]),
            marks(3, ["2026-09-01": "d", "2026-09-02": "x", "2026-09-03": "x", "2026-09-04": "x", "2026-09-05": "d", "2026-09-06": "."])
        )
        let year = HabitYear(calendar: record, habits: [brush, floss], today: today)
        #expect(year.marks[index("2026-09-01")] == .complete, "both done")
        #expect(year.marks[index("2026-09-02")] == .partial, "one done, the other not")
        #expect(year.marks[index("2026-09-03")] == .missed, "neither")
        #expect(year.marks[index("2026-09-04")] == .partial, "a day partly done counts as progress")
        #expect(year.marks[index("2026-09-05")] == .complete, "a rest day asks nothing, so what was asked was done")
        #expect(year.marks[index("2026-09-06")] == .complete, "a habit not scheduled that day asks nothing")
        #expect(year.marks[index("2026-08-31")] == .none, "before either began")
    }

    @Test("today and yesterday come from the habits as they stand on this iPhone, not the Mac's older record")
    func recent() {
        // The record was fetched this morning: yesterday was still open then, and today had nothing.
        let record = calendar(marks(1, ["2026-10-06": "o", "2026-10-07": "o"]))
        var brush = HabitSample.brush // yesterday done; today morning done, evening not
        var year = HabitYear(calendar: record, habits: [brush], today: today)
        #expect(year.marks[index("2026-10-06")] == .complete)
        #expect(year.marks[year.today] == .open, "today, half done, is still open")
        #expect(year.completed == 1 && year.counted == 1, "an open day is not counted yet")

        // The evening is checked in (on this phone, or anywhere the phone has heard of).
        brush = brush.reckoned(with: [HabitSample.checkIn(brush, "evening", "2026-10-07 21:40")], now: HabitSample.at("2026-10-07 21:41"), zone: HabitSample.chicago)
        year = HabitYear(calendar: record, habits: [brush], today: today)
        #expect(year.marks[year.today] == .complete && year.completed == 2 && year.counted == 2)

        // Yesterday left unfinished can still be logged: open, not missed.
        brush.yesterday = HabitDay(day: Day("2026-10-06")!, state: .open, slots: [.init(id: "morning", done: true), .init(id: "evening")])
        year = HabitYear(calendar: record, habits: [brush], today: today)
        #expect(year.marks[index("2026-10-06")] == .open && year.counted == 1)
    }

    @Test("a habit counted in weeks asks nothing of any one day: a visit counts only when nothing else was asked")
    func weekly() {
        let gym = HabitSample.gym // a visit today
        let record = calendar(marks(2, ["2026-10-01": "d", "2026-10-02": "s"]), marks(1, ["2026-10-01": "x"]))
        #expect(HabitYear(calendar: record, habits: [gym], today: today).marks[index("2026-10-01")] == .complete, "a visit on its own")
        #expect(HabitYear(calendar: record, habits: [gym], today: today).marks[index("2026-10-02")] == .none, "a rest week")
        let both = HabitYear(calendar: record, habits: [HabitSample.brush, gym], today: today)
        #expect(both.marks[index("2026-10-01")] == .missed, "the gym does not make up for teeth not brushed")
        #expect(both.marks[both.today] == .open, "nor does today's visit finish today")
    }

    @Test("the streak of days with everything done, and the last weeks as a small calendar")
    func streakAndWeeks() {
        // ... missed, complete, nothing asked, complete, complete (yesterday), today open.
        var marks = [HabitYear.Mark](repeating: .future, count: 365)
        for index in 0...279 { marks[index] = .complete }
        marks[270] = .missed
        marks[273] = .none
        marks[279] = .open
        var year = HabitYear(year: 2026, marks: marks, today: 279)
        #expect(year.todayDay == Day("2026-10-07"))
        #expect(year.streak == 7, "271 to 278 less the day that asked nothing; today, open, does not count yet")
        year.marks[279] = .complete
        #expect(year.streak == 8, "and once today is done, it does")
        year.marks[278] = .partial
        #expect(year.streak == 1)
        #expect(HabitYear(year: 2026, marks: Array(repeating: .none, count: 365), today: 10).streak == 0)

        let weeks = year.recent(weeks: 3)
        #expect(weeks.count == 3 && weeks.allSatisfy { $0.count == 7 })
        // Wednesday 7 October is the third day of the last column (Tuesday the 6th was partly done); the days after it are to come.
        #expect(weeks[2][2] == .complete && weeks[2][3] == .future && weeks[2][1] == .partial && weeks[2][0] == .complete)
        #expect(weeks[0][0] == year.marks[Day("2026-09-21")!.days(since: Day("2026-01-01")!, calendar: .utc)], "three Mondays back")
        let january = HabitYear(year: 2026, marks: Array(repeating: .complete, count: 365), today: 2).recent(weeks: 2)
        #expect(january[1][0] == nil && january[1][3] == .complete, "Monday 29 December was last year")
    }

    @Test("what is not shown is not counted: archived habits, another year's record, days the phone has no record of")
    func ignored() {
        var old = daily(5, "Old")
        old.archived = true
        let record = calendar(marks(1, ["2026-09-01": "d"]), marks(5, ["2026-09-01": "x"]), asOf: "2026-09-02")
        let year = HabitYear(calendar: record, habits: [HabitSample.brush, old], today: today)
        #expect(year.marks[index("2026-09-01")] == .complete, "the archived habit is left out")
        #expect(year.marks[index("2026-09-20")] == .none, "after the record ends and before yesterday, nothing is known")
        let lastYear = HabitCalendar(year: 2025, asOf: Day("2025-12-31")!, habits: [marks(1, [:])])
        #expect(HabitYear(calendar: lastYear, habits: [HabitSample.brush], today: today).marks[index("2026-09-01")] == .none)
    }
}
