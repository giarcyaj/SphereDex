import Foundation
import UIKit
import Vision
import ImageIO
import CoreVideo

/// On-device full-card image recognition via Vision feature prints.
///
/// Complements the OCR scanner: OCR reads the printed card number, this recognises the whole card
/// from its artwork (frame + illustration) even when the tiny number is blurred or glare-hidden.
///
/// First launch builds a reference feature print for every card image bundled inline in
/// `spheredex.html` (`window.CARD_IMG={ "EBP01-001":"data:image/jpeg;base64,..." , ... }`),
/// archives them to Application Support, and reuses that cache on later launches. Building takes
/// ~10-30s and runs entirely on a background queue; matching a live frame is fast.
///
/// Everything here is best-effort: any failure returns nil / a default rather than crashing.
final class CardImageMatcher {

    static let shared = CardImageMatcher()
    private init() {}

    // MARK: - Tunables (comment values are starting points; expect on-device tuning)

    /// VNFeaturePrintObservation L2 distances run ~0 (identical) upward; a best distance above this
    /// is treated as "no match" and yields (nil, 0). Lower = stricter.
    private static let rejectDistance: Float = 24.0

    /// Minimum distance gap between the best and second-best reference for full confidence. When the
    /// two nearest cards are almost equidistant the match is ambiguous, so confidence is scaled down.
    private static let minMargin: Float = 1.5

    /// Live-frame crop that matches the on-screen reticle: a centred, card-aspect region this wide
    /// (fraction of the oriented frame width). The reference cards are ~400x559 portrait, so the crop
    /// is derived to the same aspect from `cardAspectRatio` at match time.
    private static let cropWidth: CGFloat = 0.82
    private static let cardAspectRatio: CGFloat = 400.0 / 559.0   // ~0.716 (portrait W/H)
    private static let maxCropHeight: CGFloat = 0.96              // never let the derived crop exceed the frame

    /// Both reference and query prints use the same crop/scale so distances are comparable.
    /// .centerCrop keeps the discriminative card centre and is the request default.
    private static let cropAndScaleOption: VNImageCropAndScaleOption = .centerCrop

    /// Bump to invalidate every cached archive after changing how prints are built.
    private static let formatVersion = 2

    // Card-number-shaped keys only (E + set letters/digits + optional hyphen + 3 digits + optional
    // rarity letters), so we capture CARD_IMG entries and skip any other data URIs in the page.
    // Groups: 1 = card number, 2 = image subtype, 3 = base64 payload. The base64 class is a simple
    // one-or-more with no ambiguity, so there is no catastrophic backtracking on the ~16MB input.
    private static let entryRegex = try! NSRegularExpression(
        pattern: "\"(E[A-Z0-9]{1,8}-?[0-9]{3}[A-Z]{0,4})\":\"data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)\"")

    // MARK: - State (guarded by `lock`)

    private let lock = NSLock()
    private var references: [String: VNFeaturePrintObservation] = [:]
    private var built = false        // true once references are loaded/computed
    private var preparing = false    // true while a build/load is in flight (idempotency)

    // Serial background queue: the one-time build and every match run here, so heavy Vision work
    // never touches the main thread and never overlaps itself.
    private let queue = DispatchQueue(label: "app.spheredex.cardmatch", qos: .userInitiated)

    /// True once reference prints are available for matching.
    var isReady: Bool {
        lock.lock(); defer { lock.unlock() }
        return built
    }

    // MARK: - Prepare

    /// Kick off (once) the first-launch reference build / cache load on a background queue. Idempotent:
    /// repeated calls while ready or already preparing do nothing.
    func prepare() {
        lock.lock()
        if built || preparing { lock.unlock(); return }
        preparing = true
        lock.unlock()
        queue.async { [weak self] in self?.buildOrLoad() }
    }

    private func buildOrLoad() {
        var prints = loadCache()
        if prints == nil {
            prints = buildReferences()
            if let p = prints, !p.isEmpty { saveCache(p) }
        }
        let result = prints ?? [:]
        lock.lock()
        references = result
        built = !result.isEmpty          // stay not-ready on total failure so a later prepare() retries
        preparing = false
        lock.unlock()
        print("CardImageMatcher: ready with \(result.count) reference prints")
    }

