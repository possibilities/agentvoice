package com.arthack.agentvoice

import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.buildAnnotatedString

@Composable
internal fun PreviewIconCredits(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val credits = remember(context) {
        val text = context.assets.open("notices/Icons-NOTICE.txt").bufferedReader().use { it.readText() }
        buildAnnotatedString {
            append(text)
            Regex("https://[^\\s]+").findAll(text).forEach { match ->
                addLink(LinkAnnotation.Url(match.value), match.range.first, match.range.last + 1)
            }
        }
    }
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text("Design icon credits") },
        text = {
            SelectionContainer {
                Text(credits, Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()))
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}
