package com.arthack.agentvoice

import android.Manifest
import android.content.Intent
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.WindowManager
import android.widget.Toast
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
    private var owner by mutableStateOf<CallService.LocalBinder?>(null)
    private val controller get() = owner?.controller
    private var binding = false
    private var ownerFailed by mutableStateOf(false)
    private var navigation by mutableStateOf(CallNavigation())
    private var hintShownThisVisit = false
    private var hint: Toast? = null
    private lateinit var credentials: DeviceCredentialStore
    private lateinit var pairing: PairingEnrollment
    private val client = secureHttpClient()
    private var grant: CallCredential? = null
    private var pairingPending by mutableStateOf(false)
    private var showPendingPairing by mutableStateOf(false)
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
    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            owner = service as CallService.LocalBinder
            ownerFailed = false
            maybeConnect()
        }
        override fun onServiceDisconnected(name: ComponentName) {
            owner = null
            ownerFailed = true
            navigation = navigation.disconnected()
        }
        override fun onBindingDied(name: ComponentName) = onServiceDisconnected(name)
        override fun onNullBinding(name: ComponentName) = onServiceDisconnected(name)
    }
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
        navigation = CallNavigation(
            route = savedInstanceState?.getString("callRoute")?.let { runCatching { CallRoute.valueOf(it) }.getOrNull() }
                ?: CallRoute.Persona,
            autoConnectPending = savedInstanceState?.getBoolean("autoConnectPending", true) ?: true)
        hintShownThisVisit = savedInstanceState?.getBoolean("navigationHintShown") ?: false
        pendingPermission = savedInstanceState?.getBoolean("pendingCallPermission") ?: false
        microphoneNeeded = savedInstanceState?.getBoolean("microphoneNeeded") ?: false
        microphoneDenied = savedInstanceState?.getBoolean("microphoneDenied") ?: false
        if (CallService.isReturnToCall(intent)) navigation = navigation.enterCall()
        credentials = DeviceCredentialStore(applicationContext)
        pairing = PairingEnrollment(client, credentials)
        setContent {
            VoiceTheme {
                var credits by remember { mutableStateOf(false) }
                val ui = controller?.ui ?: CallUi()
                val inPersona = navigation.route == CallRoute.Persona
                DisposableEffect(ui.running, inPersona) {
                    if (ui.running && inPersona) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        if (ui.running && inPersona) hide(WindowInsetsCompat.Type.systemBars())
                        else show(WindowInsetsCompat.Type.systemBars())
                    }
                    onDispose { }
                }
                BackHandler(navigation.route != CallRoute.Connection || microphoneNeeded || showPendingPairing) { navigateBack() }
                LaunchedEffect(ui.running, ui.message) {
                    if (!ui.running && ui.message == "Call ended.") navigation = navigation.disconnected()
                }
                LaunchedEffect(ui.connected, inPersona) {
                    if (ui.connected && inPersona && !hintShownThisVisit) {
                        hintShownThisVisit = true
                        val preferences = getSharedPreferences("connection-guidance", MODE_PRIVATE)
                        val shown = preferences.getInt("entry-hints", 0)
                        if (shown < 3) {
                            preferences.edit().putInt("entry-hints", shown + 1).apply()
                            showNavigationHint()
                        }
                    }
                }
                if (inPersona) VoiceScreen(ui, stop = ::disconnect,
                    mute = { controller?.toggleMute(it) }, hold = { controller?.hold() }, release = { controller?.release() },
                    connect = if (loaded && hasGrant && !loadFailed && !microphoneNeeded) ::requestCall else null,
                    onBack = ::navigateBack, onNavigationHint = ::showNavigationHint)
                else ConnectionScreen(ui, hasGrant, ::requestCall,
                    onReturnToCall = { navigation = navigation.enterCall() }, onDisconnect = ::disconnect,
                    onScan = {
                        if (pairingPending) showPendingPairing = true
                        else { scanAgain(); navigation = navigation.scan() }
                    }, pairingPending = pairingPending,
                    onCredits = if (requiresShippingIconCredit(ShippingDesign.icons.channels, BuildConfig.PAID_NOUN_ICONS))
                        ({ credits = true }) else null)
                if (credits) ShippingCredits { credits = false }
                val close = { navigateBack() }
                when {
                    ownerFailed -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::bindCallOwner,
                        title = "Call service unavailable", detail = "Your pairing is kept. Reopen the call service to try again.")
                    (!loaded || owner == null) && !ui.running -> ConnectionOverlay(ConnectionScene.Found, close,
                        title = "Opening device access…", detail = "Checking this phone’s saved connection.")
                    loadFailed && !ui.running -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::loadGrant,
                        title = "Couldn’t open device access", detail = "Your saved access has been kept. Try again; if this continues, repair the app’s device access manually.")
                    pairingPending && showPendingPairing -> ConnectionOverlay(
                        if (enrollment?.isActive == true) ConnectionScene.Found else ConnectionScene.Failed, close,
                        action = ::retryPairing,
                        title = setupTitle ?: "Finish pairing",
                        detail = setupDetail ?: "This phone saved its pairing request. Retry to finish the same request with your desktop.",
                        actionLabel = if (enrollment?.isActive == true) null else "Retry pairing")
                    !hasGrant && !pairingPending && navigation.route == CallRoute.Scanner -> {
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

                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        epoch++
        bindCallOwner()
        loadGrant()
    }

    private fun bindCallOwner() {
        if (binding && owner != null) return
        if (binding) { unbindService(serviceConnection); binding = false }
        ownerFailed = false
        binding = bindService(Intent(this, CallService::class.java), serviceConnection, Context.BIND_AUTO_CREATE)
        if (!binding) ownerFailed = true
    }

    private fun showNavigationHint() {
        hint?.cancel()
        hint = Toast.makeText(this, CALL_NAVIGATION_HINT, Toast.LENGTH_LONG).also { it.show() }
    }

    private fun navigateBack() {
        controller?.release()
        navigation = navigation.back().consumeAutoConnect()
        microphoneNeeded = false
        showPendingPairing = false
        pendingPermission = false
        if (enrollment?.isActive == true) {
            epoch++
            enrollment?.cancel()
            loadGrantAfter(enrollment)
        }
    }

    private fun disconnect() {
        owner?.disconnect()
        navigation = navigation.disconnected()
        hintShownThisVisit = false
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("callRoute", navigation.route.name)
        outState.putBoolean("autoConnectPending", navigation.autoConnectPending)
        outState.putBoolean("navigationHintShown", hintShownThisVisit)
        outState.putBoolean("pendingCallPermission", pendingPermission)
        outState.putBoolean("microphoneNeeded", microphoneNeeded)
        outState.putBoolean("microphoneDenied", microphoneDenied)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (CallService.isReturnToCall(intent)) navigation = navigation.enterCall()
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
                val stored = withContext(Dispatchers.IO) { credentials.load() }
                if (visit != epoch) return@launch
                grant = (stored as? StoredCredential.Ready)?.credential
                hasGrant = grant != null
                pairingPending = stored is StoredCredential.Pending
                if (pairingPending) {
                    navigation = navigation.disconnected()
                } else navigation = navigation.loaded(hasGrant)
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
        if (pendingPermission && micAllowed() && resumed && owner != null) { requestCall(); return }
        if (!loadFailed && navigation.shouldAutoConnect(loaded, hasGrant, resumed, owner != null)) {
            navigation = navigation.consumeAutoConnect()
            if (controller?.ui?.running != true) requestCall()
        }
    }

    private fun scanAgain() {
        if (enrollment?.isActive == true || hasGrant || pairingPending) return
        scene = null
        setupTitle = null
        setupDetail = null
    }

    private fun acceptCode(value: String) {
        if (!resumed || !loaded || loadFailed || hasGrant || pairingPending || scene != null || enrollment?.isActive == true) return
        try { PairingQr.parse(value) } catch (_: Exception) {
            scene = ConnectionScene.Invalid
            setupDetail = "Use Pair phone… in the AgentVoice desktop menu to show a new pairing code."
            return
        }
        enroll { pairing.enrollPairing(value, Build.MODEL.take(80).ifBlank { "Android phone" }) }
    }

    private fun retryPairing() {
        if (!resumed || !loaded || loadFailed || hasGrant || !pairingPending || enrollment?.isActive == true) return
        enroll { pairing.retryPairing() }
    }

    private fun enroll(operation: suspend () -> PairedDevice) {
        val visit = epoch
        navigation = navigation.consumeAutoConnect()
        scene = ConnectionScene.Found
        setupTitle = "Pairing your phone…"
        setupDetail = "Keep AgentVoice open on your desktop."
        enrollment = lifecycleScope.launch {
            try {
                val paired = operation()
                if (visit != epoch || !resumed) return@launch
                grant = paired
                hasGrant = true
                pairingPending = false
                showPendingPairing = false
                scene = null
                requestCall()
            } catch (_: TimeoutCancellationException) {
                if (visit == epoch) pairingFailed("Pairing timed out", "Check your desktop and Tailscale, then retry the saved request.")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: PairingFailure) {
                if (visit == epoch) {
                    val copy = pairingFailureCopy(failure.problem)
                    pairingFailed(copy.first, copy.second)
                }
            } catch (_: Exception) {
                if (visit == epoch) pairingFailed("Couldn’t save device access", "Your saved access is retained. Reopen the app to check it; manual repair may be needed.")
            } finally {
                // The request may have reached the server before cancellation. Reconcile the
                // durable tuple without replaying enrollment or opening a call in a later visit.
                if (visit == epoch && !hasGrant) {
                    try {
                        val stored = withContext(NonCancellable + Dispatchers.IO) { credentials.load() }
                        if (visit == epoch) {
                            grant = (stored as? StoredCredential.Ready)?.credential
                            hasGrant = grant != null
                            pairingPending = stored is StoredCredential.Pending
                            if (pairingPending) {
                                navigation = navigation.disconnected()
                                showPendingPairing = resumed
                            } else if (hasGrant) navigation = navigation.disconnected()
                        }
                    } catch (_: Exception) { if (visit == epoch) loadFailed = true }
                }
            }
        }
    }

    private fun pairingFailed(title: String, detail: String) {
        scene = ConnectionScene.Failed
        setupTitle = title
        setupDetail = detail
    }

    private fun micAllowed() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun requestCall() {
        if (!resumed || !loaded || loadFailed || grant == null || owner == null) return
        navigation = navigation.enterCall()
        if (controller?.ui?.running == true) return
        if (!micAllowed()) { microphoneNeeded = true; return }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            val preferences = getSharedPreferences("connection-guidance", MODE_PRIVATE)
            if (!preferences.getBoolean("notification-permission-asked", false)) {
                preferences.edit().putBoolean("notification-permission-asked", true).apply()
                pendingPermission = true
                permission.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                return
            }
        }
        pendingPermission = false
        microphoneNeeded = false
        microphoneDenied = false
        grant?.let {
            try { CallService.requestForegroundStart(this); owner?.startCall(it) }
            catch (_: Exception) { controller?.stop("Could not start voice. Check microphone permission and Tailscale.") }
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
        if (!hasFocus) controller?.release()
    }
    override fun onPause() {
        resumed = false
        enrollment?.cancel()
        controller?.release()
        hint?.cancel()
        super.onPause()
    }
    override fun onStop() {
        epoch++
        loading?.cancel()
        enrollment?.cancel()
        if (binding) { unbindService(serviceConnection); binding = false }
        owner = null
        super.onStop()
    }
    override fun onDestroy() {
        hint?.cancel()
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
