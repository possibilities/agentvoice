package com.arthack.agentvoice

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private lateinit var controller: CallController
    private lateinit var grants: GrantStore
    private var grant: DeviceGrant? = null
    private var hasGrant by mutableStateOf(false)
    private var importing by mutableStateOf(false)
    private var setupMessage by mutableStateOf<String?>(null)
    private var pendingStart = false
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            if (pendingStart) beginCall()
        } else {
            pendingStart = false
            setupMessage = "Microphone permission is needed for voice. Allow it in Android settings, then start again."
        }
    }
    private val importGrant = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        importing = true
        lifecycleScope.launch {
            try {
                val imported = withContext(Dispatchers.IO) { grants.import(uri) }
                grant = imported
                hasGrant = true
                controller.stop()
                setupMessage = null
            } catch (_: Exception) {
                setupMessage = "Could not import that grant. Choose a valid device file from your server."
            } finally { importing = false }
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        controller = CallController(applicationContext)
        grants = GrantStore(applicationContext)
        importing = true
        lifecycleScope.launch {
            try {
                grant = withContext(Dispatchers.IO) { grants.load() }
                hasGrant = grant != null
            } catch (_: Exception) { setupMessage = "Device access could not be opened. Import your grant again." }
            finally { importing = false }
        }
        setContent {
            VoiceTheme {
                val ui = controller.ui
                androidx.compose.runtime.DisposableEffect(ui.running) {
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
                VoiceScreen(ui, hasGrant, importing, setupMessage,
                    start = ::requestCall, stop = { controller.stop("Call ended.") },
                    importGrant = { importGrant.launch(arrayOf("application/json", "text/plain", "application/octet-stream")) },
                    mute = controller::toggleMute, hold = controller::hold, release = controller::release)
            }
        }
    }
    private fun requestCall() {
        if (grant == null || controller.ui.running) return
        setupMessage = null
        pendingStart = true
        val missing = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) beginCall() else permission.launch(missing.toTypedArray())
    }
    private fun beginCall() {
        pendingStart = false
        grant?.let {
            try { controller.start(it) }
            catch (_: Exception) { controller.stop("Could not start voice. Check microphone permission and Tailscale.") }
        }
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus && ::controller.isInitialized) controller.release()
    }
    override fun onPause() { controller.release(); super.onPause() }
    override fun onStop() {
        pendingStart = false
        if (controller.ui.running) controller.stop("Call ended when the app left the foreground.")
        super.onStop()
    }
    override fun onDestroy() { controller.dispose(); super.onDestroy() }
}
