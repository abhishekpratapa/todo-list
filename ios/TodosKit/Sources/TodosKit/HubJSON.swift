// JSON as the Mac speaks it: timestamps are ISO 8601 in UTC with milliseconds
// ("2026-10-05T14:58:12.345Z"), which JSONDecoder's own .iso8601 does not read.

import Foundation

enum HubJSON {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let withoutFraction = Date.ISO8601FormatStyle()

    static func parseDate(_ text: String) -> Date? {
        (try? withFraction.parse(text)) ?? (try? withoutFraction.parse(text))
    }

    static func string(from date: Date) -> String {
        withFraction.format(date)
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = parseDate(text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected an ISO 8601 timestamp"))
            }
            return date
        }
        return decoder
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
