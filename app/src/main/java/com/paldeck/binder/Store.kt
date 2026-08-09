package com.paldeck.binder

import android.content.Context
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// ---- Models ----

data class Card(
    val number: String, val name: String, val kind: String, val sub: String,
    val rare: String, val color: String, val type: String, val aptitude: String,
    val cost: String, val power: String, val attack: String, val set: String, val image: String
) {
    val elements: List<String> get() = if (type.isEmpty()) emptyList() else type.split("|")
    val base: String get() = number.replace(Regex("(OSR|SSP|TSR|TSP|SP|SR)$"), "")
    val isChase: Boolean get() = rare !in setOf("C", "U", "R", "RR", "TD", "PR")
}

data class SetInfo(val key: String, val name: String)

data class GradedSlab(var grader: String = "PSA", var grade: String = "10", var value: Double = 0.0)

data class OwnEntry(
    var qty: Int = 0, var wish: Boolean = false, var condition: String = "Near Mint",
    var notes: String = "", var marketValue: Double = 0.0, var graded: MutableList<GradedSlab> = mutableListOf()
) {
    val owned: Boolean get() = qty > 0 || graded.isNotEmpty()
    val totalValue: Double get() = qty * marketValue + graded.sumOf { it.value }
}

val CURRENCIES = listOf(
    Triple("USD", "$", 2), Triple("EUR", "€", 2), Triple("GBP", "£", 2),
    Triple("JPY", "¥", 0), Triple("CAD", "CA$", 2), Triple("AUD", "A$", 2)
)

// ---- Store (single instance held by the Activity) ----

class BinderStore(private val context: Context) {
    val sets: List<SetInfo>
    val cards: List<Card>
    private val byNumber: Map<String, Card>
    val own: SnapshotStateMap<String, OwnEntry> = mutableStateMapOf()
    val currencyCode = mutableStateOf("USD")
    val revision = mutableStateOf(0)                 // bump to trigger recomposition on nested edits

    private val ownFile = File(context.filesDir, "paldeck_binder.json")

    init {
        val root = JSONObject(context.assets.open("paldeck_cards.json").bufferedReader().use { it.readText() })
        sets = root.getJSONArray("sets").let { a -> List(a.length()) { i -> a.getJSONObject(i).let { SetInfo(it.getString("key"), it.getString("name")) } } }
        cards = root.getJSONArray("cards").let { a ->
            List(a.length()) { i ->
                val o = a.getJSONObject(i)
                Card(o.getString("number"), o.getString("name"), o.getString("kind"), o.getString("sub"),
                    o.getString("rare"), o.getString("color"), o.getString("type"), o.getString("aptitude"),
                    o.getString("cost"), o.getString("power"), o.getString("attack"), o.getString("set"), o.getString("image"))
            }
        }
        byNumber = cards.associateBy { it.number }
        currencyCode.value = context.getSharedPreferences("paldeck", 0).getString("currency", "USD") ?: "USD"
        load()
    }

    fun card(number: String): Card? = byNumber[number]
    fun entry(number: String): OwnEntry = own[number] ?: OwnEntry()

    fun setEntry(number: String, e: OwnEntry) {
        if (!e.owned && !e.wish && e.notes.isEmpty() && e.marketValue == 0.0) own.remove(number) else own[number] = e
        revision.value++; save()
    }
    fun collect(number: String) {
        val e = entry(number).copy(); e.qty = maxOf(1, e.qty + 1); own[number] = e; revision.value++; save()
    }
    fun setCurrency(code: String) {
        currencyCode.value = code
        context.getSharedPreferences("paldeck", 0).edit().putString("currency", code).apply()
    }

    // stats
    fun ownedPrintings() = cards.count { entry(it.number).owned }
    fun masterOwned() = cards.filter { entry(it.number).owned }.map { it.base }.toSet().size
    fun masterTotal() = cards.map { it.base }.toSet().size
    fun chaseOwned() = cards.count { it.isChase && entry(it.number).owned }
    fun chaseTotal() = cards.count { it.isChase }
    fun binderValue() = own.values.sumOf { it.totalValue }

    fun format(v: Double): String {
        val cur = CURRENCIES.firstOrNull { it.first == currencyCode.value } ?: CURRENCIES[0]
        return cur.second + "%,.${cur.third}f".format(v)
    }

    // ---- persistence (compact JSON) ----
    private fun save() {
        val root = JSONObject()
        own.forEach { (num, e) ->
            val o = JSONObject()
                .put("qty", e.qty).put("wish", e.wish).put("condition", e.condition)
                .put("notes", e.notes).put("marketValue", e.marketValue)
            val g = JSONArray()
            e.graded.forEach { g.put(JSONObject().put("grader", it.grader).put("grade", it.grade).put("value", it.value)) }
            o.put("graded", g); root.put(num, o)
        }
        ownFile.writeText(root.toString())
    }
    private fun load() {
        if (!ownFile.exists()) return
        val root = JSONObject(ownFile.readText())
        root.keys().forEach { num ->
            val o = root.getJSONObject(num)
            val g = o.optJSONArray("graded") ?: JSONArray()
            val slabs = MutableList(g.length()) { i ->
                g.getJSONObject(i).let { GradedSlab(it.getString("grader"), it.getString("grade"), it.getDouble("value")) }
            }
            own[num] = OwnEntry(o.getInt("qty"), o.optBoolean("wish"), o.optString("condition", "Near Mint"),
                o.optString("notes", ""), o.optDouble("marketValue", 0.0), slabs)
        }
    }
}

// palette (hex ints matching the web tracker)
val COLOR_HEX = mapOf(
    "Red" to 0xFFd84a3d, "Blue" to 0xFF3f8fd6, "Green" to 0xFF57a64c,
    "Purple" to 0xFF8a5fd0, "Colorless" to 0xFFb0a892
)
