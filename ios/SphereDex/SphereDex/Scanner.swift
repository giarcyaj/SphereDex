import UIKit
import AVFoundation
import Vision

// Card numbers: E + set-code letters + optional set digits + optional hyphen + 3 digits + optional rarity letters.
// e.g. EBP01-001, EBP01001, EBP01-001OSR, ETD01-001TSR, EPR-001.
private let cardNumberRegex = try! NSRegularExpression(pattern: "E[A-Z]{1,5}\\d{0,2}-?\\d{3}[A-Z]{0,3}")

func extractCardNumber(from text: String) -> String? {
    let t = text.uppercased().replacingOccurrences(of: " ", with: "")
    let range = NSRange(t.startIndex..., in: t)
    guard let m = cardNumberRegex.firstMatch(in: t, range: range),
          let r = Range(m.range, in: t) else { return nil }
    return String(t[r])
}

/// Full-screen live camera scanner. Reads text with on-device Vision OCR, extracts a card number,
/// resolves it to a real card, and returns that card's canonical number. One result, then it closes,
/// so the web app shows a single rich confirmation (image, condition, which collection).
final class ScannerViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {

    private let resolver: CardResolver
    private let onResult: (String?) -> Void

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "app.spheredex.camera")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var finished = false

    init(resolver: CardResolver, onResult: @escaping (String?) -> Void) {
        self.resolver = resolver
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
                DispatchQueue.main.async { granted ? self?.configureSession() : self?.showMessage("Camera access is needed to scan cards. Enable it in Settings.") }
            }
        default:
            showMessage("Camera access is needed to scan cards. Enable it in Settings.")
        }

        addOverlay()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    // MARK: - Camera

    private func configureSession() {
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720
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

    // MARK: - Overlay (dim scrim + reticle + hint + close)

    private func addOverlay() {
        let reticle = UIView()
        reticle.layer.borderColor = UIColor.white.cgColor
        reticle.layer.borderWidth = 3
        reticle.layer.cornerRadius = 14
        reticle.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(reticle)
        NSLayoutConstraint.activate([
            reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticle.topAnchor.constraint(equalTo: view.centerYAnchor, constant: -60),
            reticle.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.82),
            reticle.heightAnchor.constraint(equalTo: reticle.widthAnchor, multiplier: 0.26),
        ])

        let hint = UILabel()
        hint.text = "Line up the card number in the box"
        hint.textColor = .white
        hint.font = .systemFont(ofSize: 15, weight: .medium)
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        NSLayoutConstraint.activate([
            hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 28),
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

    @objc private func cancelTapped() { finish(nil) }

    private func finish(_ number: String?) {
        DispatchQueue.main.async {
            if self.finished { return }
            self.finished = true
            if number != nil { UINotificationFeedbackGenerator().notificationOccurred(.success) }
            self.dismiss(animated: true) { self.onResult(number) }
        }
    }

    // MARK: - OCR

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        if finished { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNRecognizeTextRequest { [weak self] req, _ in
            guard let self, !self.finished else { return }
            let lines = (req.results as? [VNRecognizedTextObservation] ?? [])
                .compactMap { $0.topCandidates(1).first?.string }
            for line in lines {
                guard let raw = extractCardNumber(from: line) else { continue }
                if let card = self.resolver.resolve(raw) {
                    self.finish(card)
                    break
                }
            }
        }
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right).perform([request])
    }
}
