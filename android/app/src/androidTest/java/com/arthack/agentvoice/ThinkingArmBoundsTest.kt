@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.os.SystemClock
import android.view.LayoutInflater
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import app.rive.runtime.kotlin.core.Rive
import app.rive.runtime.kotlin.core.SMIBoolean
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ThinkingArmBoundsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private data class AlphaBounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width get() = right - left + 1
        val height get() = bottom - top + 1
    }

    private data class Samples(
        val bounds: List<AlphaBounds>,
        val signatures: Set<Int>,
        val elapsedMs: Long,
    )

    private fun source(): ByteArray = InstrumentationRegistry.getInstrumentation().targetContext.resources
        .openRawResource(R.raw.persona_halo).use { it.readBytes() }

    private fun pixels(view: CompactHaloAnimationView): IntArray? = compose.runOnIdle {
        view.getBitmap(256, 256)?.let { bitmap ->
            IntArray(256 * 256).also { bitmap.getPixels(it, 0, 256, 0, 0, 256, 256); bitmap.recycle() }
        }
    }

    private fun bounds(pixels: IntArray): AlphaBounds? {
        var left = 256
        var top = 256
        var right = -1
        var bottom = -1
        pixels.forEachIndexed { index, color ->
            if ((color ushr 24) >= 40) {
                val x = index % 256
                val y = index / 256
                left = minOf(left, x); top = minOf(top, y)
                right = maxOf(right, x); bottom = maxOf(bottom, y)
            }
        }
        return if (right < left) null else AlphaBounds(left, top, right, bottom)
    }

    private fun alpha(pixels: IntArray) = IntArray(pixels.size) { pixels[it] ushr 24 }

    private fun sampleLoop(candidate: CompactHaloAnimationView, prior: CompactHaloAnimationView): Pair<Samples, Samples> {
        val candidateBounds = mutableListOf<AlphaBounds>()
        val priorBounds = mutableListOf<AlphaBounds>()
        val candidateSignatures = mutableSetOf<Int>()
        val priorSignatures = mutableSetOf<Int>()
        val started = SystemClock.uptimeMillis()
        do {
            val candidatePixels = requireNotNull(pixels(candidate))
            val priorPixels = requireNotNull(pixels(prior))
            candidateBounds += requireNotNull(bounds(candidatePixels))
            priorBounds += requireNotNull(bounds(priorPixels))
            candidateSignatures += alpha(candidatePixels).contentHashCode()
            priorSignatures += alpha(priorPixels).contentHashCode()
            SystemClock.sleep(25)
        } while (SystemClock.uptimeMillis() - started < 3500)
        val elapsed = SystemClock.uptimeMillis() - started
        return Samples(candidateBounds, candidateSignatures, elapsed) to
            Samples(priorBounds, priorSignatures, elapsed)
    }

    @Test fun currentCompactReachStaysUnchanged() = compareWingspan(2)

    @Test fun smallestWingspanKeepsTheCircleAndMovingArms() = compareWingspan(1)

    @Test fun midpointWingspanRemainsBetweenCompactAndOriginal() = compareWingspan(5)

    private fun compareWingspan(wingspan: Int) {
        val tuning = CompactHaloTuning(idleBreathingPercent = 0, thinkingWingspan = wingspan)
        val candidateBytes = compactHaloBytes(source(), tuning)
        val priorBytes = compactHaloBytes(source(), tuning.copy(thinkingWingspan = 10))
        lateinit var candidate: CompactHaloAnimationView
        lateinit var prior: CompactHaloAnimationView
        compose.setContent {
            Column {
                AndroidView(factory = { context ->
                    Rive.init(context)
                    (LayoutInflater.from(context).inflate(R.layout.persona_halo_contained, null, false) as CompactHaloAnimationView)
                        .also { it.loadSource(candidateBytes); it.present(PersonaState.Idle, 0xFFFFFFFF.toInt(), false); candidate = it }
                }, modifier = Modifier.size(240.dp), onRelease = { it.pause() })
                AndroidView(factory = { context ->
                    (LayoutInflater.from(context).inflate(R.layout.persona_halo_contained, null, false) as CompactHaloAnimationView)
                        .also { it.loadSource(priorBytes); it.present(PersonaState.Idle, 0xFFFFFFFF.toInt(), false); prior = it }
                }, modifier = Modifier.size(240.dp), onRelease = { it.pause() })
            }
        }
        compose.waitForIdle()
        compose.waitUntil(5000) {
            pixels(candidate)?.let(::bounds) != null && pixels(prior)?.let(::bounds) != null &&
                !candidate.isPlaying && !prior.isPlaying
        }
        val candidateIdlePixels = requireNotNull(pixels(candidate))
        val priorIdlePixels = requireNotNull(pixels(prior))
        val idle = requireNotNull(bounds(candidateIdlePixels))
        assertEquals("Thinking-only scale edits must preserve the still Idle circle bounds",
            idle, requireNotNull(bounds(priorIdlePixels)))

        compose.runOnIdle {
            candidate.present(PersonaState.Thinking, 0xFFFFFFFF.toInt(), true)
            prior.present(PersonaState.Thinking, 0xFFFFFFFF.toInt(), true)
        }
        compose.waitUntil(5000) {
            candidate.isPlaying && prior.isPlaying &&
                (candidate.stateMachines.single().input("thinking") as SMIBoolean).value &&
                (prior.stateMachines.single().input("thinking") as SMIBoolean).value
        }
        val (candidateSamples, priorSamples) = sampleLoop(candidate, prior)
        assertTrue("Thinking sampling must span the complete 195-frame loop", candidateSamples.elapsedMs >= 3250)
        assertTrue("Candidate Thinking animation did not move", candidateSamples.signatures.size >= 3)
        assertTrue("Prior Thinking animation did not move", priorSamples.signatures.size >= 3)

        val candidateMaxWidth = candidateSamples.bounds.maxOf { it.width }
        val priorMaxWidth = priorSamples.bounds.maxOf { it.width }
        val candidateTop = candidateSamples.bounds.minOf { it.top }
        val candidateBottom = candidateSamples.bounds.maxOf { it.bottom }
        val priorTop = priorSamples.bounds.minOf { it.top }
        val priorBottom = priorSamples.bounds.maxOf { it.bottom }
        val candidateYExtent = candidateBottom - candidateTop + 1
        val priorYExtent = priorBottom - priorTop + 1
        android.util.Log.i("ThinkingArmBounds", "wingspan=$wingspan idle=${idle.width}x${idle.height} candidateWidth=$candidateMaxWidth priorWidth=$priorMaxWidth candidateY=$candidateTop..$candidateBottom priorY=$priorTop..$priorBottom frames=${candidateSamples.signatures.size}/${priorSamples.signatures.size} elapsedMs=${candidateSamples.elapsedMs}")
        if (wingspan <= 2) assertTrue("Candidate width $candidateMaxWidth must stay near Idle width ${idle.width}",
            candidateMaxWidth <= idle.width * 1.10 + 2)
        else assertTrue("Midpoint must visibly extend beyond the compact reach", candidateMaxWidth > idle.width * 1.10)
        assertTrue("Prior width $priorMaxWidth must materially exceed candidate width $candidateMaxWidth",
            priorMaxWidth >= candidateMaxWidth + idle.width * .08)
        assertTrue("Candidate Y extent $candidateYExtent must stay near Idle height ${idle.height}",
            candidateYExtent <= idle.height * 1.10 + 2)
        assertTrue("Changing only scaleX must preserve the Y envelope: candidate=$candidateTop..$candidateBottom prior=$priorTop..$priorBottom",
            kotlin.math.abs(candidateTop - priorTop) <= 3 && kotlin.math.abs(candidateBottom - priorBottom) <= 3 &&
                kotlin.math.abs(candidateYExtent - priorYExtent) <= 3)
    }
}
