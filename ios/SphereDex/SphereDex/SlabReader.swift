import Foundation
import Vision
import CoreVideo
import CoreImage

// Reads a graded-slab label (grading company, numeric grade, and the cert number from the label barcode)
// out of a single camera frame. Everything runs on a background queue; `completion` is called exactly once.
// Returns nil when the frame doesn't look like a slab (i.e. it's a raw card).

struct SlabInfo {
    let grader: String       // canonical grader, e.g. "PSA", "BGS", "CGC"
    let grade: String        // normalised grade, e.g. "10", "9.5", "9" ("" if a grader was seen but no grade read)
    let cert: String?        // certification number from the barcode, if one decoded
}

enum SlabReader {

    // Heavy Vision work stays off the main thread. Serial so frames don't pile up on the CPU.
    private static let queue = DispatchQueue(label: "app.spheredex.slab", qos: .userInitiated)

    // MARK: - Tunables

    // Grading companies we recognise on a slab label, paired with the canonical grader we report.
    // Order = match priority. BECKETT is Beckett Grading Services and is reported as BGS.
    // Add rows here to support more graders.
    private static let knownCompanies: [(token: String, grader: String)] = [
        ("PSA",     "PSA"),
        ("BECKETT", "BGS"),
        ("BGS",     "BGS"),
        ("CGC",     "CGC"),
        ("SGC",     "SGC"),
        ("ACE",     "ACE"),
        ("TAG",     "TAG"),
        ("HGA",     "HGA"),
        ("GMA",     "GMA"),
    ]

    // Precompiled: token as a standalone word (no letters either side). Digits may abut it, e.g. "PSA10".
    private static let companyMatchers: [(re: NSRegularExpression, grader: String)] =
        knownCompanies.compactMap { entry in
            guard let re = try? NSRegularExpression(pattern: "(?<![A-Z])" + entry.token + "(?![A-Z])") else { return nil }
            return (re, entry.grader)
        }

    // A grade number that follows a grade word or grader token: "GEM MT 10", "GEM MINT 10", "MINT 9", "PSA 10".
    // Group 1 is the number; only 1...10 (with optional .5, or 10.0) can match, so cert digit-runs never do.
    private static let gradeAnchored = try! NSRegularExpression(
        pattern: "(?:GEM\\s*-?\\s*M(?:T|INT)|MINT|PRISTINE|GRADE|PSA|BGS|CGC|SGC)\\s*[:.\\-]?\\s*(10(?:\\.0)?|[1-9](?:\\.5)?)")

    // A line that is only the big printed grade: "10", "9.5".
    private static let gradeStandalone = try! NSRegularExpression(
        pattern: "^\\s*(10(?:\\.0)?|[1-9](?:\\.5)?)\\s*$")

    // Fraction of the frame height, measured from the top, that the OCR scans. The label band sits across
    // the top of a slab; restricting the region speeds recognition and ignores the card art below.
    private static let labelBandFraction: CGFloat = 0.25

    // MARK: - Public

    static func read(_ pixelBuffer: CVPixelBuffer,
                     orientation: CGImagePropertyOrientation,
                     completion: @escaping (SlabInfo?) -> Void) {
        queue.async {
            var cert: String? = nil
            var lines: [String] = []

            // Barcode: graded slabs encode the numeric cert. Keep the longest all-digit payload.
            let barcode = VNDetectBarcodesRequest { req, _ in
                let payloads = (req.results as? [VNBarcodeObservation] ?? [])
                    .compactMap { $0.payloadStringValue }
                cert = payloads
                    .filter { !$0.isEmpty && $0.unicodeScalars.allSatisfy { CharacterSet.decimalDigits.contains($0) } }
                    .max(by: { $0.count < $1.count })
            }

            // OCR the top band only. .accurate reads the label reliably; codes/short words don't want correction.
            let text = VNRecognizeTextRequest { req, _ in
                lines = (req.results as? [VNRecognizedTextObservation] ?? [])
                    .compactMap { $0.topCandidates(1).first?.string }
            }
            text.recognitionLevel = .accurate
            text.usesLanguageCorrection = false
            text.recognitionLanguages = ["en-US"]
            // regionOfInterest is normalised with origin at lower-left in the *oriented* image, so the top
            // band is the highest slice of y. (Vision applies `orientation`, so this holds for any device tilt.)
            text.regionOfInterest = CGRect(x: 0,
                                           y: 1.0 - labelBandFraction,
                                           width: 1.0,
                                           height: labelBandFraction)

            // Both requests share one handler pass; each carries its own regionOfInterest.
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
            do {
                try handler.perform([barcode, text])
            } catch {
                completion(nil)      // fail gracefully; treat an unreadable frame as "not a slab"
                return
            }

            let company = detectCompany(in: lines)
            let grade = detectGrade(in: lines)

            // Does this look like a slab at all? A named grader, or a grade backed by a barcode cert.
            let looksLikeSlab = (company != nil) || (grade != nil && cert != nil)
            guard looksLikeSlab else { completion(nil); return }        // raw card

            // We report a grader only when we actually identified the company; never guess it.
            guard let grader = company else { completion(nil); return }

            completion(SlabInfo(grader: grader, grade: grade ?? "", cert: cert))
        }
    }

    // MARK: - Parsing

    private static func detectCompany(in lines: [String]) -> String? {
        let text = lines.joined(separator: " ").uppercased()
        let range = NSRange(text.startIndex..., in: text)
        for m in companyMatchers where m.re.firstMatch(in: text, range: range) != nil {
            return m.grader
        }
        return nil
    }

    private static func detectGrade(in lines: [String]) -> String? {
        // 1) Prefer a number anchored to a grade word / grader ("GEM MT 10", "MINT 9", "PSA 10").
        let joined = lines.joined(separator: " ").uppercased()
        if let g = firstGroup(gradeAnchored, in: joined) { return normalizeGrade(g) }

        // 2) Fall back to a line that is just the big printed grade ("10", "9.5").
        for line in lines {
            if let g = firstGroup(gradeStandalone, in: line.uppercased()) { return normalizeGrade(g) }
        }
        return nil
    }

    // "10.0" -> "10"; "9.5" and "9" stay as-is.
    private static func normalizeGrade(_ raw: String) -> String {
        raw.hasSuffix(".0") ? String(raw.dropLast(2)) : raw
    }

    // First capture group of the first match, or nil.
    private static func firstGroup(_ re: NSRegularExpression, in s: String) -> String? {
        let range = NSRange(s.startIndex..., in: s)
        guard let m = re.firstMatch(in: s, range: range),
              m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }
}
