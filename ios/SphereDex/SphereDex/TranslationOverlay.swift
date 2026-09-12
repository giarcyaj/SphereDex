import UIKit

/// Live "AR" translation overlay: a branded floating panel that shows the English name / number / price
/// of a detected card, hovering over the card in the camera preview (SphereDex tracks English vs Japanese
/// editions, so this reads a Japanese card and floats the English info above it, Dragon-Shield style).
///
/// Pure UIKit, no camera code. Add it as a full-bleed sibling on top of the preview; it never eats touches
/// (isUserInteractionEnabled = false) so the scanner's close button underneath still works. `show(...)` is
/// safe to call from any thread (e.g. a Vision completion on a background queue) — it hops to main itself.
final class TranslationOverlay: UIView {

    // MARK: - Public API

    /// Show / move the panel for a card. `rect` is the card's frame in THIS view's coordinate space.
    /// First call animates in; later calls smoothly follow the moving card.
    func show(name: String, number: String, price: String?, at rect: CGRect) {
        onMain { self.applyShow(name: name, number: number, price: price, at: rect) }
    }

    /// Animate the panel out (no-op if already hidden). Safe from any thread.
    func hide() {
        onMain { self.applyHide() }
    }

    // MARK: - Look & feel

    private let corner: CGFloat = 12
    private let insetH: CGFloat = 14           // panel content horizontal padding
    private let insetV: CGFloat = 11           // panel content vertical padding
    private let preferredWidth: CGFloat = 260  // capped again to the view width at layout time
    private let edgeMargin: CGFloat = 12       // keep the panel this far off the view edges
    private let cardGap: CGFloat = 12          // gap between the card rect and the panel

    private static let navy  = UIColor(red: 10/255, green: 15/255, blue: 30/255, alpha: 0.9) // branded dark card
    private static let cyan  = UIColor(red: 0x22/255, green: 0xd3/255, blue: 0xee/255, alpha: 1) // #22d3ee accent

    // MARK: - Subviews (built once, reused)

