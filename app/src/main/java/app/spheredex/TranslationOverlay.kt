package app.spheredex

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.animation.DecelerateInterpolator

/**
 * Branded "AR translation" overlay: draws a floating panel with the English name, card number and
 * (optional) price of a detected card, positioned over the card's rect in the camera preview.
 *
 * Sits transparent and full-screen above the [android.camera] preview. Draws nothing until [show];
 * [hide] fades it back out. All drawing is hardware-accelerated (offset shadow, no software layer).
 */
class TranslationOverlay(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    // --- unit helpers (kept as Float px for layout math) ---
    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)
    private fun sp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)

    // --- geometry constants ---
    private val margin = dp(12f)          // keep the panel this far inside the view
    private val corner = dp(12f)          // panel corner radius
    private val padH = dp(14f)            // panel inner horizontal padding
    private val padV = dp(12f)            // panel inner vertical padding
    private val gapNameNum = dp(6f)       // name -> number spacing
    private val gapNumPrice = dp(4f)      // number -> price spacing
    private val gapCard = dp(10f)         // panel -> card spacing
    private val shadowDy = dp(4f)         // fake drop-shadow offset
    private val hardMaxW = dp(360f)       // cap so the panel never gets silly-wide on tablets
    private val minW = dp(180f)

    // --- paints ---
    private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66000000 }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE60A0F1E.toInt() }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF22D3EE.toInt(); style = Paint.Style.STROKE; strokeWidth = dp(1.5f)
    }
    private val namePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt(); typeface = Typeface.DEFAULT_BOLD; textSize = sp(15f)
    }
    private val numberPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF22D3EE.toInt(); typeface = Typeface.MONOSPACE; textSize = sp(13f)
    }
    private val pricePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFCD34D.toInt(); typeface = Typeface.DEFAULT_BOLD; textSize = sp(14f)
    }

    // --- content state ---
    private var name = ""
    private var number = ""
    private var price: String? = null
    private val cardRect = RectF()

    // --- computed layout (rebuilt when dirty) ---
    private var dirty = true
    private var nameLayout: StaticLayout? = null
    private var numText: CharSequence = ""
    private var priceText: CharSequence? = null
    private val panelRect = RectF()

    // --- fade animation ---
    private var panelAlpha = 0f
    private var animator: ValueAnimator? = null

    init {
        isClickable = false
        isFocusable = false
        // full-screen but see-through; child camera views below still receive touches
        setBackgroundColor(0x00000000)
    }

    /** Show/refresh the panel for [rect] (in this view's pixels). Safe to call from any thread. */
    fun show(name: String, number: String, price: String?, rect: RectF) = onUi {
        this.name = name
        this.number = number
        this.price = price
        this.cardRect.set(rect)
        dirty = true
        invalidate()
        animateTo(1f)
    }

    /** Fade the panel out. Safe to call from any thread. */
    fun hide() = onUi { animateTo(0f) }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        dirty = true
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator?.cancel()
        animator = null
    }

    override fun onDraw(canvas: Canvas) {
        if (panelAlpha <= 0.01f || width == 0 || height == 0) return
        ensureLayout()
        val nl = nameLayout ?: return

        // Fade everything uniformly by compositing the panel through an alpha layer, bounded to the
        // panel + its offset shadow so we never allocate a full-screen offscreen buffer.
        val a = (panelAlpha * 255f).toInt().coerceIn(0, 255)
        val save = canvas.saveLayerAlpha(
            panelRect.left, panelRect.top,
            panelRect.right + dp(2f), panelRect.bottom + shadowDy + dp(2f), a
        )

        // subtle offset drop shadow
        canvas.drawRoundRect(
            panelRect.left, panelRect.top + shadowDy,
            panelRect.right, panelRect.bottom + shadowDy, corner, corner, shadowPaint
        )
        // panel body + border
        canvas.drawRoundRect(panelRect, corner, corner, fillPaint)
        canvas.drawRoundRect(panelRect, corner, corner, borderPaint)

        // text
        val textLeft = panelRect.left + padH
        var cursorY = panelRect.top + padV

        canvas.save()
        canvas.translate(textLeft, cursorY)
        nl.draw(canvas)
        canvas.restore()
        cursorY += nl.height + gapNameNum

        val nfm = numberPaint.fontMetrics
        canvas.drawText(numText, 0, numText.length, textLeft, cursorY - nfm.ascent, numberPaint)
        cursorY += (-nfm.ascent + nfm.descent)

        priceText?.let { pt ->
            cursorY += gapNumPrice
            val pfm = pricePaint.fontMetrics
            canvas.drawText(pt, 0, pt.length, textLeft, cursorY - pfm.ascent, pricePaint)
        }

        canvas.restoreToCount(save)
    }

    // --- internals ---

    /** Rebuild the panel geometry + text layouts against the current view size. Never throws. */
    private fun ensureLayout() {
        if (!dirty) return
        dirty = false

        // Panel roughly tracks the card width, clamped to a sane range that always fits the view.
        val maxW = (width - 2f * margin).coerceIn(dp(120f), hardMaxW)
        val loW = minW.coerceAtMost(maxW)
        val panelW = safeCoerce(cardRect.width(), loW, maxW)
        val textWidth = (panelW - 2f * padH).toInt().coerceAtLeast(1)

        nameLayout = StaticLayout.Builder
            .obtain(name, 0, name.length, namePaint, textWidth)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setMaxLines(2)
            .setEllipsize(TextUtils.TruncateAt.END)
            .setLineSpacing(0f, 1f)
            .setIncludePad(false)
            .build()

        numText = TextUtils.ellipsize(number, numberPaint, textWidth.toFloat(), TextUtils.TruncateAt.END)
        priceText = price?.let { TextUtils.ellipsize(it, pricePaint, textWidth.toFloat(), TextUtils.TruncateAt.END) }

        val nfm = numberPaint.fontMetrics
        val numH = -nfm.ascent + nfm.descent
        val priceH = priceText?.let { val f = pricePaint.fontMetrics; gapNumPrice + (-f.ascent + f.descent) } ?: 0f
        val panelH = padV + (nameLayout?.height ?: 0) + gapNameNum + numH + priceH + padV

        // Centre horizontally over the card, clamped inside the margins.
        var left = cardRect.centerX() - panelW / 2f
        left = safeCoerce(left, margin, width - margin - panelW)

        // Prefer just above the card; drop below if there is no room; then clamp vertically.
        var top = cardRect.top - gapCard - panelH
        if (top < margin) top = cardRect.bottom + gapCard
        top = safeCoerce(top, margin, height - margin - panelH)

        panelRect.set(left, top, left + panelW, top + panelH)
    }

    /** ValueAnimator-driven alpha fade; cancels any in-flight fade first. */
    private fun animateTo(target: Float) {
        if (animator?.isRunning == true && panelAlpha == target) return
        animator?.cancel()
        animator = ValueAnimator.ofFloat(panelAlpha, target).apply {
            duration = 180L
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                panelAlpha = it.animatedValue as Float
                postInvalidateOnAnimation()
            }
            start()
        }
    }

    /** Run [block] on the UI thread whether or not the caller is already on it. */
    private fun onUi(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else post { block() }
    }

    /** coerceIn that tolerates hi < lo (degenerate viewports) instead of crashing. */
    private fun safeCoerce(v: Float, lo: Float, hi: Float) = if (hi < lo) lo else v.coerceIn(lo, hi)
}