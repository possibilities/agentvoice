package com.arthack.agentvoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CallOwnerTest {
    private val grant = DeviceGrant.parse(
        """{"version":1,"endpoint":"wss://example.test/v2/client","token":"${"a".repeat(32)}.${"b".repeat(64)}"}""",
    )

    private class FakeController(
        private val changed: (CallUi) -> Unit,
        private val events: MutableList<String>? = null,
    ) : OwnedCallController {
        override var ui = CallUi()
            private set
        var muteCalls = 0
        var startCalls = 0
        var disposed = false

        private fun update(value: CallUi) {
            ui = value
            changed(value)
        }

        override fun start(credential: CallCredential) {
            events?.add("controller")
            startCalls++
            // The real controller clears its previous generation before publishing Connecting.
            update(CallUi())
            update(CallUi(running = true, phase = "Connecting"))
        }

        override fun toggleMute(target: String) {
            assertEquals("mic", target)
            muteCalls++
        }

        override fun hold() = Unit
        override fun release() = Unit
        override fun stop(message: String?) = update(CallUi(message = message))
        override fun dispose() {
            disposed = true
            update(CallUi())
        }

        fun authoritative(value: CallUi) = update(value)
    }

    @Test fun controllerSurvivesBindingChangesAndStartupResetDoesNotDropOwnership() {
        val notifications = mutableListOf<Pair<CallNotificationState?, String?>>()
        val events = mutableListOf<String>()
        lateinit var fake: FakeController
        val owner = CallOwner(
            controllerFactory = { changed -> FakeController(changed, events).also { fake = it } },
            nowElapsedRealtime = { 40L },
            newSession = { "session" },
            notificationChanged = { state, session ->
                notifications += state to session
                events += if (state == null) "notification-ended" else "notification"
            },
            lifetimeStarted = { events += "lock" },
            lifetimeEnded = { events += "unlock" },
        )
        val firstBinding = owner.controller

        owner.start(grant)
        val rebound = owner.controller

        assertSame(firstBinding, rebound)
        assertTrue(fake.ui.running)
        assertEquals("session", owner.activeSession)
        assertEquals(listOf("Connecting"), notifications.mapNotNull { it.first?.phase })
        assertFalse(notifications.any { it.first == null })
        assertEquals(listOf("notification", "lock", "controller"), events)

        owner.disconnect()
        owner.dispose()
        assertEquals(listOf("notification", "lock", "controller", "unlock", "notification-ended"), events)
    }

    @Test fun notificationIgnoresLevelsAndOldActionsCannotControlSuccessor() {
        val notifications = mutableListOf<Pair<CallNotificationState?, String?>>()
        lateinit var fake: FakeController
        var sessionNumber = 0
        val owner = CallOwner(
            controllerFactory = { changed -> FakeController(changed).also { fake = it } },
            nowElapsedRealtime = { 40L },
            newSession = { "session-${++sessionNumber}" },
            notificationChanged = { state, session -> notifications += state to session },
        )
        owner.start(grant)
        val firstSession = owner.activeSession!!
        val beforeLevel = notifications.size
        fake.authoritative(fake.ui.copy(inputLevel = 0.9f, outputLevel = 0.7f))
        assertEquals(beforeLevel, notifications.size)

        fake.authoritative(fake.ui.copy(micMuted = false))
        assertEquals("Mute", notifications.last().first!!.micAction)
        assertTrue(owner.hangUp(firstSession))
        assertEquals(null to null, notifications.last())

        owner.start(grant)
        val successor = owner.activeSession!!
        assertNotEquals(firstSession, successor)
        assertFalse(owner.toggleMicrophone(firstSession))
        assertEquals(0, fake.muteCalls)
        assertTrue(owner.toggleMicrophone(successor))
        assertEquals(1, fake.muteCalls)
    }

    @Test fun foregroundPublicationFailureDoesNotStartControllerOrRetainSession() {
        lateinit var fake: FakeController
        var lockStarts = 0
        val owner = CallOwner(
            controllerFactory = { changed -> FakeController(changed).also { fake = it } },
            nowElapsedRealtime = { 40L },
            newSession = { "session" },
            notificationChanged = { _, _ -> error("foreground unavailable") },
            lifetimeStarted = { lockStarts++ },
        )

        val failure = runCatching { owner.start(grant) }.exceptionOrNull()

        assertEquals("foreground unavailable", failure?.message)
        assertEquals(0, fake.startCalls)
        assertFalse(fake.ui.running)
        assertNull(owner.activeSession)
        assertEquals(0, lockStarts)
    }

    @Test fun wakeLockFailureRemovesNotificationAndNeverStartsController() {
        lateinit var fake: FakeController
        val events = mutableListOf<String>()
        val owner = CallOwner(
            controllerFactory = { changed -> FakeController(changed).also { fake = it } },
            nowElapsedRealtime = { 40L },
            newSession = { "session" },
            notificationChanged = { state, _ ->
                events += if (state == null) "notification-ended" else "notification"
            },
            lifetimeStarted = {
                events += "lock"
                error("wake lock unavailable")
            },
            lifetimeEnded = { events += "unlock" },
        )

        val failure = runCatching { owner.start(grant) }.exceptionOrNull()

        assertEquals("wake lock unavailable", failure?.message)
        assertEquals(0, fake.startCalls)
        assertNull(owner.activeSession)
        assertEquals(listOf("notification", "lock", "unlock", "notification-ended"), events)
    }
}
