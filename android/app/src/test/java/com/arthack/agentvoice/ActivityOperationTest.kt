package com.arthack.agentvoice

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class ActivityOperationTest {
    @Test fun cancelledPredecessorCannotClearSuccessorPreparationInTheSameVisit() = runBlocking {
        val operation = ActivityOperation()
        val cleanupEntered = CompletableDeferred<Unit>()
        val releaseCleanup = CompletableDeferred<Unit>()
        var busy: String? = "first"
        var loaded = false
        val first = operation.begin()
        val predecessor = launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() }
            finally {
                withContext(NonCancellable) {
                    cleanupEntered.complete(Unit)
                    releaseCleanup.await()
                    if (operation.owns(first)) { busy = null; loaded = true }
                }
            }
        }
        operation.invalidate()
        predecessor.cancel()
        cleanupEntered.await()
        val second = operation.begin()
        busy = "second"
        releaseCleanup.complete(Unit)
        predecessor.join()
        assertEquals("second", busy)
        assertFalse(loaded)
        assertFalse(operation.owns(first))
        assertTrue(operation.owns(second))
        if (operation.owns(second)) { busy = null; loaded = true }
        assertNull(busy)
        assertTrue(loaded)
    }

    @Test fun replacingALoadFencesItsResultErrorAndFinallyBeforeCancellationRuns() {
        val operation = ActivityOperation()
        val old = operation.begin()
        val current = operation.begin()
        assertFalse(operation.owns(old))
        assertTrue(operation.owns(current))
        operation.invalidate()
        assertFalse(operation.owns(current))
    }
}
