package com.paldeck.binder

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage

class MainActivity : ComponentActivity() {
    private lateinit var store: BinderStore
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = BinderStore(applicationContext)
        setContent { MaterialTheme(colorScheme = if (isSystemDark()) darkColorScheme() else lightColorScheme()) { Root(store) } }
    }
}

@Composable private fun isSystemDark() = androidx.compose.foundation.isSystemInDarkTheme()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Root(store: BinderStore) {
    var tab by remember { mutableStateOf(0) }
    Scaffold(bottomBar = {
        NavigationBar {
            NavigationBarItem(selected = tab == 0, onClick = { tab = 0 },
                icon = { Icon(Icons.Default.GridView, null) }, label = { Text("Binder") })
            NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                icon = { Icon(Icons.Default.CameraAlt, null) }, label = { Text("Scan") })
        }
    }) { pad ->
        Box(Modifier.padding(pad)) {
            if (tab == 0) BinderScreen(store) else ScannerScreen(store)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BinderScreen(store: BinderStore) {
    store.revision.value                                   // observe edits
    var query by remember { mutableStateOf("") }
    var setFilter by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Card?>(null) }

    val filtered = store.cards.filter { c ->
        (setFilter == null || c.set == setFilter) &&
        (query.isBlank() || c.name.contains(query, true) || c.number.contains(query, true))
    }

    Column {
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            Stat("Set", "${store.ownedPrintings()}/${store.cards.size}")
            Stat("Master", "${store.masterOwned()}/${store.masterTotal()}")
            Stat("Chase", "${store.chaseOwned()}/${store.chaseTotal()}")
            Stat("Value", store.format(store.binderValue()))
        }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            label = { Text("Search name or number") }, singleLine = true)
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(8.dp)) {
            FilterChip(setFilter == null, { setFilter = null }, { Text("All") }); Spacer(Modifier.width(6.dp))
            store.sets.forEach { s ->
                FilterChip(setFilter == s.key, { setFilter = if (setFilter == s.key) null else s.key }, { Text(s.name.substringAfterLast("· ")) })
                Spacer(Modifier.width(6.dp))
            }
        }
        LazyVerticalGrid(columns = GridCells.Adaptive(110.dp), contentPadding = PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(filtered, key = { it.number }) { card ->
                val owned = store.entry(card.number).owned
                Column(Modifier.clip(RoundedCornerShape(10.dp)).clickable { selected = card }) {
                    Box {
                        AsyncImage(model = card.image, contentDescription = card.name,
                            modifier = Modifier.fillMaxWidth().aspectRatio(63f / 88f)
                                .alpha(if (owned) 1f else 0.5f)
                                .border(if (owned) 2.dp else 1.dp, if (owned) Color(0xFF2FA36B) else Color.Gray, RoundedCornerShape(8.dp)))
                    }
                    Text(card.name, maxLines = 1, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(4.dp))
                }
            }
        }
    }
    selected?.let { CardDetailDialog(store, it) { selected = null } }
}

@Composable fun Stat(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, fontWeight = FontWeight.SemiBold)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

