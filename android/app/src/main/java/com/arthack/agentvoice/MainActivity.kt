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
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
    private var profiles by mutableStateOf(ServerProfiles(null, emptyList()))
    private var busyProfileId by mutableStateOf<String?>(null)
    private var profileErrorId by mutableStateOf<String?>(null)
    private var forgetting by mutableStateOf<ServerProfile?>(null)
    private var selection: Job? = null
    private val selectionOperation = ActivityOperation()
    private val loadingOperation = ActivityOperation()
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
    private var pendingPermission by mutableStateOf(false)
    private var recoverPairingOnLoad = false
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
        navigation = CallNavigation(
            route = savedInstanceState?.getString("callRoute")?.let { runCatching { CallRoute.valueOf(it) }.getOrNull() }
                ?: CallRoute.Persona,
            autoConnectPending = savedInstanceState?.getBoolean("autoConnectPending", true) ?: true)
        hintShownThisVisit = savedInstanceState?.getBoolean("navigationHintShown") ?: false
        pendingPermission = savedInstanceState?.getBoolean("pendingCallPermission") ?: false
        recoverPairingOnLoad = savedInstanceState?.getBoolean("recoverPairingOnLoad") ?: false
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
                val presentation = voicePresentation(ui, voicePreparation(
                    loaded = loaded, ownerReady = owner != null, ownerFailed = ownerFailed,
                    // Reloading profile metadata cannot redefine a retained call's transport state.
                    loadFailed = loadFailed && !ui.running, autoConnectPending = navigation.autoConnectPending,
                    selecting = busyProfileId != null, awaitingAction = microphoneNeeded || pendingPermission))
                CallWindowPresentation(window, inPersona, ui.running)
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
                    onBack = ::navigateBack, onNavigationHint = ::showNavigationHint, presentation = presentation)
                else ConnectionScreen(ui, hasGrant, ::requestCall,
                    onReturnToCall = { navigation = navigation.enterCall() }, onDisconnect = ::disconnect,
                    onScan = {
                        if (pairingPending) showPendingPairing = true
                        else { scanAgain(); navigation = navigation.scan() }
                    }, pairingPending = pairingPending,
                    profiles = profiles.profiles, selectedProfileId = profiles.selectedId,
                    attemptedProfileId = owner?.attemptedProfileId,
                    busyProfileId = busyProfileId, profileErrorId = profileErrorId,
                    accessMessage = if (ui.running && loadFailed) {
                        if (ui.connected) "Saved servers couldn’t be opened. Your call is still active."
                        else "Saved servers couldn’t be opened. You can still end the current attempt."
                    } else if (ui.running && !loaded) "Opening saved servers…" else null,
                    onRetryAccess = if (loadFailed) ::loadGrant else null,
                    onConnectProfile = ::connectProfile, onForgetProfile = { id ->
                        forgetting = profiles.profiles.firstOrNull { it.id == id }
                    },
                    onCredits = if (requiresShippingIconCredit(ShippingDesign.icons.channels, BuildConfig.PAID_NOUN_ICONS))
                        ({ credits = true }) else null)
                if (credits) ShippingCredits { credits = false }
                forgetting?.let { profile ->
                    val active = ui.running && owner?.attemptedProfileId == profile.id
                    AlertDialog(
                        onDismissRequest = { forgetting = null },
                        title = { Text("Forget ${profile.name}?") },
                        text = { Text(if (active)
                            "This will disconnect your call and remove this saved connection. Server access is not revoked. You’ll need a new code to pair again."
                            else "Remove this saved connection from this phone. Server access is not revoked. You’ll need a new code to pair again.") },
                        confirmButton = { TextButton(onClick = {
                            forgetting = null
                            forgetProfile(profile.id)
                        }) { Text(if (active) "Disconnect and forget" else "Forget server") } },
                        dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
                    )
                }
                ui.takeover?.let { challenge ->
                    val cancel = {
                        if (controller?.cancelTakeover(challenge) == true) {
                            navigation = navigation.disconnected()
                            hintShownThisVisit = false
                        }
                    }
                    AlertDialog(
                        onDismissRequest = cancel,
                        title = { Text("Move voice to this phone?") },
                        text = { Text("Another client is using voice. Connecting here will disconnect its audio. Your conversation and agent work will continue.") },
                        confirmButton = {
                            TextButton(onClick = {
                                if (resumed) controller?.confirmTakeover(challenge)
                            }) { Text("Connect here") }
                        },
                        dismissButton = { TextButton(onClick = cancel) { Text("Cancel") } },
                    )
                }
                val close = { navigateBack() }
                when {
                    ownerFailed -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::bindCallOwner,
                        title = "Call service unavailable", detail = "Your pairing is kept. Reopen the call service to try again.")
                    (!loaded || owner == null) && !ui.running && !inPersona -> ConnectionOverlay(ConnectionScene.Found, close,
                        title = "Opening device access…", detail = "Checking this phone’s saved connection.")
                    loadFailed && !ui.running -> ConnectionOverlay(ConnectionScene.Failed, close, action = ::loadGrant,
                        title = "Couldn’t open device access", detail = "Your saved access has been kept. Try again; if this continues, repair the app’s device access manually.")
                    pairingPending && showPendingPairing -> ConnectionOverlay(
                        if (enrollment?.isActive == true) ConnectionScene.Found else ConnectionScene.Failed, close,
                        action = ::retryPairing,
                        title = setupTitle ?: "Finish pairing",
                        detail = setupDetail ?: "This phone saved its pairing request. Retry to finish the same request with your desktop.",
                        actionLabel = if (enrollment?.isActive == true) null else "Retry pairing")
                    !pairingPending && navigation.route == CallRoute.Scanner -> {
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
        selectionOperation.invalidate()
        selection?.cancel()
        busyProfileId = null
        if (enrollment?.isActive == true) {
            epoch++
            enrollment?.cancel()
            loadGrantAfter(enrollment)
        }
    }

    private fun disconnect() {
        selectionOperation.invalidate()
        selection?.cancel()
        busyProfileId = null
        pendingPermission = false
        owner?.disconnect()
        navigation = navigation.disconnected()
        hintShownThisVisit = false
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("callRoute", navigation.route.name)
        outState.putBoolean("autoConnectPending", navigation.autoConnectPending)
        outState.putBoolean("navigationHintShown", hintShownThisVisit)
        outState.putBoolean("pendingCallPermission", pendingPermission)
        outState.putBoolean("recoverPairingOnLoad", recoverPairingOnLoad)
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
        val token = loadingOperation.begin()
        fun current() = visit == epoch && loadingOperation.owns(token)
        loading?.cancel()
        loaded = false
        loadFailed = false
        loading = lifecycleScope.launch {
            try {
                pendingWrite?.join()
                val saved = withContext(Dispatchers.IO) { credentials.listProfiles() }
                if (!current()) return@launch
                applyProfiles(saved)
                navigation = navigation.loaded(hasGrant, pairingPending, recoverPairingOnLoad, saved.profiles.isNotEmpty())
                recoverPairingOnLoad = false
                scene = null
                setupTitle = null
                setupDetail = null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (current()) loadFailed = true }
            finally {
                if (current()) { loaded = true; maybeConnect() }
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
        if (enrollment?.isActive == true || pairingPending) return
        scene = null
        setupTitle = null
        setupDetail = null
    }

    private fun acceptCode(value: String) {
        if (!resumed || !loaded || loadFailed || pairingPending || scene != null || enrollment?.isActive == true) return
        try { PairingQr.parse(value) } catch (_: Exception) {
            scene = ConnectionScene.Invalid
            setupDetail = "Use Pair phone… in the AgentVoice desktop menu to show a new pairing code."
            return
        }
        enroll { pairing.enrollPairing(value, Build.MODEL.take(80).ifBlank { "Android phone" }) }
    }

    private fun retryPairing() {
        if (!resumed || !loaded || loadFailed || !pairingPending || enrollment?.isActive == true) return
        val pending = profiles.profiles.firstOrNull { it.state == ServerProfileState.PENDING } ?: return
        enroll { pairing.retryPairing(pending.id) }
    }

    private fun enroll(operation: suspend () -> CompletedPairing) {
        val visit = epoch
        navigation = navigation.consumeAutoConnect()
        scene = ConnectionScene.Found
        recoverPairingOnLoad = true
        setupTitle = "Pairing your phone…"
        setupDetail = "Keep AgentVoice open on your desktop."
        enrollment = lifecycleScope.launch {
            var interrupted = false
            try {
                val paired = operation()
                if (visit != epoch || !resumed) { interrupted = true; return@launch }
                applyProfiles(paired.profiles)
                recoverPairingOnLoad = false
                profileErrorId = null
                showPendingPairing = false
                scene = null
                navigation = navigation.disconnected()
            } catch (_: TimeoutCancellationException) {
                if (visit == epoch) pairingFailed("Pairing timed out", "Check your desktop and Tailscale, then retry the saved request.")
            } catch (cancelled: CancellationException) {
                interrupted = true
                throw cancelled
            } catch (failure: PairingFailure) {
                if (visit == epoch) {
                    val copy = pairingFailureCopy(failure.problem)
                    pairingFailed(copy.first, copy.second)
                }
            } catch (failure: ProfileStoreFailure) {
                if (visit == epoch) {
                    when (failure.problem) {
                        ProfileStoreProblem.DuplicateEndpoint ->
                            pairingFailed("Server already saved", "Use its saved connection, or forget it before pairing again.")
                        ProfileStoreProblem.PairingAlreadyPending ->
                            pairingFailed("Pairing not finished", "Finish the saved pairing request before adding another server.")
                        else -> pairingFailed("Couldn’t save device access", "Your saved access has been kept. Try again.")
                    }
                }
            } catch (_: Exception) {
                if (visit == epoch) pairingFailed("Couldn’t save device access", "Your saved access is retained. Reopen the app to check it; manual repair may be needed.")
            } finally {
                // The request may have reached the server before cancellation. Reconcile the
                // durable tuple without replaying enrollment or opening a call on Activity resume.
                // Pairing never selects a server; only explicit Connect changes the cold-launch target.
                if (visit == epoch) {
                    try {
                        val saved = withContext(NonCancellable + Dispatchers.IO) { credentials.listProfiles() }
                        if (visit == epoch) {
                            applyProfiles(saved)
                            if (pairingPending) {
                                navigation = navigation.disconnected()
                                showPendingPairing = resumed
                            } else if (recoverPairingOnLoad && interrupted) {
                                navigation = navigation.disconnected()
                                scene = null
                                setupTitle = null
                                setupDetail = null
                            }
                            recoverPairingOnLoad = false
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

    private fun applyProfiles(saved: ServerProfiles) {
        profiles = saved
        hasGrant = saved.profiles.any { it.id == saved.selectedId && it.state == ServerProfileState.READY }
        pairingPending = saved.profiles.any { it.state == ServerProfileState.PENDING }
    }

    private fun requestCall() {
        profiles.selectedId?.let(::connectProfile)
    }

    private fun connectProfile(id: String) {
        if (!resumed || !loaded || loadFailed || owner == null || busyProfileId != null) return
        if (owner?.attemptedProfileId == id && controller?.ui?.running == true) {
            navigation = navigation.enterCall()
            return
        }
        val visit = epoch
        val token = selectionOperation.begin()
        fun current() = visit == epoch && selectionOperation.owns(token)
        navigation = navigation.consumeAutoConnect()
        busyProfileId = id
        selection = lifecycleScope.launch {
            try {
                val (credential, saved) = withContext(Dispatchers.IO) {
                    credentials.credential(id) to credentials.select(id)
                }
                if (!current() || !resumed) return@launch
                applyProfiles(saved)
                profileErrorId = null
                // Disconnect is synchronous: the old transport and media close before permission/start.
                if (controller?.ui?.running == true && owner?.attemptedProfileId != id) owner?.disconnect()
                startPreparedCall(id, credential)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (current()) {
                    profileErrorId = id
                    navigation = navigation.disconnected()
                }
            } finally {
                if (current()) busyProfileId = null
            }
        }
    }

    private fun forgetProfile(id: String) {
        if (!resumed || busyProfileId != null || enrollment?.isActive == true) return
        if (controller?.ui?.running == true && owner?.attemptedProfileId == id) disconnect()
        val visit = epoch
        val token = selectionOperation.begin()
        fun current() = visit == epoch && selectionOperation.owns(token)
        busyProfileId = id
        navigation = navigation.disconnected()
        pendingPermission = false
        selection = lifecycleScope.launch {
            try {
                val saved = withContext(Dispatchers.IO) { credentials.forget(id) }
                if (current()) {
                    applyProfiles(saved)
                    profileErrorId = null
                    showPendingPairing = false
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (current()) loadFailed = true }
            finally { if (current()) busyProfileId = null }
        }
    }

    private fun startPreparedCall(id: String, credential: CallCredential) {
        if (!resumed || owner == null) return
        navigation = navigation.enterCall()
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
        try { CallService.requestForegroundStart(this); owner?.startCall(credential, id) }
        catch (_: Exception) { controller?.stop("Could not start voice. Check microphone permission and Tailscale.") }
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
        selectionOperation.invalidate()
        selection?.cancel()
        busyProfileId = null
        controller?.release()
        hint?.cancel()
        super.onPause()
    }
    override fun onStop() {
        epoch++
        loading?.cancel()
        enrollment?.cancel()
        selectionOperation.invalidate()
        selection?.cancel()
        busyProfileId = null
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
