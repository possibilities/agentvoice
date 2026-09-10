package com.arthack.agentvoice

import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

/** Design only: no rehearsal gates, held pointers, bridge capability or call state. */
internal fun PersonaPreviewState.designProfile(): String {
    val portrait = if (orientation == "portrait") activeLayout() else otherLayout
    val landscape = if (orientation == "landscape") activeLayout() else otherLayout
    return JSONObject(encodePersonaTuning(portrait.placement, portrait.design, portrait.halo, portrait.spirit,
        landscape, portrait.personaSide, portrait.horizontalOffsetDp, portrait.appearanceOverrides,
        sharedAppearance, sounds, appearance())).put("savedAtEpochMs", 1).toString()
}

internal fun PersonaPreviewState.withDesignProfile(profile: String): PersonaPreviewState {
    val layouts = decodePreviewProfileLayouts(profile)
    val active = if (orientation == "portrait") layouts.portrait else layouts.landscape
    return endHold().withEffectiveLayout(active).withAppearance(decodeDesignAppearanceProfile(profile)).copy(
        otherLayout = if (orientation == "portrait") layouts.landscape else layouts.portrait,
        sharedAppearance = layouts.shared, sounds = decodePersonaSounds(profile), revision = revision + 1)
}

/** A promotion advances generation; rebuilds/reconnects never do. Writes precede preview acknowledgement. */
internal class StudioDraft(private val file: File, private val generation: String = StudioProduction.generation,
    private val production: String = StudioProduction.profile) {
    private var lastProfile: String? = null

    fun open(): String {
        val atomic = AtomicFile(file)
        val previous = if (file.exists() || File(file.path + ".bak").exists()) atomic.readFully().toString(Charsets.UTF_8) else null
        if (previous != null) {
            val data = JSONObject(previous)
            require(data.getInt("version") == 1) { "Unsupported Studio draft" }
            if (data.getString("productionGeneration") == generation) {
                val profile = data.getJSONObject("profile").toString()
                validate(profile)
                lastProfile = profile
                return profile
            }
            // Keep the preceding release's working draft recoverable, separate from explicit Save.
            savePersonaTuning(File(file.path + ".previous"), previous)
        }
        write(production)
        return production
    }

    private fun validate(profile: String) {
        decodePreviewProfileLayouts(profile)
        decodeDesignAppearanceProfile(profile)
        decodePersonaSounds(profile)
    }

    fun write(profile: String) {
        if (profile == lastProfile) return
        validate(profile)
        savePersonaTuning(file, JSONObject().put("version", 1).put("productionGeneration", generation)
            .put("profile", JSONObject(profile)).toString())
        lastProfile = profile
    }
}
