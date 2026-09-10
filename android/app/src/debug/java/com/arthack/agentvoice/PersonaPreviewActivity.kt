package com.arthack.agentvoice

import android.content.Intent
import android.content.res.Configuration
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
import org.json.JSONObject
import java.io.File

/** Synthetic native preview. Its ADB bridge owns only visual choices and their private profile. */
class PersonaPreviewActivity : ComponentActivity() {
    private val selection get() = File(filesDir, "persona-tuning.json")
    private lateinit var session: PersonaPreviewSession
    private var bridge: PersonaPreviewBridge? = null
    private var binding: PersonaPreviewBinding? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        val saved = runCatching { AtomicFile(selection).readFully().toString(Charsets.UTF_8) }.getOrNull()
        val loaded = runCatching { decodePreviewProfileLayouts(saved!!) }.getOrElse {
            val portrait = defaultPortraitLayout()
            PreviewProfileLayouts(portrait, defaultLandscapeLayout(), PreviewSharedAppearance.from(portrait))
        }
        val portrait = loaded.portrait
        session = PersonaPreviewSession(portrait.placement, selection, portrait.design, portrait.halo,
            portrait.spirit, loaded.landscape, portrait.personaSide, portrait.horizontalOffsetDp,
            portrait.appearanceOverrides, loaded.shared, saved?.let { runCatching { decodePersonaSounds(it) }.getOrNull() } ?: ShippingDesign.sounds)
        val appearance = saved?.let { runCatching { decodeDesignAppearanceProfile(it) }.getOrNull() } ?: shippingAppearance()
        session.state = session.state.withAppearance(appearance).copy(savedAppearance = appearance)
        savedInstanceState?.getString("previewState")?.let { json ->
            runCatching { session.state = restorePersonaPreview(JSONObject(json), session.state.saved, session.state.savedDesign, session.state.savedHalo, session.state.savedSpirit, session.state.savedOtherLayout, session.state.savedPersonaSide, session.state.savedHorizontalOffsetDp, session.state.savedAppearanceOverrides, session.state.savedSharedAppearance, session.state.savedSounds, session.state.savedAppearance) }
        }
        observeOrientation(resources.configuration)
        binding = PersonaPreviewBinding.parse(savedInstanceState?.getString("previewSocket"), savedInstanceState?.getString("previewToken"))
        configure(intent)
        setContent { VoiceTheme {
            PersonaPreview(session.state, onExit = ::finish) { session.state = it }
            if (session.showIconCredits) PreviewIconCredits { session.showIconCredits = false }
        } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        configure(intent)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) startBridge()
    }

    private fun configure(intent: Intent) {
        val next = PersonaPreviewBinding.parse(intent.getStringExtra("previewSocket"), intent.getStringExtra("previewToken")) ?: return
        intent.removeExtra("previewSocket")
        intent.removeExtra("previewToken")
        if (binding?.name == next.name && binding?.token == next.token) return
        bridge?.close()
        bridge = null
        binding = next
    }

    override fun onStart() { super.onStart(); startBridge() }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        observeOrientation(newConfig)
    }

    private fun observeOrientation(config: Configuration) {
        session.state = session.state.rotate(if (config.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait")
    }

    private fun startBridge() {
        val selected = binding ?: return
        if (bridge == null) bridge = PersonaPreviewBridge(selected.name, selected.token, session::command)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("previewState", session.state.json().toString())
        binding?.let {
            // Only the debug preview capability enters Android's private activity state, never a voice grant.
            outState.putString("previewSocket", it.name)
            outState.putString("previewToken", it.token)
        }
        super.onSaveInstanceState(outState)
    }

    override fun onStop() {
        bridge?.close()
        bridge = null
        session.state = session.state.endHold()
        super.onStop()
    }
}

internal class PersonaPreviewBinding(val name: String, val token: String) {
    override fun toString() = "PersonaPreviewBinding(redacted)"
    companion object {
        fun parse(name: String?, token: String?): PersonaPreviewBinding? =
            if (name?.matches(Regex("agentvoice-halo-[a-f0-9]{32}")) == true && token?.matches(Regex("[a-f0-9]{64}")) == true)
                PersonaPreviewBinding(name, token) else null
    }
}

@Composable
internal fun PersonaPreview(state: PersonaPreviewState, onExit: () -> Unit = {}, soundOutput: PreviewSwitchOutput? = null, change: (PersonaPreviewState) -> Unit) {
    val currentState by rememberUpdatedState(state)
    val feedback = rememberPreviewSwitchFeedback(state.sounds, soundOutput)
    val release: () -> Unit = { feedback.cancel(); if (currentState.holding) change(currentState.endHold()) }
    val completedRelease: () -> Unit = {
        if (currentState.holding) { change(currentState.endHold()); feedback.release() } else feedback.cancel()
    }
    PreviewStudioScreen(state.ui(), state.design, state.placement,
        onMute = {
            val next = currentState.toggle(it)
            if (next != currentState) { change(next); feedback.toggle(if (it == "mic") !next.micMuted else !next.speakerMuted) }
        }, onHold = {
            val next = currentState.beginHold()
            if (next.holding && !currentState.holding) { change(next); feedback.down() }
        },
        onRelease = release, onExit = onExit, connection = state.connection, halo = state.halo, spirit = state.spirit, activity = state.activity,
        personaSide = state.personaSide, theme = state.theme, mutedPresence = state.mutedPresence, mutedTuning = state.mutedTuning, presenceScope = state.presenceScope, horizontalOffsetDp = state.horizontalOffsetDp, onReleaseCompleted = completedRelease, showPushToTalk = state.showPushToTalk, icons = state.icons)
}
