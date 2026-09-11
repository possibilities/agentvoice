package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.sqrt

/** The scene positions this inside the existing Halo; it owns neither a clock nor connection work. */
@Composable
internal fun PreviewConnectionNotice(
    connection: String,
    modifier: Modifier = Modifier,
    style: String = "relay",
    innerRadius: Dp = 120.dp,
    detail: String? = null,
    onConnect: (() -> Unit)? = null,
    onCancel: (() -> Unit)? = null,
) {
    require(connection in setOf("connected", "connecting", "disconnected", "failed"))
    require(style in setOf("relay", "beacon", "datum"))
    if (connection == "connected") return
    val inks = LocalPreviewTheme.current.palette
    val label = when (connection) {
        "connecting" -> "Connecting"
        "failed" -> "Couldn’t connect"
        else -> "Disconnected"
    }
    val action = onConnect ?: onCancel
    val actionLabel = when {
        onConnect != null -> if (connection == "failed") "Retry" else "Connect"
        onCancel != null -> if (connection == "failed") "End attempt" else "Cancel"
        else -> null
    }
    val explanation = detail ?: when (connection) {
        "failed" -> "Check the server and Tailscale connection, then try again."
        "connecting" -> "Opening the voice connection."
        else -> "Connect when you’re ready."
    }
    var details by remember(connection) { mutableStateOf(false) }
    val radius = (innerRadius.value - 8f).coerceAtLeast(24f)
    val width = minOf(220f, radius * 1.6f)
    val height = 2f * sqrt((radius * radius - width * width / 4f).coerceAtLeast(0f))
    val fontScale = LocalDensity.current.fontScale
    // At small saved sizes or large accessibility fonts, one 48dp affordance opens
    // the full literal status and actions instead of clipping or shrinking targets.
    val compact = width < 132f * fontScale || height < 108f * fontScale
    Column(modifier.width(width.coerceAtLeast(48f).dp)
        .semantics { liveRegion = LiveRegionMode.Polite }
        .testTag("preview-connection-notice"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (compact) {
            TextButton(onClick = { details = true }, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                .semantics { contentDescription = "$label. Open connection details" }
                .testTag("connection-compact")) {
                ConnectionNoticeGlyph(connection, Modifier.size(32.dp), style)
            }
        } else {
            when (if (connection == "failed") "text" else style) {
                "relay" -> ConnectionNoticeGlyph(connection, Modifier.size(28.dp), style)
                "datum" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ConnectionNoticeGlyph(connection, Modifier.size(16.dp), style)
                    Text("CONNECTION", color = inks.muted, fontFamily = VoiceInk.type, fontSize = 10.sp)
                }
            }
            Text(if (style == "beacon" && connection == "disconnected") "Not connected" else label,
                modifier = Modifier.testTag("preview-connection-label"), color = inks.text,
                fontFamily = VoiceInk.type, fontSize = (if (style == "beacon") 24 else 18).sp,
                lineHeight = (if (style == "beacon") 28 else 22).sp,
                textAlign = TextAlign.Center, maxLines = 2)
            if (action != null || detail != null || connection == "failed") {
                Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    if (action != null && actionLabel != null) TextButton(onClick = action,
                        contentPadding = PaddingValues(horizontal = 8.dp),
                        modifier = Modifier.heightIn(min = 48.dp).testTag("connection-primary-action")) {
                        Text(actionLabel, color = inks.text, fontFamily = VoiceInk.type, fontSize = 12.sp)
                    }
                    if (detail != null || connection == "failed") TextButton(onClick = { details = true },
                        contentPadding = PaddingValues(horizontal = 8.dp),
                        modifier = Modifier.size(48.dp).semantics { contentDescription = "Connection details" }.testTag("connection-details")) {
                        Text("Info", color = inks.muted, fontFamily = VoiceInk.type, fontSize = 12.sp)
                    }
                }
            }
        }
    }
    if (details) AlertDialog(onDismissRequest = { details = false }, title = { Text(label) },
        text = { androidx.compose.foundation.text.selection.SelectionContainer {
            Text(explanation, Modifier.verticalScroll(rememberScrollState()).testTag("connection-detail-text"))
        } }, confirmButton = {
            if (action != null && actionLabel != null) TextButton(onClick = { details = false; action() }, modifier = Modifier.testTag("connection-dialog-action")) { Text(actionLabel) }
            else TextButton(onClick = { details = false }) { Text("Done") }
        }, dismissButton = {
            if (action != null) TextButton(onClick = { details = false }) { Text("Close") }
        })
}

@Composable
private fun ConnectionNoticeGlyph(connection: String, modifier: Modifier, style: String) {
    val inks = LocalPreviewTheme.current.palette
    Canvas(modifier.clearAndSetSemantics { }.testTag("preview-connection-glyph")) {
        fun point(x: Float, y: Float) = Offset(size.width * x, size.height * y)
        val stroke = 1.6.dp.toPx()
        if (connection == "failed") {
            val triangle = Path().apply { moveTo(size.width * .5f, size.height * .08f); lineTo(size.width * .94f, size.height * .86f); lineTo(size.width * .06f, size.height * .86f); close() }
            drawPath(triangle, inks.text, style = Stroke(stroke))
            drawLine(inks.text, point(.5f, .32f), point(.5f, .56f), stroke, StrokeCap.Square)
            drawCircle(inks.text, stroke / 2f, point(.5f, .7f))
        } else {
            drawLine(inks.muted, point(.04f, .5f), point(.28f, .5f), stroke, StrokeCap.Square)
            drawLine(inks.muted, point(.28f, .25f), point(.28f, .75f), stroke, StrokeCap.Square)
            drawLine(inks.muted, point(.72f, .25f), point(.72f, .75f), stroke, StrokeCap.Square)
            drawLine(inks.muted, point(.72f, .5f), point(.96f, .5f), stroke, StrokeCap.Square)
            if (connection == "disconnected") drawLine(inks.text, point(.43f, .84f), point(.57f, .16f), stroke, StrokeCap.Square)
            else {
                drawLine(inks.text, point(.38f, .5f), point(.62f, .5f), stroke, StrokeCap.Square)
                if (style == "relay") drawLine(inks.muted, point(.43f, .62f), point(.57f, .62f), stroke * .65f, StrokeCap.Square)
            }
        }
    }
}
