import Foundation

/// Loads the bundled card catalog and matches an OCR-read number to a real card,
/// tolerating a missing/misread hyphen and stray trailing characters.
/// Mirrors the Android BinderStore.resolve so both platforms scan identically.
final class CardResolver {

    /// normalized (letters+digits only, uppercased) -> canonical card number
    private var byNormalized: [String: String] = [:]

    init() {
        guard let url = Bundle.main.url(forResource: "paldeck_cards", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cards = root["cards"] as? [[String: Any]] else {
            return
        }
        for card in cards {
            if let number = card["number"] as? String {
                byNormalized[normalize(number)] = number
            }
        }
    }

    private func normalize(_ s: String) -> String {
        String(s.uppercased().filter { $0.isLetter || $0.isNumber })
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
