package com.arthack.agentvoice

import android.os.Bundle
import android.util.AtomicFile
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

/** Visual calibration only: no grant, controller, socket or media access. */
class PersonaTunerActivity : ComponentActivity() {
    private val selection get() = AtomicFile(File(filesDir, "persona-tuning.json"))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        val initial = runCatching {
            decodePersonaTuning(selection.readFully().toString(Charsets.UTF_8))
        }.getOrDefault(PersonaPlacement())
        setContent {
            VoiceTheme { PersonaTuner(initial, ::saveSelection) }
        }
    }

    private fun saveSelection(placement: PersonaPlacement): Boolean = runCatching {
        val bytes = encodePersonaTuning(placement).toByteArray(Charsets.UTF_8)
        val file = selection
        val stream = file.startWrite()
        try {
            stream.write(bytes)
            file.finishWrite(stream)
        } catch (failure: Throwable) {
            file.failWrite(stream)
            throw failure
        }
    }.isSuccess
}

internal fun decodePersonaTuning(json: String): PersonaPlacement {
    val data = JSONObject(json)
    fun scale(values: JSONObject, key: String): Float {
        val value = values.getDouble(key).toFloat()
        require(value.isFinite())
        return value.coerceIn(.35f, 1.2f)
    }
    return when (data.getInt("version")) {
        // Loading never rewrites the original choice; migration happens only on Save.
        1 -> scale(data, "scaleMultiplier").let { PersonaPlacement(it, it, it) }
        2 -> data.getJSONObject("scaleMultipliers").let {
            PersonaPlacement(scale(it, "speaking"), scale(it, "listening"), scale(it, "idle"))
        }
        else -> error("Unsupported Persona tuning version")
    }
}

internal fun encodePersonaTuning(placement: PersonaPlacement): String {
    fun percent(scale: Float) = (scale * 100).roundToInt() / 100.0
    return JSONObject()
        .put("version", 2)
        .put("scaleMultipliers", JSONObject()
            .put("speaking", percent(placement.speakingScale))
            .put("listening", percent(placement.listeningScale))
            .put("idle", percent(placement.idleScale)))
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("connectedArtboardScale", 1.9)
        .put("disconnectedArtboardScale", 1.5)
        .put("savedAtEpochMs", System.currentTimeMillis())
        .toString(2)
}

@Composable
internal fun PersonaTuner(initial: PersonaPlacement, save: (PersonaPlacement) -> Boolean) {
    var speaking by rememberSaveable { mutableFloatStateOf(initial.speakingScale * 100f) }
    var listening by rememberSaveable { mutableFloatStateOf(initial.listeningScale * 100f) }
    var idle by rememberSaveable { mutableFloatStateOf(initial.idleScale * 100f) }
    var mode by rememberSaveable { mutableStateOf("Speaking") }
    var holding by remember { mutableStateOf(false) }
    var panel by rememberSaveable { mutableStateOf(true) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val placement = PersonaPlacement(speaking / 100f, listening / 100f, idle / 100f)
    val percent = when (mode) { "Speaking" -> speaking; "Listening" -> listening; else -> idle }
    val ui = CallUi(running = true, connected = true, phase = "Connected",
        micMuted = mode != "Listening" || holding, micOpen = mode == "Listening", speakerMuted = false,
        speakerOpen = true, canHold = mode != "Listening" || holding, holding = holding,
        outputLevel = if (mode == "Speaking") .14f else 0f)
    Box(Modifier.fillMaxSize()) {
        VoiceScreen(ui, true, start = {}, stop = { holding = false; mode = "Idle" }, importGrant = {},
            mute = { target -> holding = false; mode = if (target == "mic") {
                if (mode == "Listening") "Idle" else "Listening"
            } else if (mode == "Speaking") "Idle" else "Speaking" },
            hold = { holding = true; mode = "Listening" },
            release = { if (holding) { holding = false; mode = "Idle" } },
            preview = true, personaPlacement = placement)
        // Overlay calibration controls so showing them never changes the actual screen geometry.
        Box(Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(12.dp)) {
            if (panel) {
                Column(Modifier.fillMaxWidth()
                    .background(VoiceInk.surface, RoundedCornerShape(6.dp))
                    .border(1.dp, VoiceInk.line, RoundedCornerShape(6.dp)).padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        TuningText("Halo", Modifier.weight(1f))
                        TextButton(onClick = {
                            val defaults = PersonaPlacement()
                            speaking = defaults.speakingScale * 100f
                            listening = defaults.listeningScale * 100f
                            idle = defaults.idleScale * 100f
                            feedback = null
                        }) { TuningText("Reset") }
                        TextButton(onClick = { panel = false }, modifier = Modifier.testTag("hide-tuner")) { TuningText("Hide") }
                        TextButton(onClick = {
                            feedback = if (save(placement)) "Saved on this phone" else "Could not save. Try again."
                        }, modifier = Modifier.testTag("save-tuning")) { TuningText("Save") }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        listOf("Speaking", "Listening", "Idle").forEach { choice ->
                            TextButton(onClick = { holding = false; mode = choice },
                                modifier = Modifier.testTag("tune-${choice.lowercase()}")) {
                                Text(choice, fontFamily = VoiceInk.type, fontSize = 11.sp,
                                    color = if (mode == choice) VoiceInk.you else VoiceInk.muted)
                            }
                        }
                    }
                    TuningSlider("$mode size", "${percent.roundToInt()}%", percent, 35f..120f, 84, "persona-scale") {
                        val value = it.roundToInt().toFloat()
                        when (mode) { "Speaking" -> speaking = value; "Listening" -> listening = value; else -> idle = value }
                        feedback = null
                    }
                    Text("Position +35 dp · all states", fontFamily = VoiceInk.type, fontSize = 10.sp,
                        color = VoiceInk.muted, modifier = Modifier.padding(bottom = 8.dp))
                    Text(feedback ?: "Size applies only to $mode. Save keeps all three.", fontFamily = VoiceInk.type,
                        fontSize = 10.sp, color = if (feedback == "Saved on this phone") VoiceInk.you else VoiceInk.muted,
                        modifier = Modifier.padding(bottom = 8.dp))
                }
            } else {
                TextButton(onClick = { panel = true }, modifier = Modifier.background(VoiceInk.surface, RoundedCornerShape(3.dp))
                    .testTag("show-tuner")) { TuningText("Adjust Halo") }
            }
        }
    }
}

@Composable
private fun TuningText(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, color = VoiceInk.text, fontFamily = VoiceInk.type, fontSize = 12.sp)
}

@Composable
private fun TuningSlider(label: String, valueLabel: String, value: Float, range: ClosedFloatingPointRange<Float>,
    steps: Int, tag: String, change: (Float) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TuningText(label)
        TuningText(valueLabel)
    }
    Slider(value = value, onValueChange = change, valueRange = range, steps = steps,
        modifier = Modifier.fillMaxWidth().height(40.dp).testTag(tag).semantics { contentDescription = label },
        colors = SliderDefaults.colors(thumbColor = VoiceInk.you, activeTrackColor = VoiceInk.you,
            inactiveTrackColor = VoiceInk.line, activeTickColor = VoiceInk.you, inactiveTickColor = VoiceInk.line))
}
