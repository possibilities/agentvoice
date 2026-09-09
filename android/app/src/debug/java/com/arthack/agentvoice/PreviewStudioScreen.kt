package com.arthack.agentvoice

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Experimental layouts keep the native Halo and the controls in separate, stable layers. */
@Composable
internal fun PreviewStudioScreen(
    ui: CallUi,
    design: PreviewDesign,
    placement: PersonaPlacement,
    onMute: (String) -> Unit,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    onExit: () -> Unit,
) {
    var expanded by rememberSaveable(design.header) { mutableStateOf(false) }
    var reserved by remember(design.header) { mutableStateOf(0.dp) }
    val headerSpace by animateDpAsState(reserved, tween(280, easing = FastOutSlowInEasing), label = "header-space")
    val currentRelease by rememberUpdatedState(onRelease)
    DisposableEffect(Unit) { onDispose { currentRelease() } }
    BoxWithConstraints(Modifier.fillMaxSize().background(VoiceInk.ground).safeDrawingPadding()) {
        val compact = maxHeight < 660.dp
        val shallow = maxHeight < 500.dp
        val side = if (maxWidth < 360.dp) 18.dp else 24.dp
        Column(Modifier.fillMaxSize().then(if (shallow) Modifier.verticalScroll(rememberScrollState()) else Modifier)) {
            Box(Modifier.fillMaxWidth().then(if (shallow) Modifier.height(230.dp) else Modifier.weight(1f))) {
                // A header changes the open space's center, not the artboard diameter or control geometry.
                // Semantics must sit inside the layer to expose its translated bounds.
                PersonaHalo(ui, Modifier.fillMaxSize().graphicsLayer {
                    translationY = headerSpace.toPx() / 2f
                }.testTag("studio-persona-stage"), placement)
                PreviewHeader(design.header, expanded, { expanded = it }, ui, onExit,
                    Modifier.fillMaxWidth(), interactionActive = ui.holding,
                    onReservedHeightChange = { reserved = it })
            }
            PreviewControls(ui, design.mute, design.hold, onMute, onHold, onRelease,
                Modifier.fillMaxWidth().padding(horizontal = side), compact = compact)
            Spacer(Modifier.height(if (compact) 20.dp else 28.dp))
        }
    }
}
