package com.arthack.agentvoice

import android.content.Intent
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/** Synthetic native preview. Its ADB bridge owns only visual choices and their private profile. */
class PersonaPreviewActivity : ComponentActivity() {
    private val selection get() = File(filesDir, "persona-tuning.json")
    private lateinit var session: PersonaPreviewSession
    private var draftReady = false
    private var bridge: PersonaPreviewBridge? = null
    private var binding: PersonaPreviewBinding? = null
    private val bindingStore by lazy { StudioBindingStore(File(filesDir, "persona-studio-binding.json")) }
    private val displays by lazy { getSystemService(DisplayManager::class.java) }
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) {
            if (display?.displayId == displayId) observeOrientation(resources.configuration)
        }
    }

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
            PreviewProfileLayouts(portrait, defaultLandscapeLayout(), PreviewSharedAppearance.from(portrait),
                defaultPreviewLayout("portrait-reverse"), defaultPreviewLayout("landscape-reverse"))
        }
        val draft = StudioDraft(File(filesDir, "persona-studio-draft.json"))
        val working = runCatching { draft.open() }
        draftReady = working.isSuccess
        val portrait = loaded.portrait
        session = PersonaPreviewSession(portrait.placement, selection, portrait.design, portrait.halo,
            portrait.spirit, loaded.landscape, portrait.personaSide, portrait.horizontalOffsetDp,
            portrait.appearanceOverrides, loaded.shared, saved?.let { runCatching { decodePersonaSounds(it) }.getOrNull() } ?: ShippingDesign.sounds,
            initialPortraitReverse = loaded.portraitReverse, initialLandscapeReverse = loaded.landscapeReverse)
        val appearance = saved?.let { runCatching { decodeDesignAppearanceProfile(it) }.getOrNull() } ?: shippingAppearance()
        session.state = session.state.withAppearance(appearance).copy(savedAppearance = appearance)
        // Rehearsal continuity is activity-local; durable design always wins over an older Bundle.
        if (working.isSuccess && savedInstanceState != null) {
            savedInstanceState.getString("previewState")?.let { json ->
                runCatching { session.state = restorePersonaPreview(JSONObject(json), session.state.saved, session.state.savedDesign,
                    session.state.savedHalo, session.state.savedSpirit, session.state.savedOtherLayout, session.state.savedPersonaSide,
                    session.state.savedHorizontalOffsetDp, session.state.savedAppearanceOverrides, session.state.savedSharedAppearance,
                    session.state.savedSounds, session.state.savedAppearance) }
            }
        }
        working.getOrNull()?.let { session.state = session.state.withDesignProfile(it).copy(revision = session.state.revision) }
        if (working.isFailure) {
            android.app.AlertDialog.Builder(this).setTitle("Studio draft could not be loaded")
                .setMessage("Your draft and saved profile are retained. Close Studio to recover the file, or reset the working draft to production.")
                .setCancelable(false).setNegativeButton("Close") { _, _ -> finish() }
                .setPositiveButton("Reset to production") { _, _ ->
                    runCatching { draft.write(StudioProduction.profile); session.state = session.state.withDesignProfile(StudioProduction.profile); draftReady = true; startBridge() }
                        .onFailure { finish() }
                }.show()
        }
        session.persistWorkingDesign = draft::write
        observeOrientation(resources.configuration)
        val storedBinding = runCatching { bindingStore.loadOrCreate() }
        binding = storedBinding.getOrNull()
        val explicit = PersonaPreviewBinding.parse(intent.getStringExtra("previewSocket"), intent.getStringExtra("previewToken"))
        val configured = if (explicit != null) runCatching { configure(intent) } else Result.success(Unit)
        if (configured.isFailure || (storedBinding.isFailure && explicit == null)) showBindingError()
        setContent { VoiceTheme {
            val rehearsal = session.state.connectionPreview
            var setupReturn by remember { mutableStateOf("off") }
            val selectRehearsal: (String) -> Unit = { scene ->
                session.state = session.state.endHold().copy(connectionPreview = scene)
            }
            val showNavigationHint = {
                android.widget.Toast.makeText(this@PersonaPreviewActivity,
                    CALL_NAVIGATION_HINT, android.widget.Toast.LENGTH_SHORT).show()
            }
            StudioPreviewNavigation(session.state, onExit = ::finish,
                onScan = { setupReturn = session.state.connectionPreview },
                onCredits = { session.showIconCredits = true },
                showNavigationHint = showNavigationHint) { session.state = it }
            LaunchedEffect(rehearsal) {
                if (rehearsal == "off" || rehearsal in previewConnectionRoots) setupReturn = rehearsal
                if (rehearsal != "off" && rehearsal !in previewConnectionRoots) android.widget.Toast.makeText(this@PersonaPreviewActivity,
                    "Connection preview · no server access", android.widget.Toast.LENGTH_SHORT).show()
            }
            val close = { selectRehearsal(setupReturn) }
            if (rehearsal == "camera") ConnectionCamera { cameraState, action, surface ->
                ConnectionOverlay(ConnectionScene.camera(cameraState), close, action, studio = true,
                    theme = session.state.theme, personaSide = session.state.personaSide, camera = surface)
            } else ConnectionScene.entries.firstOrNull { it.key == rehearsal }?.let { scene ->
                val next = when (scene.key) {
                    "microphone", "microphone-denied" -> "connecting"
                    "storage-failed" -> setupReturn
                    else -> "scanning"
                }
                ConnectionOverlay(scene, close, action = { session.state = session.state.copy(connectionPreview = next) },
                    studio = true, theme = session.state.theme, personaSide = session.state.personaSide)
            }
            if (session.showIconCredits) PreviewIconCredits { session.showIconCredits = false }
        } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (runCatching { configure(intent) }.isFailure) showBindingError()
        else if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) startBridge()
    }

    private fun configure(intent: Intent) {
        val next = PersonaPreviewBinding.parse(intent.getStringExtra("previewSocket"), intent.getStringExtra("previewToken")) ?: return
        intent.removeExtra("previewSocket")
        intent.removeExtra("previewToken")
        if (binding?.name == next.name && binding?.token == next.token) return
        // This private capability reaches only the synthetic Studio bridge, never a real call.
        bindingStore.replace(next)
        bridge?.close()
        bridge = null
        binding = next
    }

    private fun showBindingError() {
        android.app.AlertDialog.Builder(this).setTitle("Studio connection unavailable")
            .setMessage("The private Studio connection file is unreadable or invalid. Close Studio, then repair or remove persona-studio-binding.json before reopening. Your draft and saved profile were not changed.")
            .setCancelable(false).setPositiveButton("Close") { _, _ -> finish() }.show()
    }

    override fun onStart() {
        super.onStart()
        displays.registerDisplayListener(displayListener, Handler(Looper.getMainLooper()))
        observeOrientation(resources.configuration)
        startBridge()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        observeOrientation(newConfig)
    }

    private fun observeOrientation(config: Configuration) {
        session.state = session.state.rotate(previewOrientation(config.orientation, display?.rotation ?: android.view.Surface.ROTATION_0))
    }

    private fun startBridge() {
        if (!draftReady) return
        val selected = binding ?: return
        if (bridge == null) bridge = PersonaPreviewBridge(selected.name, selected.token, ::command)
    }

    private suspend fun command(request: JSONObject): JSONObject {
        val reply = session.command(request)
        if (request.getString("method") == "get") withContext(Dispatchers.Main) {
            studioViewport(window.decorView)?.let { reply.put("viewport", it.json()) }
        }
        return reply
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
        displays.unregisterDisplayListener(displayListener)
        bridge?.close()
        bridge = null
        session.state = session.state.endHold()
        super.onStop()
    }
}

