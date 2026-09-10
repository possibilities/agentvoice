package com.arthack.agentvoice

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.runtime.*
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Debug-only visual fixture. It cannot load a grant, connect a socket, or open audio. */
class DesignPreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val scenario = intent.getStringExtra("scenario") ?: "live"
        if (scenario in listOf("live", "talk", "connecting")) {
            WindowCompat.getInsetsController(window, window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }
        setContent {
            var ui by remember { mutableStateOf(when (scenario) {
                "setup" -> CallUi()
                "ready" -> CallUi()
                "connecting" -> CallUi(running = true, phase = "Connecting voice")
                "error" -> CallUi(phase = "Disconnected", message = "Could not connect securely. Check Tailscale and your server.")
                "talk" -> CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
                    speakerMuted = false, micOpen = true, speakerOpen = true, canHold = true, holding = true, inputLevel = .14f)
                else -> CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
                    speakerMuted = false, speakerOpen = true, canHold = true, outputLevel = .14f)
            }) }
            VoiceTheme {
                VoiceScreen(ui, scenario != "setup", start = { ui = ui.copy(running = true, connected = true, canHold = true, phase = "Connected") },
                    stop = { ui = CallUi() }, importGrant = {},
                    mute = { target -> ui = if (target == "mic") ui.copy(micMuted = !ui.micMuted, canHold = !ui.canHold)
                        else ui.copy(speakerMuted = !ui.speakerMuted, speakerOpen = !ui.speakerOpen) },
                    hold = { ui = ui.copy(holding = true, micOpen = true, inputLevel = .2f, outputLevel = 0f) },
                    release = { ui = ui.copy(holding = false, micOpen = false, inputLevel = 0f) }, preview = true)
            }
        }
    }
}
