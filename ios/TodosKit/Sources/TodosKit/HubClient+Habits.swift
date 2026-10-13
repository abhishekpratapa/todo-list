// The habit endpoints of /api/v1 (revision 5). A Mac whose Todos is older has
// none of them and answers 404.

import Foundation

extension HubClient {
    public struct HabitList: Decodable, Sendable, Equatable {
        public var habits: [Habit]
        /// The time zone "today" is being told by: the one a device last reported.
        public var zone: String
        /// The number the `habits` live update announces.
        public var version: Int
    }

    /// What a check-in or a skip answers: the habit afterwards, and what was recorded.
    /// `checkin` and `skip` are nil when there turned out to be nothing to do.
    public struct HabitResult: Decodable, Sendable, Equatable {
        public var habit: Habit
        public var checkin: HabitEvent?
        public var skip: HabitEvent?
    }

    private struct OneHabit: Decodable {
        var habit: Habit
    }

    // MARK: Habits

    public func habits(includingArchived: Bool = false) async throws -> HabitList {
        try await get("/habits", query: includingArchived ? ["archived": "true"] : [:])
    }

    public func habit(_ id: Int) async throws -> Habit {
        try await (get("/habits/\(id)") as OneHabit).habit
    }

    public func createHabit(_ draft: HabitDraft, key: UUID? = nil) async throws -> Habit {
        try habit(in: await send("POST", "/habits", body: draft, headers: Self.keyed(key)).data)
    }

    /// Saves an edit. `rev` is the revision it is based on: if the habit has changed
    /// since, this throws `HubError.habitConflict` with the current habit and nothing is changed.
    public func updateHabit(_ id: Int, rev: Int, _ draft: HabitDraft) async throws -> Habit {
        try habit(in: await send("PATCH", "/habits/\(id)", body: draft, headers: ["If-Match": "\"\(rev)\""]).data)
    }

    /// Pauses or resumes a habit, or puts it away or brings it back. These say what
    /// the habit should be, whatever else changed, so they need no revision.
    public func setHabit(_ id: Int, paused: Bool? = nil, archived: Bool? = nil) async throws -> Habit {
        struct Body: Encodable, Sendable {
            var paused: Bool?
            var archived: Bool?
        }
        return try habit(in: await send("PATCH", "/habits/\(id)", body: Body(paused: paused, archived: archived), headers: ["If-Match": "*"]).data)
    }

    /// Deletes a habit and everything it recorded.
    public func deleteHabit(_ id: Int) async throws {
        _ = try await send("DELETE", "/habits/\(id)", headers: ["If-Match": "*"])
    }

    // MARK: Check-ins

    /// Records that a habit, or one slot of it, was done. `at` and `zone` say when and
    /// where it really happened, for a check-in made while offline; `day` is only
    /// needed to log yesterday.
    public func checkIn(_ id: Int, slot: String? = nil, at: Date? = nil, zone: String? = nil, day: Day? = nil,
                        source: HabitSource = .manual, key: UUID? = nil) async throws -> HabitResult {
        struct Body: Encodable, Sendable {
            var slot: String?
            var at: Date?
            var zone: String?
            var day: Day?
            var source: HabitSource
        }
        return try decode(await send("POST", "/habits/\(id)/checkins", body: Body(slot: slot, at: at, zone: zone, day: day, source: source), headers: Self.keyed(key)).data)
    }

    /// Takes check-ins back: the ones the Mac has (`checkins`) and ones this iPhone
    /// sent or is about to send (`keys`, the keys they were sent with). Naming them
    /// means an undo that arrives late can't remove a check-in made elsewhere.
    public func undoCheckIns(_ id: Int, checkins: [Int], keys: [UUID], at: Date? = nil, key: UUID? = nil) async throws -> Habit {
        struct Body: Encodable, Sendable {
            var checkins: [Int]
            var keys: [String]
            var at: Date?
        }
        return try habit(in: await send("POST", "/habits/\(id)/undo", body: Body(checkins: checkins, keys: keys.map(\.uuidString), at: at), headers: Self.keyed(key)).data)
    }

    /// Marks a day (for a habit counted in weeks, its week) as a rest day.
    public func skip(_ id: Int, day: Day? = nil, at: Date? = nil, zone: String? = nil, reason: String? = nil, key: UUID? = nil) async throws -> HabitResult {
        struct Body: Encodable, Sendable {
            var day: Day?
            var at: Date?
            var zone: String?
            var reason: String?
        }
        return try decode(await send("POST", "/habits/\(id)/skips", body: Body(day: day, at: at, zone: zone, reason: reason), headers: Self.keyed(key)).data)
    }

    public func undoSkip(_ id: Int, day: Day, at: Date? = nil, zone: String? = nil, key: UUID? = nil) async throws -> Habit {
        struct Body: Encodable, Sendable {
            var skip = true
            var day: Day
            var at: Date?
            var zone: String?
        }
        return try habit(in: await send("POST", "/habits/\(id)/undo", body: Body(day: day, at: at, zone: zone), headers: Self.keyed(key)).data)
    }

    // MARK: History and place

    /// A stretch of a habit's past for a calendar: the last 365 days unless told otherwise.
    public func habitHistory(_ id: Int, from: Day? = nil, to: Day? = nil) async throws -> HabitHistory {
        var query: [String: String] = [:]
        if let from { query["from"] = from.description }
        if let to { query["to"] = to.description }
        return try await get("/habits/\(id)/history", query: query)
    }

    /// Tells the Mac which time zone the user is in, so "today" follows them when they travel.
    public func reportZone(_ zone: String) async throws {
        _ = try await send("POST", "/habits/zone", body: ["zone": zone])
    }

    private func habit(in data: Data) throws -> Habit {
        try (decode(data) as OneHabit).habit
    }
}
