package com.paldeck.binder

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage

private val GRADERS = listOf("PSA", "BGS", "CGC", "SGC", "Other")
private val GRADES = listOf("10", "9.5", "9", "8.5", "8", "7", "6", "5", "4", "3", "2", "1", "Auth")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardDetailDialog(store: BinderStore, card: Card, onClose: () -> Unit) {
    // editable working copy
    var qty by remember { mutableStateOf(store.entry(card.number).qty) }
    var value by remember { mutableStateOf(store.entry(card.number).marketValue.toString()) }
    var condition by remember { mutableStateOf(store.entry(card.number).condition) }
    var notes by remember { mutableStateOf(store.entry(card.number).notes) }
    var wish by remember { mutableStateOf(store.entry(card.number).wish) }
    val graded = remember { store.entry(card.number).graded.map { it.copy() }.toMutableStateList() }

    val cardValue = qty * (value.toDoubleOrNull() ?: 0.0) + graded.sumOf { it.value }

    Dialog(onDismissRequest = onClose) {
        Surface(shape = MaterialTheme.shapes.large, tonalElevation = 4.dp) {
            Column(Modifier.padding(18.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AsyncImage(card.image, card.name, Modifier.width(110.dp).aspectRatio(63f / 88f))
                    Column {
                        Text(card.name, style = MaterialTheme.typography.titleMedium)
                        Text("${card.number} · ${card.rare}", style = MaterialTheme.typography.bodySmall)
                        Text("${card.color} · ${card.kind}", style = MaterialTheme.typography.bodySmall)
                        if (card.cost.isNotEmpty())
                            Text("◇${card.cost}  ◈${card.power}  ⚔${card.attack}", style = MaterialTheme.typography.bodySmall)
                    }
                }
                Divider()
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text("Raw copies", Modifier.weight(1f))
                    IconButtonText("−") { if (qty > 0) qty-- }
                    Text("$qty", Modifier.padding(horizontal = 12.dp))
                    IconButtonText("+") { qty++ }
                }
                OutlinedTextField(value, { value = it }, label = { Text("Value each (${store.currencySymbol()})") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true, modifier = Modifier.fillMaxWidth())

                Text("Graded copies", style = MaterialTheme.typography.labelLarge)
                graded.forEachIndexed { i, slab ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        DropdownField(GRADERS, slab.grader) { graded[i] = slab.copy(grader = it) }
                        DropdownField(GRADES, slab.grade) { graded[i] = slab.copy(grade = it) }
                        OutlinedTextField(if (slab.value == 0.0) "" else slab.value.toString(),
                            { graded[i] = slab.copy(value = it.toDoubleOrNull() ?: 0.0) },
                            Modifier.weight(1f), placeholder = { Text("value") }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                        TextButton({ graded.removeAt(i) }) { Text("✕") }
                    }
                }
                TextButton({ graded.add(GradedSlab()) }) { Text("+ Add graded slab") }

                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Checkbox(wish, { wish = it }); Text("On my wishlist")
                }
                OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth())
                Text("Card value: ${store.format(cardValue)}", style = MaterialTheme.typography.titleMedium)

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClose, Modifier.weight(1f)) { Text("Close") }
                    Button({
                        store.setEntry(card.number, OwnEntry(qty, wish, condition, notes, value.toDoubleOrNull() ?: 0.0, graded.toMutableList()))
                        onClose()
                    }, Modifier.weight(1f)) { Text("Save") }
                }
            }
        }
    }
}

@Composable private fun IconButtonText(t: String, onClick: () -> Unit) =
    OutlinedButton(onClick, contentPadding = PaddingValues(0.dp), modifier = Modifier.size(40.dp)) { Text(t) }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DropdownField(options: List<String>, selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded, { expanded = !expanded }) {
        OutlinedTextField(selected, {}, readOnly = true, modifier = Modifier.menuAnchor().width(84.dp),
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) })
        ExposedDropdownMenu(expanded, { expanded = false }) {
            options.forEach { opt -> DropdownMenuItem(text = { Text(opt) }, onClick = { onSelect(opt); expanded = false }) }
        }
    }
}

fun BinderStore.currencySymbol(): String =
    (CURRENCIES.firstOrNull { it.first == currencyCode.value } ?: CURRENCIES[0]).second
