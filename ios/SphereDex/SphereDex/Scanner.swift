import UIKit
import AVFoundation
import Vision
import QuartzCore

// Card numbers: E + set-code letters + optional set digits + optional hyphen + 3 digits + optional rarity letters.
// e.g. EBP01-001, EBP01001, EBP01-001OSR, ETD01-001TSR, EPR-001.
private let cardNumberRegex = try! NSRegularExpression(pattern: "E[A-Z]{1,4}\\d{0,2}-?\\d{3}[A-Z]{0,3}")

func extractCardNumber(from text: String) -> String? {
    let t = text.uppercased().replacingOccurrences(of: " ", with: "")
    let range = NSRange(t.startIndex..., in: t)
    guard let m = cardNumberRegex.firstMatch(in: t, range: range),
          let r = Range(m.range, in: t) else { return nil }
    return String(t[r])
}

/// Everything the redesigned confirm popup needs from one scan.
struct ScanOutcome {
    let number: String        // canonical card number
    let edition: Int          // 1 (default) or 2 (the "II" reprint)
    let slab: SlabInfo?       // graded-slab label (grader/grade/cert + label lines), or nil for a raw card
    let lowConfidence: Bool   // weak match -> the popup opens its variant picker to confirm
}

/// Full-screen live camera scanner with two modes:
///   "code" - Vision OCR of the printed card number (original, always reliable).
///   "full" - label-first slab detection, then OCR of the printed number / name, then on-device
///            whole-card image recognition (CardImageMatcher) with a live English AR overlay.
/// In full mode each frame is first probed for a graded slab (barcode/QR or a grading company in the
/// label band); a slab is identified from its LABEL's own lines and its grader/grade/cert carried through
/// to whichever step identifies the card. Once a card is identified it also reads the 2nd-edition "II"
/// mark, then returns the whole ScanOutcome so the web app shows its rich confirmation. Tap anywhere to
/// force a scan of the current frame; after Add/Cancel the web app reopens the camera (the continuous loop).
final class ScannerViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate, UIGestureRecognizerDelegate {