    // MARK: - Match

    /// Recognise the card centred in `pixelBuffer`. Computes the frame's feature print over a centred,
    /// card-aspect crop (respecting `orientation`) and returns the nearest reference. `completion` is
    /// called exactly once, on a background queue, with the card number and a confidence in 0...1
    /// (nil / low confidence when nothing matches well or the two best candidates are too close).
    func match(_ pixelBuffer: CVPixelBuffer,
               orientation: CGImagePropertyOrientation,
               completion: @escaping (_ cardNumber: String?, _ confidence: Float) -> Void) {
        lock.lock(); let ready = built; lock.unlock()
        guard ready else { completion(nil, 0); return }   // don't block a scanning frame before we're built

        queue.async { [weak self] in
            guard let self = self else { completion(nil, 0); return }
            self.lock.lock(); let refs = self.references; self.lock.unlock()   // cheap COW snapshot
            guard !refs.isEmpty else { completion(nil, 0); return }

            let roi = Self.cropRect(for: pixelBuffer, orientation: orientation)
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
            guard let query = self.featurePrint(handler, roi: roi) else { completion(nil, 0); return }

            // Nearest and second-nearest reference by feature-print distance.
            var bestNumber: String?
            var best: Float = .greatestFiniteMagnitude
            var second: Float = .greatestFiniteMagnitude
            for (number, ref) in refs {
                var dist: Float = 0
                do { try query.computeDistance(&dist, to: ref) } catch { continue } // e.g. revision mismatch
                if dist < best {
                    second = best; best = dist; bestNumber = number
                } else if dist < second {
                    second = dist
                }
            }

            guard let number = bestNumber, best <= Self.rejectDistance else {
                completion(nil, 0)
                return
            }
            // Closeness of the top hit, dampened when the runner-up is nearly as close (ambiguous).
            let closeness = max(0, 1 - best / Self.rejectDistance)
            let margin = second.isFinite ? (second - best) : Self.minMargin
            let marginFactor = max(0, min(1, margin / Self.minMargin))
            let confidence = max(0, min(1, closeness * marginFactor))
            completion(number, confidence)
        }
    }

    // MARK: - Feature prints

    /// Run a feature-print request through `handler`, optionally limited to `roi`. Returns nil on error.
    private func featurePrint(_ handler: VNImageRequestHandler, roi: CGRect?) -> VNFeaturePrintObservation? {
        let request = VNGenerateImageFeaturePrintRequest()
        request.imageCropAndScaleOption = Self.cropAndScaleOption
        if let roi = roi { request.regionOfInterest = roi }
        do { try handler.perform([request]) } catch { return nil }
        return request.results?.first as? VNFeaturePrintObservation
    }

