import Foundation
import Vision
import CoreVideo
import CoreImage

// Detects a graded slab in a camera frame and reads its label: grading company, numeric grade, the cert
// number (from the label barcode / QR), and the OCR lines of the label band. Returns nil only when the
// frame shows no slab signal at all (i.e. it looks like a raw card). Mirrors Android SlabReader.

/// Grading label read off a slab: company (normalised; "Other" when the frame is clearly a slab but the
/// company could not be read, so the popup asks), grade ("10"/"9.5"/"9" or ""), numeric cert or nil, and
/// the OCR lines of the label band. The label prints the card's name and number in clean, high contrast
/// type, so the scanner identifies a slabbed card from THESE lines instead of trying to read the card
/// through the plastic (glare + the label covering the top is what used to defeat graded cards).
struct SlabInfo {
    let grader: String          // canonical grader, e.g. "PSA", "BGS", "CGC"; "Other" when unread on a clear slab
    let grade: String           // normalised grade, e.g. "10", "9.5", "9" ("" when no grade could be read)
    let cert: String?           // certification number from the barcode / QR, if one decoded
    let labelLines: [String]    // OCR lines of the label band (never sent to the web app; scanner use only)

    init(grader: String, grade: String, cert: String?, labelLines: [String] = []) {
        self.grader = grader
        self.grade = grade
        self.cert = cert
        self.labelLines = labelLines
    }
}

enum SlabReader {

    // MARK: - Tunables

    // Grading companies we recognise on a slab label, paired with the canonical grader we report.
    // Order = match priority: ambiguous short tokens (ACE, TAG) are last so a more specific company wins
    // first. BECKETT is Beckett Grading Services and is reported as BGS. Add rows here to support more graders.
    private static let knownCompanies: [(token: String, grader: String)] = [
        ("PSA",     "PSA"),
        ("BGS",     "BGS"),
        ("BECKETT", "BGS"),
        ("CGC",     "CGC"),
        ("SGC",     "SGC"),
        ("HGA",     "HGA"),
        ("GMA",     "GMA"),
        ("ACE",     "ACE"),
        ("TAG",     "TAG"),
    ]

    // Precompiled: token with no letter either side. Digits may abut it, since OCR often merges "PSA 10"
    // into "PSA10". Same rule as Android (the text is uppercased before matching).
    private static let companyMatchers: [(re: NSRegularExpression, grader: String)] =
        knownCompanies.compactMap { entry in
            guard let re = try? NSRegularExpression(pattern: "(?<![A-Z])" + entry.token + "(?![A-Z])") else { return nil }
            return (re, entry.grader)
        }

    // Newer slabs carry a QR that encodes the grader's cert page; the host names the company for certain.
    // Order = match priority (first host found in the URL wins).
    private static let codeHosts: [(host: String, grader: String)] = [
        ("psacard.com",       "PSA"),
        ("beckett.com",       "BGS"),
        ("cgccards.com",      "CGC"),
        ("cgccomics.com",     "CGC"),
        ("sgccard.com",       "SGC"),
        ("hybridgrading.com", "HGA"),
        ("gmagrading.com",    "GMA"),
        ("acegrading.com",    "ACE"),
        ("taggrading.com",    "TAG"),
    ]

    // A run of 5+ digits inside a cert-URL payload: the cert number is usually the longest such run.
    private static let digitRun = try! NSRegularExpression(pattern: "\\d{5,}")

    // Shortest all-digit payload accepted as a cert (real certs are 7+ digits).
    private static let minCertDigits = 7

    // Retail symbologies never appear on a grading label; a booster box or price sticker in shot must
    // not turn a raw card into a slab.
    private static let retailSymbologies: [VNBarcodeSymbology] = [.ean13, .ean8, .upce]

    // Grade waterfall, most specific first (same five patterns and order as Android). Group 1 is the
    // number; only 1...10 (with optional .5, or 10.0) can match, so cert digit-runs never do.
    private static let num = "(10(?:\\.0)?|[1-9](?:\\.5)?)"
    private static let gradePatterns: [NSRegularExpression] = [
        "GEM\\s*-?\\s*MT\\s*" + num,
        "GEM\\s*MINT\\s*" + num,
        "MINT\\s*" + num,
        "\\b(?:PSA|BGS|BECKETT|CGC|SGC|ACE|TAG|HGA|GMA)\\s*" + num,
        "\\b" + num + "\\b",
    ].map { try! NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }

    // Fraction of the frame height, measured from the top, that counts as the label band. The label sits
    // across the top of a slab, and 0.40 still covers it when the whole slab is fitted in the reticle.
    // The band is what gets OCR'd and where a code has to START to count (a barcode lower down is
    // packaging or a price sticker, not a cert). Keep in step with Android LABEL_BAND.
    private static let labelBandFraction: CGFloat = 0.40

    /// What the barcode / QR pass yielded: the numeric cert and, from a cert-URL QR, the company.
    private struct CodeInfo {
        let cert: String?
        let company: String?
    }