    private let resolver: CardResolver
    private let onResult: (ScanOutcome?) -> Void
    private var mode: String
    private let showToggle: Bool

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "app.spheredex.camera")
    private var previewLayer: AVCaptureVideoPreviewLayer?

    private var finished = false
    private var processing = false          // finalising a candidate (edition); blocks new work
    private var forceCapture = false        // set on tap (camera queue); next frame is a deliberate capture
    private var lastFullMatch: TimeInterval = 0   // throttle full-mode live image matching (camera queue only)

    // Overlay pieces
    private let reticle = UIView()
    private let hintLabel = UILabel()
    private let overlay = TranslationOverlay()
    private let toggleBar = UIStackView()
    private let flashView = UIView()

    // Auto-accept an image match at/above this confidence; below it, wait for a stronger frame or a tap.
    private static let autoAcceptConfidence: Float = 0.62
    // Show the AR label once a match is at least this confident (lower than auto-accept, so it appears early).
    private static let overlayConfidence: Float = 0.35
    private static let fullMatchInterval: TimeInterval = 0.25

    init(resolver: CardResolver, mode: String = "full", showToggle: Bool = true,
         onResult: @escaping (ScanOutcome?) -> Void) {
        self.resolver = resolver
        self.mode = (mode == "code") ? "code" : "full"
        self.showToggle = showToggle
        self.onResult = onResult
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    granted ? self?.configureSession()
                            : self?.showMessage("Camera access is needed to scan cards. Enable it in Settings.")
                }
            }
        default:
            showMessage("Camera access is needed to scan cards. Enable it in Settings.")
        }

        addOverlay()
        let tap = UITapGestureRecognizer(target: self, action: #selector(screenTapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        view.addGestureRecognizer(tap)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        overlay.frame = view.bounds
        flashView.frame = view.bounds
        layoutReticle()
    }

    // Don't let the full-screen tap gesture swallow taps meant for the close button or mode toggle.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        return !(touch.view is UIControl)
    }

    // MARK: - Camera

    private func configureSession() {
        session.beginConfiguration()
        // Prefer 1080p so a small printed card number keeps enough pixels to read; fall back if unsupported.
        session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .hd1280x720
        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let input = try? AVCaptureDeviceInput(device: device),
           session.canAddInput(input) {
            session.addInput(input)
        }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview

        queue.async { self.session.startRunning() }
    }

    // MARK: - Overlay

    private func addOverlay() {
        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(overlay)

        reticle.layer.borderColor = UIColor.white.cgColor
        reticle.layer.borderWidth = 3
        reticle.layer.cornerRadius = 14
        reticle.isUserInteractionEnabled = false
        view.addSubview(reticle)

        hintLabel.textColor = .white
        hintLabel.font = .systemFont(ofSize: 15, weight: .medium)
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)
        NSLayoutConstraint.activate([
            hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hintLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            hintLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 28),
        ])

        let close = UIButton(type: .system)
        close.setTitle("✕", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 26, weight: .semibold)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
        ])

        if showToggle { addModeToggle() }

        flashView.backgroundColor = .white
        flashView.alpha = 0
        flashView.isUserInteractionEnabled = false
        flashView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(flashView)

        updateHint()
    }

    private func addModeToggle() {
        toggleBar.axis = .horizontal
        toggleBar.distribution = .fillEqually
        toggleBar.translatesAutoresizingMaskIntoConstraints = false
        toggleBar.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        toggleBar.layer.cornerRadius = 12
        toggleBar.layer.masksToBounds = true
        toggleBar.layer.borderWidth = 1
        toggleBar.layer.borderColor = UIColor.white.withAlphaComponent(0.3).cgColor
        toggleBar.addArrangedSubview(modeButton(title: "Code", value: "code"))
        toggleBar.addArrangedSubview(modeButton(title: "Full card", value: "full"))
        view.addSubview(toggleBar)
        NSLayoutConstraint.activate([
            toggleBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            toggleBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            toggleBar.heightAnchor.constraint(equalToConstant: 38),
        ])
        refreshToggle()
    }

    private func modeButton(title: String, value: String) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        b.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        b.accessibilityIdentifier = value        // stores the mode this button selects
        b.addTarget(self, action: #selector(modeButtonTapped(_:)), for: .touchUpInside)
        return b
    }

    @objc private func modeButtonTapped(_ sender: UIButton) {
        guard let value = sender.accessibilityIdentifier, value != mode else { return }
        mode = value
        refreshToggle()
        updateHint()
        layoutReticle()
        overlay.hide()
        // Throttle state lives on the camera queue; reset it there so the new mode starts fresh.
        queue.async {
            self.lastFullMatch = 0
        }
    }

    private func refreshToggle() {
        for case let b as UIButton in toggleBar.arrangedSubviews {
            let on = (b.accessibilityIdentifier == mode)
            b.backgroundColor = on ? UIColor(red: 0.13, green: 0.89, blue: 0.96, alpha: 0.9) : .clear
            b.setTitleColor(on ? UIColor(red: 0.02, green: 0.13, blue: 0.16, alpha: 1) : .white, for: .normal)
        }
    }

    private func layoutReticle() {
        let w = view.bounds.width
        let cardW = w * 0.82
        let rw = cardW
        let rh: CGFloat
        if mode == "code" {
            rh = rw * 0.22                                            // a wide, short strip for the number
        } else {
            rh = min(rw / (400.0 / 559.0), view.bounds.height * 0.7) // a full portrait card frame
        }
        reticle.frame = CGRect(x: (w - rw) / 2, y: view.bounds.midY - rh / 2, width: rw, height: rh)
    }

    private func updateHint() {
        hintLabel.text = mode == "code"
            ? "Line up the card number in the box"
            : "Fit the whole card in the frame"
    }

    private func showMessage(_ text: String) {
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        label.font = .systemFont(ofSize: 16)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 30),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -30),
        ])
    }

    // MARK: - Tap to scan + finishing

    @objc private func screenTapped() {
        if finished || processing { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        flash()
        queue.async { self.forceCapture = true }   // the next frame is treated as a deliberate capture
    }

    private func flash() {
        flashView.alpha = 0.85
        UIView.animate(withDuration: 0.28) { self.flashView.alpha = 0 }
    }

    @objc private func cancelTapped() { finish(nil) }

    private func finish(_ outcome: ScanOutcome?) {
        DispatchQueue.main.async {
            if self.finished { return }
            self.finished = true
            if outcome != nil { UINotificationFeedbackGenerator().notificationOccurred(.success) }
            self.dismiss(animated: true) { self.onResult(outcome) }
        }
    }

    // MARK: - Frame processing

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        if finished || processing { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let tapped = forceCapture
        forceCapture = false
        if mode == "code" { runOCR(pixelBuffer, forced: tapped) }
        else { runFull(pixelBuffer, forced: tapped) }
    }

    /// OCR path: read the printed number, resolve, and finalise. The slab probe runs on the same frame
    /// only once a number resolves (same as Android), so a slabbed card scanned by its code still
    /// reports its grade without paying for the probe on every frame.
    private func runOCR(_ pixelBuffer: CVPixelBuffer, forced: Bool) {
        guard let card = recogniseText(pixelBuffer, byName: false) else { return }
        identify(card, lowConfidence: false, buffer: pixelBuffer, slab: probeSlab(pixelBuffer))
    }

    /// Full mode recognition order (most reliable first):
    ///  0) SLAB: if the frame shows a graded slab (a barcode/QR, or a grading company in the label band), read
    ///     the card's number/name off the LABEL - printed, high contrast, and it names the card - rather than
    ///     off the card through the plastic, which is what used to defeat graded cards. The slab (company,
    ///     grade, cert) is carried through to whichever step identifies the card,
    ///  1) OCR the printed card NUMBER (exact),
    ///  2) OCR the printed card NAME and match the catalogue (the name is large + clear on a raw card, so
    ///     this is far more reliable than image matching; the popup's variant picker narrows the printing),
    ///  3) throttled image match for cards whose text is not legible (glare, a slab) - it drives the live
    ///     English overlay and only auto-accepts a confident card; a tap accepts the best current match,
    ///     flagged low-confidence when weak.
    private func runFull(_ pixelBuffer: CVPixelBuffer, forced: Bool) {
        let slab = probeSlab(pixelBuffer)
        if let slab = slab {
            if let card = numberFromLines(slab.labelLines) ?? resolver.resolveByName(slab.labelLines) {
                identify(card, lowConfidence: false, buffer: pixelBuffer, slab: slab)
                return
            }
        }

        if let card = recogniseText(pixelBuffer, byName: true) {
            identify(card, lowConfidence: false, buffer: pixelBuffer, slab: slab)
            return
        }
        if finished || processing { return }

        let now = CACurrentMediaTime()
        let shouldMatch = forced || (now - lastFullMatch) >= Self.fullMatchInterval
        guard shouldMatch, CardImageMatcher.shared.isReady else { return }
        lastFullMatch = now

        CardImageMatcher.shared.match(pixelBuffer, orientation: .right) { [weak self] number, confidence in
            guard let self = self, !self.finished, !self.processing else { return }
            guard let number = number, let card = self.resolver.resolve(number) else {
                if !forced { DispatchQueue.main.async { self.overlay.hide() } }
                return
            }
            if confidence >= Self.overlayConfidence {
                let name = self.resolver.name(for: card) ?? card
                DispatchQueue.main.async {
                    if !self.finished { self.overlay.show(name: name, number: card, price: nil, at: self.reticle.frame) }
                }
            }
            if confidence >= Self.autoAcceptConfidence {
                self.identify(card, lowConfidence: false, buffer: pixelBuffer, slab: slab)
            } else if forced {
                self.identify(card, lowConfidence: true, buffer: pixelBuffer, slab: slab)   // tap accepted a weak match
            }
        }
    }

    /// Slab probe (barcode/QR + label band OCR) on THIS frame. Never cached across frames: identify is
    /// one shot, so a stale result would either let a slab finish as raw (stale nil) or hand the previous
    /// slab's cert to a different card (stale positive). Camera queue only; the Vision perform inside
    /// SlabReader.probe is synchronous on this queue, never on main.
    private func probeSlab(_ pixelBuffer: CVPixelBuffer) -> SlabInfo? {
        SlabReader.probe(pixelBuffer, orientation: .right)
    }

    /// First card number in a list of OCR lines (the slab label) that resolves to a catalogue card.
    private func numberFromLines(_ lines: [String]) -> String? {
        for line in lines {
            guard let raw = extractCardNumber(from: line), let card = resolver.resolve(raw) else { continue }
            return card
        }
        return nil
    }

    /// One .accurate OCR pass over this frame, synchronous on the camera queue (Vision invokes the
    /// completion before perform returns): the first printed card NUMBER that resolves, else, when
    /// `byName` (full mode), the printed card NAME matched against the catalogue. The name is large and
    /// clear even when the number is not, so it is far more reliable than image feature-prints. Nil when
    /// neither reads, or when a result has already been returned.
    private func recogniseText(_ pixelBuffer: CVPixelBuffer, byName: Bool) -> String? {
        var lines: [String] = []
        let request = VNRecognizeTextRequest { req, _ in
            lines = (req.results as? [VNRecognizedTextObservation] ?? [])
                .compactMap { $0.topCandidates(1).first?.string }
        }
        // .accurate reliably reads the small printed card number that .fast misses.
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false          // card codes are not words
        request.minimumTextHeight = 0.015               // the number is small in-frame
        request.recognitionLanguages = ["en-US"]
        try? VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right).perform([request])
        if finished || processing { return nil }
        for line in lines {
            if let raw = extractCardNumber(from: line), let card = resolver.resolve(raw) { return card }
        }
        if byName, let card = resolver.resolveByName(lines) { return card }
        return nil
    }

    /// A card number was identified. Read the 2nd-edition "II" mark from the frame and attach the slab
    /// (if any) that the caller already probed on this frame, then return the whole outcome. Guarded so
    /// it only ever fires once.
    private func identify(_ number: String, lowConfidence: Bool, buffer: CVPixelBuffer, slab: SlabInfo? = nil) {
        if finished || processing { return }
        processing = true
        DispatchQueue.main.async { self.overlay.hide() }

        EditionDetector.detect(buffer, orientation: .right) { [weak self] edition in   // called exactly once
            self?.finish(ScanOutcome(number: number, edition: edition, slab: slab, lowConfidence: lowConfidence))
        }
    }
}