@Composable
internal fun StudioPreviewNavigation(
    state: PersonaPreviewState,
    onExit: () -> Unit = {},
    onScan: () -> Unit,
    onCredits: (() -> Unit)? = null,
    showNavigationHint: () -> Unit,
    change: (PersonaPreviewState) -> Unit,
) {
    var callVisible by remember { mutableStateOf(false) }
    var showedNavigationHint by remember { mutableStateOf(false) }
    LaunchedEffect(state.connectionPreview) {
        if (state.connectionPreview != "root-active") callVisible = false
    }
    if (state.connectionPreview in previewConnectionRoots && !callVisible) {
        val pairingPending = state.connectionPreview == "root-pairing-pending"
        ConnectionScreen(state.connectionRootUi(), paired = state.connectionPreview !in setOf("root-unpaired", "root-pairing-pending"),
            onConnect = { change(state.endHold().copy(connectionPreview = "root-connecting")) },
            onReturnToCall = {
                callVisible = true
                if (!showedNavigationHint) {
                    showedNavigationHint = true
                    showNavigationHint()
                }
            },
            onDisconnect = { change(state.endHold().copy(connectionPreview = "root-disconnected")) },
            onScan = {
                onScan()
                change(state.endHold().copy(connectionPreview = if (pairingPending) "found" else "scanning"))
            },
            onCredits = onCredits, pairingPending = pairingPending)
    } else {
        val syntheticCall = callVisible && state.connectionPreview == "root-active"
        val visibleState = if (syntheticCall) state.copy(connection = "connected") else state
        PersonaPreview(visibleState,
            onExit = if (syntheticCall) ({ callVisible = false }) else onExit,
            onNavigationHint = if (syntheticCall) showNavigationHint else null) { next ->
            change(if (syntheticCall) next.copy(connection = state.connection) else next)
        }
    }
}

@Composable
internal fun PersonaPreview(state: PersonaPreviewState, onExit: () -> Unit = {}, soundOutput: PreviewSwitchOutput? = null,
    onNavigationHint: (() -> Unit)? = null, change: (PersonaPreviewState) -> Unit) {
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
        personaSide = state.personaSide, theme = state.theme, mutedPresence = state.mutedPresence, mutedTuning = state.mutedTuning, presenceScope = state.presenceScope, horizontalOffsetDp = state.horizontalOffsetDp, onReleaseCompleted = completedRelease, showPushToTalk = state.showPushToTalk, icons = state.icons,
        connectionStyle = state.connectionStyle, connectionDetail = state.ui().message,
        onConnect = if (state.connection in setOf("disconnected", "failed")) ({
            val next = currentState.endHold()
            change(next.copy(connection = "connecting", revision = next.revision + 1))
        }) else null,
        onCancelConnection = if (state.connection == "connecting") ({
            val next = currentState.endHold()
            change(next.copy(connection = "disconnected", revision = next.revision + 1))
        }) else null,
        onNavigationHint = onNavigationHint)
}
