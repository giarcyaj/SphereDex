import Foundation
import CoreGraphics
import CoreVideo
import ImageIO
import Vision

/// Detects the Palworld "Dawn of Palpagos" 2nd-edition mark: a small Roman-numeral "II"
/// printed next to the copyright line in the BOTTOM-RIGHT corner of the card. The two
/// editions are otherwise pixel-identical, so this is the only tell.
///
/// Deliberately conservative — a false positive (calling a 1st edition a 2nd) is worse than
/// a miss, so we return 2 only when the top OCR candidate for a corner token is exactly "II"
/// (case-sensitive, two uppercase I). Everything else, and any failure, returns 1.
enum EditionDetector {

    // Bottom-right corner of the UPRIGHT card, where the "II" sits by the copyright line.
    // Normalized in Vision's region-of-interest space (origin bottom-left, y points UP), so
    // "bottom" means low y. Right ~30% width x bottom ~14% height. Tune if the mark moves or
    // the reticle framing changes. VNImageRequestHandler applies `orientation` before this ROI,
    // so it always refers to the card the right way up regardless of device rotation.
    private static let cornerROI = CGRect(x: 0.70, y: 0.0, width: 0.30, height: 0.14)

    // The mark is tiny in-frame; relative to full image height (not the ROI). Small enough to
    // catch it, not so small it invents letters from JPEG noise.
    private static let minTextHeight: Float = 0.012

    // Heavy work stays off the main thread.
    private static let queue = DispatchQueue(label: "app.spheredex.edition", qos: .userInitiated)

    /// Returns 2 if a standalone "II" is clearly detected in the bottom-right corner, else 1.
    /// Runs on a background queue and calls `completion` exactly once.
    static func detect(_ pixelBuffer: CVPixelBuffer,
                       orientation: CGImagePropertyOrientation,
                       completion: @escaping (_ edition: Int) -> Void) {
        queue.async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate          // .fast misses the small glyphs
            request.usesLanguageCorrection = false         // "II" is not a word; don't autocorrect it away
            request.minimumTextHeight = minTextHeight
            request.recognitionLanguages = ["en-US"]
            request.regionOfInterest = cornerROI           // read only the corner, not the whole card

            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
            do {
                try handler.perform([request])
            } catch {
                completion(1)                              // any Vision failure -> conservative default
                return
            }

            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            for obs in observations {
                // Top candidate only: extra candidates raise the false-positive risk we most want to avoid.
                guard let text = obs.topCandidates(1).first?.string else { continue }
                if isEditionII(text) {
                    completion(2)
                    return
                }
            }
            completion(1)
        }
    }

    /// True only when a whitespace-separated token, with surrounding punctuation trimmed, is
    /// exactly "II". Case-sensitive so lowercase "ll" noise is rejected; "11", "H" and "III"
    /// all fail the exact match too.
    private static func isEditionII(_ text: String) -> Bool {
        let punctuation = CharacterSet.alphanumerics.inverted
        for token in text.split(whereSeparator: { $0.isWhitespace }) {
            // Strip leading/trailing symbols like "(II)" or "II." but keep the core, case intact.
            let core = String(token).trimmingCharacters(in: punctuation)
            if core == "II" { return true }
        }
        return false
    }
}