    // MARK: - Public

    /// Synchronous probe for a caller already off the main thread (the scanner's camera sample-buffer
    /// queue). Runs the barcode pass on the full frame and OCRs the label band ONCE, on the calling
    /// thread, then reuses that text for company, grade and the card lines. Never cache the result across
    /// frames: identify is one shot, so a stale result would either let a slab finish as raw or hand the
    /// previous slab's cert to a different card.
    /// Slab signals, any one of which marks the frame as a slab: a barcode / QR on the label (the numeric
    /// cert, or the grader's cert-page URL), or a grading company printed in the label band. Grade alone
    /// never counts, since a raw card's top edge can carry a stray "10". Company priority: QR cert-URL host
    /// (certain) > label text > "Other". Returns nil when the frame shows no slab signal (a raw card).
    static func probe(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> SlabInfo? {
        var code = CodeInfo(cert: nil, company: nil)
        var lines: [String] = []

        // Barcode / QR: a numeric cert, or the grader's cert-page URL. Only codes that start inside the
        // label band count (boundingBox is normalised, origin lower-left, so the band is maxY >= 1 - band).
        let barcode = VNDetectBarcodesRequest { req, _ in
            let inBand = (req.results as? [VNBarcodeObservation] ?? [])
                .filter { $0.boundingBox.maxY >= 1.0 - labelBandFraction }
            code = parseCodes(inBand)
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

        // Two independent synchronous passes on this thread (Vision invokes the completion handlers before
        // perform returns), so a decoded barcode is kept even if the OCR pass throws. An unreadable frame
        // simply yields no signal and reads as "not a slab".
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
        try? handler.perform([barcode])
        try? handler.perform([text])

        let company = code.company ?? detectCompany(in: lines)
        if code.cert == nil && company == nil { return nil }           // no slab signal => raw card
        return SlabInfo(grader: company ?? "Other",
                        grade: detectGrade(in: lines) ?? "",
                        cert: code.cert,
                        labelLines: lines)
    }

    // MARK: - Parsing

    /// Longest all-digit payload is the cert. A URL payload (cert-page QR) names the company by its host
    /// and usually carries the cert as the longest digit run in its path. First company match wins.
    /// Retail symbologies and short digit strings never count, so a booster box, price sticker or
    /// packaging QR beside a raw card does not read as a slab.
    private static func parseCodes(_ observations: [VNBarcodeObservation]) -> CodeInfo {
        var cert: String? = nil
        var company: String? = nil
        for obs in observations {
            if retailSymbologies.contains(obs.symbology) { continue }
            guard let payload = obs.payloadStringValue else { continue }
            let raw = payload.trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.isEmpty { continue }
            if raw.unicodeScalars.allSatisfy({ CharacterSet.decimalDigits.contains($0) }) {
                if raw.count >= minCertDigits && raw.count > (cert?.count ?? 0) { cert = raw }
                continue
            }
            let lower = raw.lowercased()
            if lower.contains("://") || lower.contains("www.") || lower.contains(".com") {
                if company == nil {
                    for entry in codeHosts where lower.contains(entry.host) {
                        company = entry.grader
                        break
                    }
                }
                if let run = longestDigitRun(in: raw), run.count > (cert?.count ?? 0) { cert = run }
            }
        }
        return CodeInfo(cert: cert, company: company)
    }

    /// Longest run of 5+ digits in `s` (first one on a tie), or nil.
    private static func longestDigitRun(in s: String) -> String? {
        let range = NSRange(s.startIndex..., in: s)
        return digitRun.matches(in: s, range: range)
            .compactMap { m in Range(m.range, in: s).map { String(s[$0]) } }
            .max(by: { $0.count < $1.count })
    }

    /// First grading company token found in the label text (priority order), or nil.
    private static func detectCompany(in lines: [String]) -> String? {
        if lines.isEmpty { return nil }
        let text = lines.joined(separator: " ").uppercased()
        let range = NSRange(text.startIndex..., in: text)
        for m in companyMatchers where m.re.firstMatch(in: text, range: range) != nil {
            return m.grader
        }
        return nil
    }

    /// Grade number via the waterfall ("GEM MT 10" > "GEM MINT 10" > "MINT 9" > "PSA 10" > a bare
    /// standalone number), normalised; nil when nothing readable. Same order as Android.
    private static func detectGrade(in lines: [String]) -> String? {
        if lines.isEmpty { return nil }
        let joined = lines.joined(separator: " ")
        for re in gradePatterns {
            if let g = firstGroup(re, in: joined), !g.isEmpty { return normalizeGrade(g) }
        }
        return nil
    }

    // "10.0" -> "10", "9.0" -> "9"; "9.5" stays; junk -> "".
    private static func normalizeGrade(_ raw: String) -> String {
        guard let n = Double(raw) else { return "" }
        return n == n.rounded(.down) ? String(Int(n)) : String(n)
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