    /// Centred, card-aspect region of interest (Vision normalized coords, lower-left origin) sized to
    /// the reticle. Height is derived from the oriented frame's pixel dimensions so the crop keeps the
    /// portrait card aspect regardless of frame resolution/orientation.
    private static func cropRect(for pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> CGRect {
        let w = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let h = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        // Orientation rotates the image; width/height swap for the quarter-turn orientations.
        let swapped: Bool
        switch orientation {
        case .left, .right, .leftMirrored, .rightMirrored: swapped = true
        default: swapped = false
        }
        let orientedW = swapped ? h : w
        let orientedH = swapped ? w : h
        guard orientedW > 0, orientedH > 0 else { return CGRect(x: 0, y: 0, width: 1, height: 1) }

        let cw = cropWidth
        // roiW * orientedW / (roiH * orientedH) == cardAspectRatio  ->  solve for normalized roiH.
        var ch = cw * orientedW / (cardAspectRatio * orientedH)
        ch = min(ch, maxCropHeight)
        let x = (1 - cw) / 2
        let y = (1 - ch) / 2
        return CGRect(x: x, y: y, width: cw, height: ch)
    }

    // MARK: - Reference build (from the bundled HTML)

    /// Parse every CARD_IMG data-URI out of the bundled HTML and compute a feature print for each.
    /// Returns nil only if the HTML can't be read at all.
    private func buildReferences() -> [String: VNFeaturePrintObservation]? {
        guard let url = Self.htmlURL(),
              let html = try? String(contentsOf: url, encoding: .utf8) else {
            print("CardImageMatcher: could not read spheredex.html")
            return nil
        }

        var result: [String: VNFeaturePrintObservation] = [:]
        let full = NSRange(html.startIndex..., in: html)
        Self.entryRegex.enumerateMatches(in: html, options: [], range: full) { m, _, _ in
            // Per-entry pool: base64 strings + decoded Data + CGImages are large; free them promptly.
            autoreleasepool {
                guard let m = m,
                      let numberRange = Range(m.range(at: 1), in: html),
                      let b64Range = Range(m.range(at: 3), in: html) else { return }
                let number = String(html[numberRange])
                let base64 = String(html[b64Range])
                guard result[number] == nil,
                      let cgImage = Self.decodeImage(base64: base64) else { return }
                let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
                if let fp = self.featurePrint(handler, roi: nil) {
                    result[number] = fp
                }
            }
        }
        print("CardImageMatcher: computed \(result.count) reference prints from HTML")
        return result
    }

    /// Decode a base64 image payload (jpeg / png / webp) to a CGImage via ImageIO. iOS 15 decodes
    /// WebP natively, so one path handles every bundled format. Returns nil on any decode failure.
    private static func decodeImage(base64: String) -> CGImage? {
        guard let data = Data(base64Encoded: base64),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    // MARK: - Disk cache (Application Support)

    /// A miss (nil) means "rebuild": missing file, unreadable, or a stale key (HTML changed, feature-
    /// print revision changed, or format bumped). The key is encoded in the filename, so a change just
    /// produces a different filename and the old archives are pruned.
    private func loadCache() -> [String: VNFeaturePrintObservation]? {
        guard let url = Self.cacheURL(),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return nil }
        do {
            let dict = try NSKeyedUnarchiver.unarchivedDictionary(
                ofKeyClass: NSString.self, objectClass: VNFeaturePrintObservation.self, from: data)
            guard let dict = dict, !dict.isEmpty else { return nil }
            var out: [String: VNFeaturePrintObservation] = [:]
            out.reserveCapacity(dict.count)
            for (k, v) in dict { out[k as String] = v }
            print("CardImageMatcher: loaded \(out.count) reference prints from cache")
            return out
        } catch {
            return nil
        }
    }

    private func saveCache(_ prints: [String: VNFeaturePrintObservation]) {
        guard let url = Self.cacheURL() else { return }
        do {
            let data = try NSKeyedArchiver.archivedData(
                withRootObject: prints as NSDictionary, requiringSecureCoding: true)
            try data.write(to: url, options: .atomic)
            Self.pruneStaleCaches(keeping: url)
            print("CardImageMatcher: cached \(prints.count) reference prints")
        } catch {
            print("CardImageMatcher: cache write failed (\(error))")
        }
    }

    // MARK: - Paths / cache key

    private static func htmlURL() -> URL? {
        Bundle.main.url(forResource: "spheredex", withExtension: "html")
    }

    private static func cacheDirectory() -> URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        let dir = base.appendingPathComponent("CardImageMatcher", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Cache filename encodes what would invalidate it: format version, the live feature-print
    /// revision (so an OS bump that changes the default rebuilds), and the HTML size (so a card/art
    /// update rebuilds). Distances are only comparable within one revision, so this keeps them aligned.
    private static func cacheURL() -> URL? {
        guard let dir = cacheDirectory() else { return nil }
        let revision = VNGenerateImageFeaturePrintRequest().revision
        var htmlSize = 0
        if let url = htmlURL(), let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
            htmlSize = size ?? 0
        }
        let name = "cardprints-v\(formatVersion)-r\(revision)-s\(htmlSize).archive"
        return dir.appendingPathComponent(name)
    }

    /// Remove any older archive files so the cache directory doesn't accumulate stale builds.
    private static func pruneStaleCaches(keeping current: URL) {
        guard let dir = cacheDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return }
        for file in files where file.lastPathComponent.hasPrefix("cardprints-")
            && file.lastPathComponent != current.lastPathComponent {
            try? FileManager.default.removeItem(at: file)
        }
    }
}