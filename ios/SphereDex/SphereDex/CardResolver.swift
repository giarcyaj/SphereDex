import Foundation

/// Loads the bundled card catalog and matches an OCR-read number to a real card,
/// tolerating a missing/misread hyphen and stray trailing characters.
/// Mirrors the Android BinderStore.resolve so both platforms scan identically.
final class CardResolver {

    /// normalized (letters+digits only, uppercased) -> canonical card number
    private var byNormalized: [String: String] = [:]
    /// canonical card number -> display name (for the live AR overlay)
    private var nameByNumber: [String: String] = [:]
    /// (distinctive name tokens, representative number) per base printing, for full-card name matching
    private var nameIndex: [(tokens: [String], number: String)] = []

    init() {
        guard let url = Bundle.main.url(forResource: "paldeck_cards", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cards = root["cards"] as? [[String: Any]] else {
            return
        }
        var seenBases = Set<String>()
        for card in cards {
            guard let number = card["number"] as? String else { continue }
            byNormalized[normalize(number)] = number
            let name = card["name"] as? String
            nameByNumber[number] = name
            // One representative card per base printing (variants share a name); the scan popup's
            // variant picker then narrows RR/OSR/SSP.
            if let name = name {
                let base = baseNumber(number)
                if !seenBases.contains(base) {
                    let toks = nameTokens(name)
                    if !toks.isEmpty { nameIndex.append((toks, number)); seenBases.insert(base) }
                }
            }
        }
    }

    /// Display name for a canonical card number (English), for the AR translation overlay.
    func name(for number: String) -> String? { nameByNumber[number] }

    /// Best card whose printed name overlaps [ocrText]; nil when the match is weak. The printed card
    /// NAME is large and clear even when the collector number is too small to OCR, so this is far more
    /// reliable than image feature-prints. Mirrors Android BinderStore.resolveByName.
    func resolveByName(_ ocrText: String) -> String? {
        if ocrText.isEmpty { return nil }
        let haystack = String(ocrText.uppercased().map { ($0.isLetter || $0.isNumber) ? $0 : " " })
        var bestNumber: String?
        var bestHits = 0
        var bestScore = 0.0
        var bestTokCount = 0
        for entry in nameIndex {
            var hits = 0
            for t in entry.tokens where haystack.range(of: t) != nil { hits += 1 }
            if hits == 0 { continue }
            let score = Double(hits) / Double(entry.tokens.count)
            if hits > bestHits || (hits == bestHits && score > bestScore) {
                bestHits = hits; bestScore = score; bestNumber = entry.number; bestTokCount = entry.tokens.count
            }
        }
        guard let number = bestNumber else { return nil }
        if bestHits >= 2 && bestScore >= 0.5 { return number }   // two or more distinctive words, half the name
        if bestHits >= 1 && bestTokCount == 1 { return number }   // a single-word name matched in full
        return nil
    }

    private func normalize(_ s: String) -> String {
        String(s.uppercased().filter { $0.isLetter || $0.isNumber })
    }

    /// Distinctive name words (uppercased, length >= 4), split on any non-alphanumeric.
    private func nameTokens(_ name: String) -> [String] {
        name.uppercased()
            .split(whereSeparator: { !($0.isLetter || $0.isNumber) })
            .map(String.init)
            .filter { $0.count >= 4 }
    }

    /// Strip a trailing rarity suffix so variants collapse to one base (mirrors Android Card.base).
    private func baseNumber(_ number: String) -> String {
        let up = number.uppercased()
        for s in ["OSR", "SSP", "TSR", "TSP", "SP", "SR"] where up.hasSuffix(s) {
            return String(number.dropLast(s.count))
        }
        return number
    }

    /// Exact normalized match, else the most specific stored number that this scan begins with.
    func resolve(_ scanned: String) -> String? {
        let s = normalize(scanned)
        if s.isEmpty { return nil }
        if let hit = byNormalized[s] { return hit }
        var best: (key: String, value: String)?
        for (key, value) in byNormalized where !key.isEmpty && s.hasPrefix(key) {
            if best == nil || key.count > best!.key.count { best = (key, value) }
        }
        return best?.value
    }
}
