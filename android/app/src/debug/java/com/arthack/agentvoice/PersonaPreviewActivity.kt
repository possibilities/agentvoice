package com.arthack.agentvoice

import android.content.Intent
import android.os.Bundle
import android.util.AtomicFile
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import java.io.File

/** Synthetic native preview. Its ADB bridge can only select, size, and save the Halo. */
class PersonaPreviewActivity : ComponentActivity() {
    private val selection get() = File(filesDir, "persona-tuning.json")
    private lateinit var session: PersonaPreviewSession
    private var bridge: PersonaPreviewBridge? = null
    private var pending: Pair<String, String>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        session = PersonaPreviewSession(runCatching {
            decodePersonaTuning(AtomicFile(selection).readFully().toString(Charsets.UTF_8))
        }.getOrDefault(PersonaPlacement()), selection)
        configure(intent)
        setContent { VoiceTheme { PersonaPreview(session.state) { session.state = it } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        configure(intent)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) startBridge()
    }

    private fun configure(intent: Intent) {
        bridge?.close()
        bridge = null
        val name = intent.getStringExtra("previewSocket").orEmpty()
        val token = intent.getStringExtra("previewToken").orEmpty()
        pending = if (name.matches(Regex("agentvoice-halo-[a-f0-9]{32}")) && token.matches(Regex("[a-f0-9]{64}"))) name to token else null
        intent.removeExtra("previewSocket")
        intent.removeExtra("previewToken")
    }

    override fun onStart() { super.onStart(); startBridge() }

    private fun startBridge() {
        val (name, token) = pending ?: return
        pending = null
        bridge = PersonaPreviewBridge(name, token, session::command)
    }

    override fun onStop() {
        bridge?.close()
        bridge = null
        pending = null
        session.state = session.state.copy(holding = false)
        super.onStop()
    }
}

@Composable
internal fun PersonaPreview(state: PersonaPreviewState, change: (PersonaPreviewState) -> Unit) {
    VoiceScreen(state.ui(), true, start = {}, stop = { change(state.select("idle")) }, importGrant = {},
        mute = { target -> change(state.select(if (target == "mic") {
            if (state.mode == "listening") "idle" else "listening"
        } else if (state.mode == "speaking") "idle" else "speaking")) },
        hold = { change(state.select("listening").copy(holding = true)) },
        release = { if (state.holding) change(state.select("idle")) },
        preview = true, personaPlacement = state.placement)
}
