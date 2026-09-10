package com.arthack.agentvoice

import android.graphics.Rect
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

internal data class StudioViewportRect(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    fun json(): JSONObject = JSONObject().put("left", left).put("top", top)
        .put("right", right).put("bottom", bottom)
}

internal data class StudioViewport(
    val width: Int,
    val height: Int,
    val systemBars: StudioViewportRect,
    val cutouts: List<StudioViewportRect>,
) {
    init { require(width > 0 && height > 0 && cutouts.size <= 16) }

    fun json(): JSONObject = JSONObject().put("width", width).put("height", height)
        .put("systemBars", systemBars.json())
        .put("cutouts", JSONArray().also { values -> cutouts.forEach { values.put(it.json()) } })
}

internal fun studioViewport(view: View): StudioViewport? = studioViewport(
    view.width,
    view.height,
    ViewCompat.getRootWindowInsets(view),
)

internal fun studioViewport(width: Int, height: Int, insets: WindowInsetsCompat?): StudioViewport? {
    if (width <= 0 || height <= 0 || insets == null) return null
    return studioViewport(width, height, insets.getInsets(WindowInsetsCompat.Type.systemBars()),
        insets.displayCutout?.boundingRects.orEmpty())
}

internal fun studioViewport(width: Int, height: Int, systemBars: Insets, cutouts: List<Rect>): StudioViewport? {
    if (width <= 0 || height <= 0) return null
    fun Rect.viewportRect() = StudioViewportRect(left, top, right, bottom)
    return StudioViewport(width, height,
        StudioViewportRect(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom),
        cutouts.take(16).map { Rect(it).viewportRect() })
}
