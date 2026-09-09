package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PersonaTunerTest {
    @get:Rule val compose = createComposeRule()

    @Test fun savedLegacyChoiceSurvivesIndependentStateTuningAndReload() {
        val legacy = """{"version":1,"scaleMultiplier":0.78,"verticalOffsetDp":35}"""
        var initial by mutableStateOf(decodePersonaTuning(legacy))
        var generation by mutableIntStateOf(0)
        var saved: String? = null
        compose.setContent {
            key(generation) {
                VoiceTheme { PersonaTuner(initial) { saved = encodePersonaTuning(it); true } }
            }
        }
        compose.onNodeWithText("78%").assertIsDisplayed()
        compose.onNodeWithTag("tune-listening").performClick()
        compose.onNodeWithTag("persona-scale").performSemanticsAction(SemanticsActions.SetProgress) { it(52f) }
        compose.onNodeWithText("52%").assertIsDisplayed()
        compose.onNodeWithTag("tune-speaking").performClick()
        compose.onNodeWithText("78%").assertIsDisplayed()
        compose.onNodeWithTag("tune-idle").performClick()
        compose.onNodeWithText("78%").assertIsDisplayed()
        compose.onNodeWithTag("save-tuning").performClick()
        compose.runOnIdle {
            // Exercise the real save format without touching the operator's private profile.
            val restored = decodePersonaTuning(saved!!)
            assertEquals(.78f, restored.speakingScale)
            assertEquals(.52f, restored.listeningScale)
            assertEquals(.78f, restored.idleScale)
            assertEquals(35.dp, restored.offsetY)
            initial = restored
            generation++
        }
        compose.onNodeWithText("78%").assertIsDisplayed()
        compose.onNodeWithTag("tune-listening").performClick()
        compose.onNodeWithText("52%").assertIsDisplayed()
        compose.onNodeWithText("Position +35 dp · all states").assertIsDisplayed()
        compose.onNodeWithTag("hide-tuner").performClick()
        compose.onNodeWithTag("show-tuner").performClick()
        compose.onNodeWithText("52%").assertIsDisplayed()
    }
}
