// A check-in made from a widget's button, where the app isn't running.
//
// It is saved in the same queue the app uses, so the widget can show it at once
// and nothing is lost if the Mac can't be reached. Then, if this process may
// read the Mac's token, it tries for a few seconds to send it; if that doesn't
// work, the app sends it the next time it runs. Either way it is recorded once:
// the change carries a key the Mac recognises.

import Foundation

public enum WidgetCheckIn {
    public enum Outcome: Sendable, Equatable {
        /// Saved, and the Mac has it.
        case sent
        /// Saved on this iPhone, to be sent when the Mac can be reached.
        case waiting
        /// There was nothing to check in: it is done already, or that day can no longer be logged.
        case nothingToDo
        case notPaired
    }

    public struct Result: Sendable, Equatable {
        public var outcome: Outcome
        /// What was checked in, when something was: for taking its reminders away.
        public var slot: String?
        public var day: Day?
    }

    /// Checks in `slot` of a habit (the one still to do, if nil) for `day` (today, if nil).
    /// `day` is the habit day the widget was showing, so a tap on a widget drawn before
    /// the day turned over still counts for the day it showed.
    /// - Parameters:
    ///   - folder: the paired Mac's folder in the shared container.
    ///   - client: a client for the Mac, or nil if this process can't reach it.
    public static func perform(habit id: Int, slot: String? = nil, day: Day? = nil, in folder: URL?, client: HubClient?,
                               now: Date = Date(), zone: TimeZone = .current, patience: Double = 5) async -> Result {
        func nothing(_ outcome: Outcome) -> Result { Result(outcome: outcome, slot: nil, day: nil) }
        guard let folder else { return nothing(.notPaired) }
        let store = LocalStore(directory: folder)
        let shown = await store.habits.habits.reckoned(with: store.changes, now: now, zone: zone)
        guard let habit = shown.first(where: { $0.id == id }) else { return nothing(.nothingToDo) }
        let day = day ?? habit.today.day
        guard day == habit.today.day || day == habit.yesterday.day else { return nothing(.nothingToDo) }
        let late = day != habit.today.day
        let chosen = habit.isWeekly ? nil : (slot ?? (late ? habit.yesterday.remaining.first?.id : habit.slotToCheckIn(at: now, zone: zone)))
        guard habit.isOpen(slot: chosen, on: day), habit.isWeekly || chosen != nil else { return nothing(.nothingToDo) }

        let change = await store.add(.checkIn(habit: id, name: habit.name, slot: chosen, day: day, at: now, zone: zone.identifier, source: .widget, backfilled: late), at: now)
        if let client {
            await SyncEngine(client: client, store: store).replay(givingUpAfter: patience)
        }
        return Result(outcome: await store.changes.contains { $0.id == change.id } ? .waiting : .sent, slot: chosen, day: day)
    }

    /// The identifiers of the notifications about that slot: its reminder, its second
    /// reminder and a snoozed one. Whoever records a check-in takes these away.
    public static func notifications(habit: Int, slot: String?, day: Day) -> [String] {
        [PlannedNotification.identifier(habit: habit, slot: slot, day: day, isNudge: false),
         PlannedNotification.identifier(habit: habit, slot: slot, day: day, isNudge: true),
         PlannedNotification.snoozeIdentifier(habit: habit, slot: slot, day: day)]
    }
}
