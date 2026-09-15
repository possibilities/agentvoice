package com.arthack.agentvoice

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommunicationDeviceRouterTest {
    private class Routes(var availableRoutes: List<CommunicationRoute>) : CommunicationRouteAccess {
        var selectedRoute: CommunicationRoute? = null
        val operations = mutableListOf<String>()
        val selectionResults = ArrayDeque<Boolean>()

        override fun available() = availableRoutes
        override fun selected() = selectedRoute
        override fun select(route: CommunicationRoute): Boolean {
            operations += "select:${route.id}"
            return selectionResults.removeFirstOrNull() ?: true
        }
        override fun clear() {
            operations += "clear"
            selectedRoute = null
        }
    }

    private class Fixture(
        routes: Routes,
        bluetoothAllowed: Boolean = true,
    ) {
        val timers = ArrayDeque<() -> Unit>()
        var failures = 0
        var ready = 0
        val router = CommunicationDeviceRouter(
            access = routes,
            bluetoothAllowed = { bluetoothAllowed },
            schedule = { delay, action ->
                assertEquals(CommunicationDeviceRouter.ROUTE_TIMEOUT_MILLIS, delay)
                timers += action
            },
            routingFailed = { failures++ },
            routeReady = { ready++ },
        )

        fun timeout() = timers.removeFirst().invoke()
    }

    private val speaker = CommunicationRoute(1, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
    private val wired = CommunicationRoute(2, AudioDeviceInfo.TYPE_WIRED_HEADSET)
    private val classicBluetooth = CommunicationRoute(3, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    private val leBluetooth = CommunicationRoute(4, AudioDeviceInfo.TYPE_BLE_HEADSET)

    @Test fun connectedBluetoothHeadsetReplacesSpeakerWithoutRestartingRouter() {
        val routes = Routes(listOf(speaker)).apply { selectedRoute = speaker }
        val fixture = Fixture(routes)
        val router = fixture.router
        assertTrue(router.start())
        assertEquals(1, fixture.ready)

        routes.availableRoutes = listOf(speaker, classicBluetooth)
        router.devicesChanged()

        assertEquals(speaker, routes.selectedRoute)
        assertEquals(listOf("select:3"), routes.operations)
        routes.selectedRoute = classicBluetooth
        router.communicationDeviceChanged(classicBluetooth)
        router.devicesChanged()
        assertEquals(listOf("select:3"), routes.operations)
    }

    @Test fun disconnectedBluetoothFallsBackToBestRemainingCommunicationDevice() {
        val routes = Routes(listOf(speaker, wired, leBluetooth)).apply { selectedRoute = leBluetooth }
        val router = Fixture(routes).router
        assertTrue(router.start())

        routes.availableRoutes = listOf(speaker, wired)
        routes.selectedRoute = null // Android clears a request when its device disconnects.
        router.devicesChanged()

        assertEquals(listOf("select:2"), routes.operations)
        routes.selectedRoute = wired
        router.communicationDeviceChanged(wired)
        router.devicesChanged()
        assertEquals(listOf("select:2"), routes.operations)
    }

    @Test fun failedSelectionIsClearedAndRetriedWithRefreshedAvailability() {
        val routes = Routes(listOf(speaker)).apply {
            selectedRoute = speaker
            selectionResults += listOf(false, true)
        }
        val router = Fixture(routes).router
        assertTrue(router.start())

        routes.availableRoutes = listOf(speaker, leBluetooth)
        router.devicesChanged()

        assertEquals(listOf("select:4", "clear", "select:4"), routes.operations)
        routes.selectedRoute = leBluetooth
        router.communicationDeviceChanged(leBluetooth)
    }

    @Test fun bluetoothWithoutRuntimePermissionDoesNotReplaceSpeaker() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val router = Fixture(routes, bluetoothAllowed = false).router

        assertTrue(router.start())
        assertEquals(speaker, routes.selectedRoute)
        assertTrue(routes.operations.isEmpty())
    }

    @Test fun stoppedRouterIgnoresLaterDeviceCallbacks() {
        val routes = Routes(listOf(speaker)).apply { selectedRoute = speaker }
        val router = Fixture(routes).router
        assertTrue(router.start())
        router.stop()

        routes.availableRoutes = listOf(speaker, classicBluetooth)
        router.devicesChanged()

        assertEquals(null, routes.selectedRoute)
        assertEquals(listOf("clear"), routes.operations)
        assertFalse(routes.operations.any { it == "select:3" })
    }

    @Test fun acceptedRequestWaitsForExactRouteAndDeduplicatesInventoryCallbacks() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val router = Fixture(routes).router
        assertTrue(router.start())

        router.devicesChanged()
        router.communicationDeviceChanged(speaker)
        router.devicesChanged()

        assertEquals(listOf("select:4"), routes.operations)
    }

    @Test fun unconfirmedBluetoothRequestRetriesOnceThenFallsBackAndStops() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val fixture = Fixture(routes)
        assertTrue(fixture.router.start())

        fixture.timeout()
        fixture.timeout()
        fixture.timeout()

        assertEquals(listOf("select:4", "clear", "select:4", "clear", "select:1", "clear"), routes.operations)
        assertEquals(1, fixture.failures)
    }

    @Test fun startupAudioBecomesReadyOnlyAfterExactRequestedRouteIsEffective() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val fixture = Fixture(routes)

        assertTrue(fixture.router.start())
        assertEquals(0, fixture.ready)
        routes.selectedRoute = leBluetooth
        fixture.router.communicationDeviceChanged(leBluetooth)
        assertEquals(1, fixture.ready)
    }

    @Test fun noExplicitCandidateUsesPlatformDefaultAndReportsReady() {
        val routes = Routes(emptyList())
        val fixture = Fixture(routes)

        assertTrue(fixture.router.start())
        assertEquals(listOf("clear"), routes.operations)
        assertEquals(1, fixture.ready)
        assertEquals(0, fixture.failures)
    }

    @Test fun staleTimeoutsAfterConfirmationAndStopAreFenced() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val fixture = Fixture(routes)
        assertTrue(fixture.router.start())
        routes.selectedRoute = leBluetooth
        fixture.router.communicationDeviceChanged(leBluetooth)

        fixture.timeout()
        routes.availableRoutes = listOf(speaker)
        routes.selectedRoute = null
        fixture.router.devicesChanged()
        fixture.router.stop()
        fixture.timeout()
        fixture.router.devicesChanged()

        assertEquals(listOf("select:4", "select:1", "clear"), routes.operations)
        assertEquals(0, fixture.failures)
    }

    @Test fun lowerPriorityAdditionDoesNotReplaceAnEffectiveBluetoothRoute() {
        val routes = Routes(listOf(speaker, classicBluetooth)).apply { selectedRoute = classicBluetooth }
        val router = Fixture(routes).router
        assertTrue(router.start())

        routes.availableRoutes = listOf(speaker, wired, classicBluetooth)
        router.devicesChanged()

        assertTrue(routes.operations.isEmpty())
    }

    @Test fun confirmationMustMatchBothDeviceIdAndType() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply { selectedRoute = speaker }
        val router = Fixture(routes).router
        assertTrue(router.start())

        router.communicationDeviceChanged(CommunicationRoute(leBluetooth.id, AudioDeviceInfo.TYPE_BLUETOOTH_SCO))
        router.devicesChanged()

        assertEquals(listOf("select:4"), routes.operations)
    }

    @Test fun exhaustedRoutesReportOneFailure() {
        val routes = Routes(listOf(speaker, leBluetooth)).apply {
            selectedRoute = speaker
            selectionResults += listOf(false, false, false)
        }
        val fixture = Fixture(routes)

        assertFalse(fixture.router.start())
        assertEquals(0, fixture.failures)
        routes.selectionResults += listOf(false, false, false)
        fixture.router.devicesChanged()
        assertEquals(1, fixture.failures)
    }
}