    private let panel = UIView()
    private let clip  = UIView()                                                   // rounds + borders the fill
    private let blur  = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark)) // subtle depth
    private let tint  = UIView()                                                   // navy fill over the blur
    private let stack = UIStackView()                                              // vertical: name + meta row
    private let metaRow = UIStackView()                                            // horizontal: number | price
    private let nameLabel   = UILabel()
    private let numberLabel = UILabel()
    private let priceLabel  = UILabel()

    private var visible = false   // is the panel currently shown? drives "animate in" vs "follow"

    // MARK: - Init

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        isUserInteractionEnabled = false        // purely informational; let touches fall through
        backgroundColor = .clear

        // Panel: carries the drop shadow (so it must NOT clip); the inner `clip` view rounds the fill.
        panel.backgroundColor = .clear
        panel.isHidden = true
        panel.layer.shadowColor = UIColor.black.cgColor
        panel.layer.shadowOpacity = 0.35
        panel.layer.shadowRadius = 10
        panel.layer.shadowOffset = CGSize(width: 0, height: 4)
        panel.layer.masksToBounds = false
        addSubview(panel)

        clip.translatesAutoresizingMaskIntoConstraints = false
        clip.layer.cornerRadius = corner
        clip.layer.cornerCurve = .continuous
        clip.layer.masksToBounds = true
        clip.layer.borderWidth = 1                                  // thin cyan hairline
        clip.layer.borderColor = Self.cyan.withAlphaComponent(0.7).cgColor
        panel.addSubview(clip)

        blur.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(blur)

        tint.translatesAutoresizingMaskIntoConstraints = false
        tint.backgroundColor = Self.navy
        clip.addSubview(tint)

        // Labels
        nameLabel.font = .systemFont(ofSize: 16, weight: .bold)
        nameLabel.textColor = .white
        nameLabel.numberOfLines = 2
        nameLabel.lineBreakMode = .byTruncatingTail

        numberLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        numberLabel.textColor = Self.cyan
        numberLabel.numberOfLines = 1
        numberLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)       // expand, push price to trailing

        priceLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        priceLabel.textColor = .white
        priceLabel.numberOfLines = 1
        priceLabel.textAlignment = .right
        priceLabel.setContentHuggingPriority(.required, for: .horizontal)
        priceLabel.setContentCompressionResistancePriority(.required, for: .horizontal) // never clip the price

        metaRow.axis = .horizontal
        metaRow.alignment = .firstBaseline
        metaRow.spacing = 8
        metaRow.addArrangedSubview(numberLabel)
        metaRow.addArrangedSubview(priceLabel)

        stack.axis = .vertical
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(nameLabel)
        stack.addArrangedSubview(metaRow)
        clip.addSubview(stack)

        NSLayoutConstraint.activate([
            clip.leadingAnchor.constraint(equalTo: panel.leadingAnchor),
            clip.trailingAnchor.constraint(equalTo: panel.trailingAnchor),
            clip.topAnchor.constraint(equalTo: panel.topAnchor),
            clip.bottomAnchor.constraint(equalTo: panel.bottomAnchor),

            blur.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            blur.topAnchor.constraint(equalTo: clip.topAnchor),
            blur.bottomAnchor.constraint(equalTo: clip.bottomAnchor),

            tint.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            tint.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            tint.topAnchor.constraint(equalTo: clip.topAnchor),
            tint.bottomAnchor.constraint(equalTo: clip.bottomAnchor),

            stack.leadingAnchor.constraint(equalTo: clip.leadingAnchor, constant: insetH),
            stack.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -insetH),
            stack.topAnchor.constraint(equalTo: clip.topAnchor, constant: insetV),
            stack.bottomAnchor.constraint(equalTo: clip.bottomAnchor, constant: -insetV),
        ])
    }

    // MARK: - Show / hide (main thread)

    private func applyShow(name: String, number: String, price: String?, at rect: CGRect) {
        nameLabel.text = name
        numberLabel.text = number
        let trimmedPrice = price?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let p = trimmedPrice, !p.isEmpty {
            priceLabel.text = p
            priceLabel.isHidden = false
        } else {
            priceLabel.text = nil
            priceLabel.isHidden = true              // excluded from the stack layout when empty
        }
        // A11y: read the whole panel as one phrase rather than three fragments.
        panel.isAccessibilityElement = true
        panel.accessibilityLabel = [name, number, priceLabel.isHidden ? nil : priceLabel.text]
            .compactMap { $0 }.joined(separator: ", ")

        let frame = panelFrame(for: rect)
        // Shadow needs an explicit path because the panel background is clear (nothing to derive it from).
        panel.layer.shadowPath = UIBezierPath(
            roundedRect: CGRect(origin: .zero, size: frame.size), cornerRadius: corner).cgPath

        if visible {
            // Already on screen: glide to the card's new position.
            UIView.animate(withDuration: 0.15, delay: 0,
                           options: [.beginFromCurrentState, .curveEaseOut]) {
                self.panel.frame = frame
            }
        } else {
            // First appearance: pop in with a slight scale + fade.
            visible = true
            panel.transform = .identity
            panel.frame = frame
            panel.alpha = 0
            panel.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
            panel.isHidden = false
            UIView.animate(withDuration: 0.2, delay: 0,
                           usingSpringWithDamping: 0.85, initialSpringVelocity: 0.6,
                           options: [.beginFromCurrentState, .curveEaseOut]) {
                self.panel.alpha = 1
                self.panel.transform = .identity
            }
        }
    }

    private func applyHide() {
        guard visible else { return }
        visible = false
        UIView.animate(withDuration: 0.15, delay: 0,
                       options: [.beginFromCurrentState, .curveEaseIn]) {
            self.panel.alpha = 0
            self.panel.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
        } completion: { _ in
            // Only truly hide if a show() didn't race back in during the fade.
            if !self.visible { self.panel.isHidden = true }
        }
    }

    // MARK: - Layout maths

    /// Frame for the panel: sized to its content at a capped width, centred over the card and placed just
    /// above it — or below when there's no room up top — then clamped inside the view with a small margin.
    private func panelFrame(for rect: CGRect) -> CGRect {
        let bw = bounds.width, bh = bounds.height
        let maxWidth = max(160, bw - edgeMargin * 2)                // never wider than the view (minus margins)
        let width = min(preferredWidth, maxWidth)

        // Constrain wrapping before measuring height.
        nameLabel.preferredMaxLayoutWidth = width - insetH * 2
        let fit = panel.systemLayoutSizeFitting(
            CGSize(width: width, height: 0),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        let height = max(1, fit.height)

        // Horizontal: centre on the card, then clamp inside the margins.
        var x = rect.midX - width / 2
        let maxX = max(edgeMargin, bw - edgeMargin - width)
        x = min(max(edgeMargin, x), maxX)

        // Vertical: prefer above the card; drop below if it would clip the top; clamp either way.
        var y = rect.minY - cardGap - height
        if y < edgeMargin {
            y = rect.maxY + cardGap
            if y + height > bh - edgeMargin { y = max(edgeMargin, bh - edgeMargin - height) }
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    // MARK: - Helpers

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }
}