package com.arthack.agentvoice

import java.util.UUID

/** Owns one controller independently of Activity bindings and fences notification actions per call. */
internal class CallOwner(
    controllerFactory: ((CallUi) -> Unit) -> OwnedCallController,
    private val nowElapsedRealtime: () -> Long,
    private val newSession: () -> String = { UUID.randomUUID().toString() },
    private val notificationChanged: (CallNotificationState?, String?) -> Unit,
    private val lifetimeStarted: () -> Unit = {},
    private val lifetimeEnded: () -> Unit = {},
) {
    val controller: OwnedCallController = controllerFactory(::onUiChanged)
    var activeSession: String? = null
        private set
    private var startedAtElapsedRealtime = 0L
    private var starting = false
    private var disposed = false
    private var lastNotification: CallNotificationState? = null
    private var lifetimeActive = false

    fun start(credential: CallCredential) {
        check(!disposed)
        if (controller.ui.running) return
        activeSession = newSession()
        startedAtElapsedRealtime = nowElapsedRealtime()
        starting = true
        try {
            // Foreground publication must succeed before controller.start can open audio.
            publish(CallUi(running = true, phase = "Connecting"))
            beginLifetime()
            controller.start(credential)
            if (controller.ui.running) publish(controller.ui) else finish()
        } catch (failure: Throwable) {
            if (controller.ui.running) runCatching {
                controller.stop("Could not keep the call active in Android.")
            }
            abandonAfterFailure()
            throw failure
        } finally {
            starting = false
        }
    }

    fun toggleMicrophone(session: String?): Boolean {
        if (!ownsNotificationAction(activeSession, session) || !controller.ui.running) return false
        controller.toggleMute("mic")
        return true
    }

    fun hangUp(session: String?): Boolean {
        if (!ownsNotificationAction(activeSession, session) || !controller.ui.running) return false
        controller.stop("Call ended.")
        return true
    }

    fun disconnect() {
        if (controller.ui.running) controller.stop("Call ended.") else finish()
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        starting = true
        try {
            controller.dispose()
        } finally {
            starting = false
            finish()
        }
    }

    private fun onUiChanged(ui: CallUi) {
        if (starting && !ui.running) return
        if (ui.running) publish(ui) else finish()
    }

    private fun publish(ui: CallUi) {
        val state = callNotificationState(ui, startedAtElapsedRealtime) ?: return
        if (state == lastNotification) return
        notificationChanged(state, activeSession)
        lastNotification = state
    }

    private fun abandonAfterFailure() {
        val published = lastNotification != null
        runCatching { endLifetime() }
        activeSession = null
        startedAtElapsedRealtime = 0L
        lastNotification = null
        if (published) runCatching { notificationChanged(null, null) }
    }

    private fun finish() {
        val hadCall = activeSession != null || lastNotification != null
        runCatching { endLifetime() }
        activeSession = null
        startedAtElapsedRealtime = 0L
        lastNotification = null
        if (hadCall) notificationChanged(null, null)
    }

    private fun beginLifetime() {
        if (lifetimeActive) return
        lifetimeActive = true
        lifetimeStarted()
    }

    private fun endLifetime() {
        if (!lifetimeActive) return
        lifetimeActive = false
        lifetimeEnded()
    }
}
