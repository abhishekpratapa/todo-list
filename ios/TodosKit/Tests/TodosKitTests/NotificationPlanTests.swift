// Which notifications the phone should have waiting: reminders for tasks, and for
// habits a reminder and a nudge for each slot, shared out within what iOS will keep.

import Foundation
import Testing
@testable import TodosKit

@Suite("Reminders for habits, and sharing iOS's 64 notifications")
struct NotificationPlanTests {
    let zone = HabitSample.chicago
    let brush = HabitSample.brush // Wednesday 7 October 2026: morning done, evening not; a streak of 2
    let gym = HabitSample.gym // 3 a week, reminders Mon, Wed, Fri at 17:30; two this week, one of them today
    func at(_ stamp: String) -> Date { HabitSample.at(stamp) }
    func plan(_ habits: [Habit], _ stamp: String, days: Int = 3, nudges: Bool = true) -> [PlannedNotification] {
        HabitReminderPlan.plan(for: habits, now: at(stamp), zone: zone, days: days, nudges: nudges)
    }
    func wall(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> DateComponents {
        DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
    }

    /// A habit done twice a day, with nothing done yet today.
    func habit(_ id: Int, remind: [String] = ["07:30", "21:30"], nudge: String? = "22:30", today: String = "2026-10-07") -> Habit {
        let slots = zip(["morning", "evening"], remind).map { HabitSlot(id: $0, name: $0.capitalized, remind: ClockTime($1), nudge: $0 == "evening" ? nudge.flatMap(ClockTime.init) : nil) }
        let day = Day(today)!
        return Habit(id: id, name: "Habit \(id)", schedule: .daily(slots: slots),
                     today: HabitDay(day: day, state: .open, slots: slots.map { .init(id: $0.id) }),
                     yesterday: HabitDay(day: day.adding(days: -1), state: .off))
    }

    func task(_ id: Int, remind stamp: String) -> TodoTask {
        var task = Sample.task(id, "Task \(id)")
        task.remindAt = at(stamp)
        return task
    }

    // MARK: A habit's reminders

    @Test("a reminder at each slot's time and a nudge after it, for what is still to do, soonest first")
    func slots() {
        let planned = plan([brush], "2026-10-07 20:00")
        #expect(planned.map(\.id) == [
            "habit-1-evening-2026-10-07", "habit-1-evening-2026-10-07-nudge",
            "habit-1-morning-2026-10-08", "habit-1-evening-2026-10-08", "habit-1-evening-2026-10-08-nudge",
            "habit-1-morning-2026-10-09", "habit-1-evening-2026-10-09", "habit-1-evening-2026-10-09-nudge",
        ], "this morning is done, so it is not among them")
        let first = planned[0]
        #expect(first.subject == .habit(id: 1, slot: "evening", day: Day("2026-10-07")!, isNudge: false))
        #expect(first.title == "🪥 Brush teeth" && first.body == "Evening · Keeps your 2-day streak going.")
        #expect(first.fireDate == at("2026-10-07 21:30") && first.wallClock == wall(2026, 10, 7, 21, 30))
        #expect(first.wallClock?.timeZone == nil, "a reading on the wall clock, wherever the phone is by then")
        #expect(planned[1].body == "Evening is still open, and so is your 2-day streak." && planned[1].fireDate == at("2026-10-07 22:30"))
        // Further ahead the streak is spoken of without a number: it will have changed by then.
        #expect(planned[2].body == "Morning · Keeps your streak going." && planned[4].body == "Evening is still open.")
        #expect(plan([brush], "2026-10-07 20:00", nudges: false).count == 5)
    }

    @Test("what has passed is not scheduled, and what is checked in early is cancelled")
    func passedAndDone() {
        #expect(plan([brush], "2026-10-07 21:45", days: 1).map(\.id) == ["habit-1-evening-2026-10-07-nudge"], "the reminder's time has gone; the nudge's has not")
        #expect(plan([brush], "2026-10-07 23:00", days: 1).isEmpty)
        // Checked in at 9 PM, before the reminder: the reminder and the nudge both go.
        let early = HabitSample.checkIn(brush, "evening", "2026-10-07 21:00")
        let after = brush.reckoned(with: [early], now: at("2026-10-07 21:01"), zone: zone)
        #expect(plan([after], "2026-10-07 21:01", days: 1).isEmpty)
        #expect(plan([after], "2026-10-07 21:01", days: 2).map(\.id) == ["habit-1-morning-2026-10-08", "habit-1-evening-2026-10-08", "habit-1-evening-2026-10-08-nudge"])
        // Taken back, they return.
        let undo = PendingChange(createdAt: at("2026-10-07 21:02"), kind: .undoCheckIn(habit: 1, name: "Brush teeth", slot: "evening", day: Day("2026-10-07")!, checkins: [], keys: [early.id], at: at("2026-10-07 21:02")))
        #expect(plan([brush.reckoned(with: [early, undo], now: at("2026-10-07 21:03"), zone: zone)], "2026-10-07 21:03", days: 1).count == 2)
    }

    @Test("a rest day, a paused habit and an archived one have no reminders; chosen weekdays have theirs")
    func notExpected() {
        var resting = brush
        resting.today.state = .skipped
        #expect(plan([resting], "2026-10-07 20:00", days: 1).isEmpty)
        #expect(plan([resting], "2026-10-07 20:00", days: 2).count == 3, "tomorrow is an ordinary day")
        var paused = brush
        paused.paused = true
        var archived = brush
        archived.archived = true
        #expect(plan([paused, archived], "2026-10-07 20:00").isEmpty)

        var some = habit(4, nudge: nil)
        some.schedule = .days([.mon, .thu], slots: some.schedule.slots)
        some.today = HabitDay(day: Day("2026-10-07")!, state: .off) // a Wednesday
        #expect(plan([some], "2026-10-07 06:00", days: 7).map(\.id) == ["habit-4-morning-2026-10-08", "habit-4-evening-2026-10-08", "habit-4-morning-2026-10-12", "habit-4-evening-2026-10-12"])
    }

    @Test("a time after midnight belongs to the day before, and fires on the next date")
    func afterMidnight() {
        var late = habit(5, remind: ["07:30", "23:30"], nudge: "00:45")
        late.streak.current = 4
        let planned = plan([late], "2026-10-07 23:00", days: 1)
        #expect(planned.map(\.id) == ["habit-5-evening-2026-10-07", "habit-5-evening-2026-10-07-nudge"])
        #expect(planned[1].wallClock == wall(2026, 10, 8, 0, 45) && planned[1].fireDate == at("2026-10-08 00:45"), "the 7th's nudge, at a quarter to one on the 8th")
        // At half past midnight it is still the 7th for this habit, and the nudge is still to come.
        let stillSeventh = late.reckoned(now: at("2026-10-08 00:30"), zone: zone)
        #expect(stillSeventh.today.day == Day("2026-10-07") && plan([stillSeventh], "2026-10-08 00:30", days: 1).map(\.id) == ["habit-5-evening-2026-10-07-nudge"])
    }

    @Test("a habit counted in weeks is reminded on its days, until the week is met")
    func weekly() {
        // Wednesday, already been today: nothing more today. Friday still to come.
        var planned = plan([gym], "2026-10-07 12:00", days: 7)
        #expect(planned.map(\.id) == ["habit-2-visit-2026-10-09", "habit-2-visit-2026-10-12"])
        #expect(planned[0].subject == .habit(id: 2, slot: nil, day: Day("2026-10-09")!, isNudge: false) && planned[0].wallClock == wall(2026, 10, 9, 17, 30))
        #expect(planned[0].body == "2 of 3 this week" && planned[1].body == "Planned for today" && planned[0].title == "Gym")
        // Not been yet today: today's reminder is there, with the streak.
        var fresh = gym
        fresh.today = HabitDay(day: gym.today.day, state: .open, isSession: true)
        fresh.week?.count = 1
        fresh.streak.current = 3
        planned = plan([fresh], "2026-10-07 12:00", days: 1)
        #expect(planned.map(\.body) == ["1 of 3 this week · 3 weeks so far"])
        // The week is met: nothing more this week, and next week starts again.
        fresh.week?.state = .met
        #expect(plan([fresh], "2026-10-07 12:00", days: 7).map(\.id) == ["habit-2-visit-2026-10-12"])
        var none = gym
        none.schedule = .weekly(target: 3, remind: nil)
        #expect(plan([none], "2026-10-07 12:00", days: 14).isEmpty)
    }

    @Test("an identifier says what it is about, and whether that can still be checked in")
    func identifiers() {
        typealias Target = PlannedNotification.HabitTarget
        #expect(PlannedNotification.habitTarget(of: "habit-1-evening-2026-10-07") == Target(habit: 1, slot: "evening", day: Day("2026-10-07")!, isSnooze: false))
        #expect(PlannedNotification.habitTarget(of: "habit-12-after-lunch-2026-10-07-nudge") == Target(habit: 12, slot: "after-lunch", day: Day("2026-10-07")!, isSnooze: false))
        #expect(PlannedNotification.habitTarget(of: "habit-2-visit-2026-10-09") == Target(habit: 2, slot: nil, day: Day("2026-10-09")!, isSnooze: false))
        #expect(PlannedNotification.habitTarget(of: PlannedNotification.snoozeIdentifier(habit: 3, slot: "evening", day: Day("2026-10-07")!)) == Target(habit: 3, slot: "evening", day: Day("2026-10-07")!, isSnooze: true))
        #expect(PlannedNotification.habitTarget(of: PlannedNotification.snoozeIdentifier(habit: 3, slot: nil, day: Day("2026-10-07")!))?.slot == nil)
        for other in ["reminder-12", PlannedNotification.noticeIdentifier, "habit-x-evening-2026-10-07", "habit-1-evening", ""] {
            #expect(PlannedNotification.habitTarget(of: other) == nil, "\(other)")
        }
        #expect(brush.isOpen(slot: "evening", on: Day("2026-10-07")!) && !brush.isOpen(slot: "morning", on: Day("2026-10-07")!))
        #expect(!brush.isOpen(slot: "evening", on: Day("2026-10-06")!), "yesterday is done")
        #expect(!brush.isOpen(slot: "evening", on: Day("2026-10-05")!), "too long ago to log")
        #expect(!gym.isOpen(slot: nil, on: Day("2026-10-07")!) && gym.isOpen(slot: nil, on: Day("2026-10-06")!))
    }

    // MARK: Sharing the places

    @Test("three habits and a few task reminders: everything near fits, and a notice marks where it stops")
    func ordinary() {
        let habits = [habit(1), habit(2), gym]
        let tasks = (1...5).map { task($0, remind: "2026-10-\(10 + $0) 09:00") } + [task(6, remind: "2027-03-01 09:00")]
        let made = NotificationPlan.make(tasks: tasks, habits: habits, now: at("2026-10-07 06:00"), zone: zone)
        #expect(made.tasks.count == 6, "task reminders all fit, however far off")
        #expect(made.notifications.count == NotificationPlan.systemLimit - NotificationPlan.snoozeReserve, "every place is used, and three are kept for snoozes")
        #expect(made.habits.count == 54)
        #expect(!made.isShort && !made.withoutNudges)
        // Two habits with three a day, and the gym three times a week: about eight days.
        #expect(made.habitsCoveredThrough == Day("2026-10-14"))
        let notice = try! #require(made.notice)
        #expect(notice.id == PlannedNotification.noticeIdentifier && notice.title == "Open Todos to keep reminders coming")
        #expect(notice.fireDate > made.habits.last!.fireDate || notice.fireDate == made.habits.last!.fireDate, "it stands where the first reminder that didn't fit would have been")
        #expect(notice.body.hasPrefix("Habit ") && notice.body.contains("opening it schedules the next ones"))
        #expect(made.notifications.map(\.fireDate) == made.notifications.map(\.fireDate).sorted())
        #expect(Set(made.notifications.map(\.id)).count == made.notifications.count, "no identifier twice")
    }

    @Test("task reminders keep their share however many habits there are, and use more when habits leave room")
    func tasksKeepTheirShare() {
        let tasks = (1...40).map { task($0, remind: "2026-11-\(String(format: "%02d", $0 % 28 + 1)) 09:00") }
        let many = NotificationPlan.make(tasks: tasks, habits: (1...6).map { habit($0) }, now: at("2026-10-07 06:00"), zone: zone)
        #expect(many.tasks.count == NotificationPlan.taskShare, "the soonest 24")
        #expect(Set(many.tasks.map(\.fireDate)) == Set(ReminderPlan.plan(for: tasks, now: at("2026-10-07 06:00")).prefix(24).map(\.fireDate)))
        #expect(many.habits.count == 36 && many.notifications.count == 61)

        // No habits: exactly as before habits existed, up to 60.
        let alone = NotificationPlan.make(tasks: tasks + (41...80).map { task($0, remind: "2026-12-01 09:00") }, habits: [], now: at("2026-10-07 06:00"), zone: zone)
        #expect(alone.tasks.count == 60 && alone.notice == nil && alone.habitsCoveredThrough == nil)
        // A habit with no reminder times takes nothing.
        var quiet = habit(1, nudge: nil)
        quiet.schedule = .daily(slots: [HabitSlot(id: "once", name: "")])
        #expect(NotificationPlan.make(tasks: tasks, habits: [quiet], now: at("2026-10-07 06:00"), zone: zone).tasks.count == 40)
        // Switched off, each kind is left out.
        let tasksOnly = NotificationPlan.make(tasks: tasks, habits: [habit(1)], habitReminders: false, now: at("2026-10-07 06:00"), zone: zone)
        #expect(tasksOnly.habits.isEmpty && tasksOnly.tasks.count == 40 && tasksOnly.notice == nil)
        let habitsOnly = NotificationPlan.make(tasks: tasks, habits: [habit(1)], taskReminders: false, now: at("2026-10-07 06:00"), zone: zone)
        #expect(habitsOnly.tasks.isEmpty && habitsOnly.habits.count == 60)
    }

    @Test("with a great many habits, nudges go before reminders do, the soonest are kept, and the plan says it is short")
    func many() {
        let habits = (1...30).map { habit($0) } // 60 reminders and 30 nudges a day
        let made = NotificationPlan.make(tasks: [], habits: habits, now: at("2026-10-07 06:00"), zone: zone)
        #expect(made.withoutNudges && made.isShort, "today and tomorrow are 120 reminders, and there are 60 places")
        #expect(made.habits.count == 60 && made.habits.allSatisfy { if case .habit(_, _, _, let nudge) = $0.subject { !nudge } else { false } })
        #expect(made.habits.allSatisfy { $0.fireDate <= at("2026-10-07 21:30") }, "all of today's, and nothing later is preferred to them")
        #expect(made.notice?.fireDate == at("2026-10-08 07:30"), "the notice is tomorrow morning's first reminder")
        #expect(made.habitsCoveredThrough == Day("2026-10-07"))

        // Fifteen habits: with nudges only today would fit, so they go, and today and tomorrow are both covered.
        let fewer = NotificationPlan.make(tasks: [], habits: (1...15).map { habit($0) }, now: at("2026-10-07 06:00"), zone: zone)
        #expect(fewer.withoutNudges && !fewer.isShort && fewer.habitsCoveredThrough == Day("2026-10-08"))
    }

    @Test("it never asks iOS to keep more than 64, whatever there is to remind about")
    func neverMoreThanTheLimit() {
        for habitCount in [0, 1, 2, 3, 5, 8, 13, 21, 40] {
            for taskCount in [0, 1, 10, 24, 25, 60, 90] {
                for snoozed in [0, 2, 3, 7, 20] {
                    let habits = habitCount == 0 ? [] : (1...habitCount).map { habit($0) }
                    let tasks = taskCount == 0 ? [] : (1...taskCount).map { task($0, remind: "2026-10-\(String(format: "%02d", $0 % 20 + 8)) 0\($0 % 9):00") }
                    let made = NotificationPlan.make(tasks: tasks, habits: habits, snoozed: snoozed, now: at("2026-10-07 06:00"), zone: zone)
                    let total = made.notifications.count + snoozed
                    #expect(total <= NotificationPlan.systemLimit, "\(habitCount) habits, \(taskCount) task reminders, \(snoozed) snoozed: \(total)")
                    #expect(made.tasks.count >= min(taskCount, 24, max(0, 63 - max(snoozed, 3))), "tasks keep their share")
                    if habitCount > 0 { #expect(made.notice != nil, "and there is always a notice where the habit reminders stop") }
                }
            }
        }
    }

    @Test("laid out again a day later, the schedule has moved on a day and nothing near was dropped")
    func rolling() {
        let habits = [habit(1), habit(2)]
        let monday = NotificationPlan.make(tasks: [], habits: habits, now: at("2026-10-07 06:00"), zone: zone)
        let next = habits.map { $0.reckoned(now: at("2026-10-08 06:00"), zone: zone) }
        let tuesday = NotificationPlan.make(tasks: [], habits: next, now: at("2026-10-08 06:00"), zone: zone)
        #expect(tuesday.habitsCoveredThrough == monday.habitsCoveredThrough?.adding(days: 1))
        let stillToCome = monday.habits.filter { $0.fireDate > at("2026-10-08 06:00") }.map(\.id)
        #expect(Set(stillToCome).isSubset(of: Set(tuesday.habits.map(\.id))), "everything Monday scheduled that hasn't fired is still scheduled")
        #expect(tuesday.notice!.fireDate > monday.notice!.fireDate)
    }
}
