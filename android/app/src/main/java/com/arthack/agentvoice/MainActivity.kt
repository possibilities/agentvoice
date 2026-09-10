package com.arthack.agentvoice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private lateinit var controller: CallController
    private lateinit var grants: GrantStore
    private val client = secureHttpClient()
    private val foreground = ForegroundConnectionPolicy()
    private var grant: DeviceGrant? = null
    private var loaded by mutableStateOf(false)
    private var hasGrant by mutableStateOf(false)
    private var loadFailed by mutableStateOf(false)
    private var scene by mutableStateOf<ConnectionScene?>(null)
    private var setupTitle by mutableStateOf<String?>(null)
    private var setupDetail by mutableStateOf<String?>(null)
    private var microphoneNeeded by mutableStateOf(false)
    private var microphoneDenied by mutableStateOf(false)
    private var resumed = false
    private var epoch = 0L
    private var enrollment: Job? = null
    private var loading: Job? = null
    private var pendingPermission = false
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        microphoneDenied = !micAllowed()
        if (pendingPermission && micAllowed() && resumed) requestCall()
        // Permission callbacks may arrive before onResume; the pending gesture survives onPause only.
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        controller = CallController(applicationContext)
        grants = GrantStore(applicationContext)
        setContent {
            VoiceTheme {
                val ui = controller.ui
                DisposableEffect(ui.running) {
                    if (ui.running) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        if (ui.running) hide(WindowInsetsCompat.Type.systemBars())
                        else show(WindowInsetsCompat.Type.systemBars())
                    }
                    onDispose { }
                }
                BackHandler(ui.running) { controller.stop("Call ended.") }
                VoiceScreen(ui, stop = { controller.stop("Call ended.") },
                    mute = controller::toggleMute, hold = controller::hold, release = controller::release)
                val close = { finish() }
                when {
                    !loaded -> ConnectionOverlay(ConnectionScene.Found, close,
                        title = "Opening device access…", detail = "Checking this phone’s saved connection.")
                    loadFailed -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::loadGrant,
                        title = "Couldn’t open device access", detail = "Your saved access has been kept. Try again; if this continues, repair the app’s device access manually.")
                    !hasGrant -> {
                        val current = scene
                        if (current == null) ConnectionCamera(onCode = ::acceptCode) { cameraState, action, camera ->
                            ConnectionOverlay(ConnectionScene.camera(cameraState), close, action = action, camera = camera)
                        } else ConnectionOverlay(current, close, action = if (current == ConnectionScene.StorageFailed) close else ::scanAgain,
                            title = setupTitle ?: current.title, detail = setupDetail ?: current.detail,
                            actionLabel = if (current == ConnectionScene.Failed) "Scan again" else current.action)
                    }
                    microphoneNeeded -> ConnectionOverlay(
                        if (microphoneDenied) ConnectionScene.MicrophoneDenied else ConnectionScene.Microphone,
                        close, action = ::allowMicrophone)
                    !ui.running -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::requestCall,
                        title = "Ready to reconnect", detail = ui.message ?: "Your device access is saved. Connect when you’re ready.",
                        actionLabel = "Connect")
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        epoch++
        foreground.enter()
        loadGrant()
    }

    private fun loadGrant() = loadGrantAfter(enrollment)

    private fun loadGrantAfter(pendingWrite: Job?) {
        val visit = epoch
        loading?.cancel()
        loaded = false
        loadFailed = false
        loading = lifecycleScope.launch {
            try {
                pendingWrite?.join()
                val stored = withContext(Dispatchers.IO) { grants.load() }
                if (visit != epoch) return@launch
                grant = stored
                hasGrant = stored != null
                scene = null
                setupTitle = null
                setupDetail = null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (visit == epoch) loadFailed = true }
            finally {
                if (visit == epoch) { loaded = true; maybeConnect() }
            }
        }
    }

    private fun maybeConnect() {
        if (!loadFailed && foreground.claim(loaded, hasGrant, resumed, controller.ui.running)) requestCall()
    }

    private fun scanAgain() {
        if (enrollment?.isActive == true || hasGrant) return
        scene = null
        setupTitle = null
        setupDetail = null
    }

    private fun acceptCode(value: String) {
        if (!resumed || !loaded || loadFailed || hasGrant || scene != null || enrollment?.isActive == true) return
        val candidate = try { parseGrantQr(value) } catch (_: Exception) {
            scene = ConnectionScene.Invalid
            return
        }
        val visit = epoch
        scene = ConnectionScene.Found
        enrollment = lifecycleScope.launch {
            try {
                verifyGrant(client, candidate)
                if (visit != epoch || !resumed) return@launch
                scene = ConnectionScene.Saving
                // Once verified, finish the atomic write even if the activity is backgrounded.
                // A successor foreground load uses the store lock and observes the finished value.
                withContext(NonCancellable + Dispatchers.IO) { grants.saveNew(candidate) }
                if (visit != epoch || !resumed) return@launch
                grant = candidate
                hasGrant = true
                scene = null
                maybeConnect()
            } catch (timeout: TimeoutCancellationException) {
                if (visit == epoch && resumed) {
                    scene = ConnectionScene.Failed
                    setupDetail = "The connection check timed out. Check your server and Tailscale, then scan again."
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: GrantCheckFailure) {
                if (visit == epoch) {
                    scene = if (failure.problem == GrantCheckProblem.Rejected) ConnectionScene.Rejected else ConnectionScene.Failed
                    setupTitle = when (failure.problem) {
                        GrantCheckProblem.Rejected -> "Device access wasn’t accepted"
                        GrantCheckProblem.Busy -> "Server is busy"
                        GrantCheckProblem.Protocol -> "Server needs an update"
                        GrantCheckProblem.Unreachable -> "Couldn’t reach the server"
                    }
                    setupDetail = if (failure.problem == GrantCheckProblem.Rejected)
                        "This code may have expired or been revoked. Generate a new code on your server."
                    else "Check your server and Tailscale connection, then scan again."
                }
            } catch (_: Exception) {
                if (visit == epoch) {
                    scene = ConnectionScene.StorageFailed
                }
            } finally {
                // onResume may precede completion of a cancelled verification or atomic save.
                // Reconcile after that work, without joining this coroutine from its own finally.
                if (visit == epoch && resumed && !hasGrant && scene in setOf(ConnectionScene.Found, ConnectionScene.Saving))
                    loadGrantAfter(null)
            }
        }
    }

    private fun micAllowed() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun requestCall() {
        if (!resumed || !loaded || loadFailed || grant == null || controller.ui.running) return
        if (!micAllowed()) { microphoneNeeded = true; return }
        pendingPermission = false
        microphoneNeeded = false
        microphoneDenied = false
        grant?.let {
            try { controller.start(it) }
            catch (_: Exception) { controller.stop("Could not start voice. Check microphone permission and Tailscale.") }
        }
    }

    private fun allowMicrophone() {
        if (!resumed) return
        pendingPermission = true
        if (microphoneDenied) startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        else permission.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray())
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (!hasGrant && scene in setOf(ConnectionScene.Found, ConnectionScene.Saving) && enrollment?.isActive != true)
            loadGrant()
        else if (pendingPermission && micAllowed()) requestCall() else maybeConnect()
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus && ::controller.isInitialized) controller.release()
    }
    override fun onPause() {
        resumed = false
        enrollment?.cancel()
        controller.release()
        super.onPause()
    }
    override fun onStop() {
        epoch++
        foreground.leave()
        pendingPermission = false
        loading?.cancel()
        enrollment?.cancel()
        if (controller.ui.running) controller.stop("Call ended when the app left the foreground.")
        super.onStop()
    }
    override fun onDestroy() {
        controller.dispose()
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
