package com.arthack.agentvoice

import android.media.AudioDeviceInfo

internal data class CommunicationRoute(val id: Int, val type: Int)

internal interface CommunicationRouteAccess {
    fun available(): List<CommunicationRoute>
    fun selected(): CommunicationRoute?
    fun select(route: CommunicationRoute): Boolean
    fun clear()
}

/** Keeps one self-managed communication call on the best currently available duplex route. */
internal class CommunicationDeviceRouter(
    private val access: CommunicationRouteAccess,
    private val bluetoothAllowed: () -> Boolean,
    private val schedule: (delayMillis: Long, action: () -> Unit) -> Unit,
    private val routingFailed: () -> Unit,
    private val routeReady: () -> Unit,
) {
    private data class Pending(
        val route: CommunicationRoute,
        val retryAllowed: Boolean,
        val attempted: Set<CommunicationRoute>,
        val revision: Long,
    )

    private var running = false
    private var ready = false
    private var revision = 0L
    private var pending: Pending? = null

    fun start(): Boolean {
        check(!running)
        running = true
        ready = false
        return reconcile()
    }

    fun devicesChanged() {
        if (running && !reconcile()) routingFailed()
    }

    fun communicationDeviceChanged(route: CommunicationRoute?) {
        if (!running) return
        val request = pending ?: return
        if (route == request.route) {
            cancelPending()
            markReady()
        }
    }

    fun stop() {
        if (!running) return
        running = false
        ready = false
        cancelPending()
        access.clear()
    }

    private fun reconcile(): Boolean {
        val target = candidates(access.available()).firstOrNull()
        if (target == null) {
            cancelPending()
            access.clear()
            markReady()
            return true
        }
        if (access.selected() == target) {
            cancelPending()
            markReady()
            return true
        }
        if (pending?.route == target) return true
        return request(target)
    }

    private fun request(target: CommunicationRoute): Boolean {
        cancelPending()
        if (access.select(target)) {
            await(target, retryAllowed = true, attempted = setOf(target))
            return true
        }

        // Android's self-managed call guidance requires clearing a failed request
        // before retrying. Refresh the list because availability may have raced us.
        access.clear()
        val refreshed = candidates(access.available())
        val retry = refreshed.firstOrNull { it == target }
        if (retry != null && access.select(retry)) {
            await(retry, retryAllowed = false, attempted = setOf(retry))
            return true
        }
        access.clear()
        return requestFallback(refreshed, attempted = setOf(target))
    }

    private fun requestFallback(
        routes: List<CommunicationRoute>,
        attempted: Set<CommunicationRoute>,
    ): Boolean {
        val exhausted = attempted.toMutableSet()
        for (fallback in routes.filterNot { it in exhausted }) {
            if (access.select(fallback)) {
                await(fallback, retryAllowed = false, attempted = exhausted + fallback)
                return true
            }
            exhausted += fallback
            access.clear()
        }
        return false
    }

    private fun await(
        route: CommunicationRoute,
        retryAllowed: Boolean,
        attempted: Set<CommunicationRoute>,
    ) {
        val expectedRevision = ++revision
        pending = Pending(route, retryAllowed, attempted, expectedRevision)
        schedule(ROUTE_TIMEOUT_MILLIS) { timedOut(expectedRevision) }
    }

    private fun timedOut(expectedRevision: Long) {
        val request = pending?.takeIf { running && it.revision == expectedRevision } ?: return
        if (access.selected() == request.route) {
            cancelPending()
            markReady()
            return
        }
        cancelPending()
        access.clear()
        val available = candidates(access.available())
        if (request.retryAllowed) {
            val retry = available.firstOrNull { it == request.route }
            if (retry != null && access.select(retry)) {
                await(retry, retryAllowed = false, attempted = request.attempted)
                return
            }
            access.clear()
        }
        if (!requestFallback(available, attempted = request.attempted)) routingFailed()
    }

    private fun cancelPending() {
        revision++
        pending = null
    }

    private fun markReady() {
        if (ready) return
        ready = true
        routeReady()
    }

    private fun candidates(routes: List<CommunicationRoute>): List<CommunicationRoute> {
        val selectable = if (bluetoothAllowed()) routes else routes.filterNot { it.type in BLUETOOTH_TYPES }
        return PRIORITIES.flatMap { type -> selectable.filter { it.type == type } }
    }

    companion object {
        internal const val ROUTE_TIMEOUT_MILLIS = 30_000L
        private val BLUETOOTH_TYPES = setOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_HEARING_AID,
        )
        private val PRIORITIES = listOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_HEARING_AID,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        )
    }
}
