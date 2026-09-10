package com.arthack.agentvoice

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    connection: String = "connected",
    halo: PreviewHalo = PreviewHalo(),
    spirit: PreviewSpirit = PreviewSpirit(),
    activity: String = "steady",
) {
    androidx.activity.compose.BackHandler(onBack = onExit)
    val currentRelease by rememberUpdatedState(onRelease)
    DisposableEffect(Unit) { onDispose { currentRelease() } }
    val scene = rememberPreviewSpirit(ui, spirit, halo, activity, ambientPercent = design.traces.glowPercent)
    Box(Modifier.fillMaxSize().background(VoiceInk.ground)) {
        PreviewAmbientGlow(scene.ambient, Modifier.matchParentSize())
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val compact = maxHeight < 660.dp
            val shallow = maxHeight < 500.dp
            val side = if (maxWidth < 360.dp) 18.dp else 24.dp
            val bottomGap = if (compact) 20.dp else 28.dp
            val minimumStage = if (shallow) 230.dp else 160.dp
            val stageHeight = (maxHeight - design.controlsHeightDp.dp - bottomGap).coerceAtLeast(minimumStage)
            val scrolls = stageHeight + design.controlsHeightDp.dp + bottomGap > maxHeight
            // Taller controls move the available center without changing the operator's Halo size.
            val diameter = minOf(maxWidth, (maxHeight - 262.dp - bottomGap).coerceAtLeast(minimumStage))
            // The underlay's aperture follows selected geometry, never an animated frame or state.
            val maximumScale = if (halo.variant == "contained") halo.containedSizePercent / 100f
                else maxOf(placement.speakingScale, placement.listeningScale, placement.idleScale)
            val clearRadius = diameter * maximumScale * 1.9f * if (halo.variant == "contained") .27f else .4f
            val personaCenter = stageHeight / 2f + placement.offsetY
            Box(Modifier.fillMaxSize().then(if (scrolls) Modifier.verticalScroll(rememberScrollState()) else Modifier)) {
                PreviewPersonaTraces(stageHeight, design.controlsHeightDp.dp, side,
                    Modifier.matchParentSize(), personaCenter, clearRadius, design.traces)
                Column(Modifier.fillMaxWidth()) {
                    Box(Modifier.fillMaxWidth().height(stageHeight)) {
                        val stage = Modifier.align(Alignment.Center).requiredSize(diameter).testTag("studio-persona-stage")
                        key(halo.variant) {
                            if (halo.variant == "contained") PreviewSpiritHalo(ui, stage, placement, halo, scene.colors)
                            else PersonaHalo(ui, stage, placement)
                        }
                    }
                    PreviewControls(ui, onMute, onHold, onRelease,
                        Modifier.fillMaxWidth().padding(horizontal = side),
                        controlsHeightDp = design.controlsHeightDp, holdSharePercent = design.holdSharePercent, light = scene.light)
                    Spacer(Modifier.height(bottomGap))
                }
            }
            PreviewConnectionNotice(connection, Modifier.align(Alignment.TopCenter).fillMaxWidth())
        }
    }
}

@Composable
private fun PreviewSpiritHalo(ui: CallUi, modifier: Modifier, placement: PersonaPlacement, halo: PreviewHalo,
    colors: State<CompactHaloColors>) {
    CompactPersonaHalo(ui, modifier, halo.placement(placement), halo.tuning(), colors.value)
}
