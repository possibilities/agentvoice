package com.arthack.agentvoice

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

internal const val haloSourceSha256 = "c8d97df33c47f52c993667515700e12f110539a46048b142a0ec787dba9dcc96"

/** Edits only a verified copy of halo-2.0.riv; the bundled asset is never written. */
internal fun compactHaloBytes(original: ByteArray, tuning: CompactHaloTuning): ByteArray {
    require(original.size == 4497 && MessageDigest.getInstance("SHA-256").digest(original)
        .joinToString("") { "%02x".format(it) } == haloSourceSha256) {
        "Contained Halo needs the verified halo-2.0 animation. Choose Original."
    }
    val result = original.copyOf()
    val values = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN)
    fun patch(sites: List<HaloFloatSite>, change: (Float) -> Float) {
        for (site in sites) {
            check(values.getInt(site.offset) == site.value.toRawBits()) { "Halo patch mapping no longer matches its source." }
            values.putFloat(site.offset, change(site.value))
        }
    }
    patch(listeningSpread) { 1f - (it - 1f) * (tuning.ringSpreadPercent / 100f) }
    patch(listeningPulse) { 128f - (it - 128f) * (tuning.listeningPulsePercent / 100f) }
    patch(speakingMotion) { 1f + (it - 1f) * (tuning.speakingMotionPercent / 100f) }
    patch(idleBreathing) { 1f + (it - 1f) * (tuning.idleBreathingPercent / 100f) }
    // Thinking sweeps trimmed arcs along these paths. Narrow only the dash ellipses;
    // the central circle, vertical reach, sweep timing and other states stay authored.
    patch(thinkingDashWidth) { thinkingDashScale(tuning.thinkingWingspan) }
    for (site in listeningEase) {
        check(result[site.typeOffset].toInt() == 4 && result[site.idOffset].toInt() == site.originalId)
        // Use the file's cubic (.42, 0, .58, 1) instead of elastic entry/exit overshoot.
        result[site.typeOffset] = 2
        result[site.idOffset] = 79
    }
    return result
}

private data class HaloFloatSite(val offset: Int, val value: Float)
private data class HaloEaseSite(val typeOffset: Int, val idOffset: Int, val originalId: Int)

// Static scaleX of Dash 2 Mirror / Dash 2 / Dash 1 Mirror / Dash 1 ellipses
// (artboard components 11 / 15 / 19 / 23). No animation overrides their geometry.
private val thinkingDashWidth = listOf(
    HaloFloatSite(304, 1.27999997f),
    HaloFloatSite(364, 1.27999997f),
    HaloFloatSite(436, 1.27999997f),
    HaloFloatSite(496, 1.27999997f),
)

// Byte offsets and source values were decoded against Rive's public format and generated
// property definitions. Track labels below are animation / artboard object / property IDs.
// The SHA guard is mandatory: these offsets are valid for this exact source export only.
private val listeningSpread = listOf(
    // listening_out / 27 / 16
    HaloFloatSite(1876, 1.60000002f),
    HaloFloatSite(1889, 1.0f),
    // listening_out / 27 / 17
    HaloFloatSite(1904, 1.60000002f),
    HaloFloatSite(1917, 1.0f),
    // listening_out / 37 / 16
    HaloFloatSite(1938, 1.20000005f),
    HaloFloatSite(1951, 1.0f),
    // listening_out / 37 / 17
    HaloFloatSite(1968, 1.20000005f),
    HaloFloatSite(1981, 1.0f),
    // listening_out / 32 / 16
    HaloFloatSite(2002, 1.39999998f),
    HaloFloatSite(2015, 1.0f),
    // listening_out / 32 / 17
    HaloFloatSite(2032, 1.39999998f),
    HaloFloatSite(2045, 1.0f),
    // listening_in / 32 / 16
    HaloFloatSite(2399, 1.0f),
    HaloFloatSite(2412, 1.39999998f),
    // listening_in / 32 / 17
    HaloFloatSite(2429, 1.0f),
    HaloFloatSite(2442, 1.39999998f),
    // listening_in / 37 / 16
    HaloFloatSite(2463, 1.0f),
    HaloFloatSite(2476, 1.20000005f),
    // listening_in / 37 / 17
    HaloFloatSite(2493, 1.0f),
    HaloFloatSite(2506, 1.20000005f),
    // listening_in / 27 / 16
    HaloFloatSite(2525, 1.0f),
    HaloFloatSite(2538, 1.60000002f),
    // listening_in / 27 / 17
    HaloFloatSite(2553, 1.0f),
    HaloFloatSite(2566, 1.60000002f),
    // listening_off / 37 / 16
    HaloFloatSite(2604, 1.0f),
    // listening_off / 37 / 17
    HaloFloatSite(2619, 1.0f),
    // listening_off / 32 / 16
    HaloFloatSite(2638, 1.0f),
    // listening_off / 32 / 17
    HaloFloatSite(2653, 1.0f),
    // listening_off / 27 / 16
    HaloFloatSite(2672, 1.0f),
    // listening_off / 27 / 17
    HaloFloatSite(2687, 1.0f),
)

private val listeningPulse = listOf(
    // listening_loop / 27 / 20
    HaloFloatSite(2107, 128.0f),
    HaloFloatSite(2120, 138.0f),
    HaloFloatSite(2134, 128.0f),
    // listening_loop / 27 / 21
    HaloFloatSite(2151, 128.0f),
    HaloFloatSite(2164, 138.0f),
    HaloFloatSite(2178, 128.0f),
    // listening_loop / 32 / 20
    HaloFloatSite(2199, 128.0f),
    HaloFloatSite(2212, 138.0f),
    HaloFloatSite(2226, 128.0f),
    // listening_loop / 32 / 21
    HaloFloatSite(2243, 128.0f),
    HaloFloatSite(2256, 138.0f),
    HaloFloatSite(2270, 128.0f),
    // listening_loop / 37 / 20
    HaloFloatSite(2291, 128.0f),
    HaloFloatSite(2304, 138.0f),
    HaloFloatSite(2318, 128.0f),
    // listening_loop / 37 / 21
    HaloFloatSite(2335, 128.0f),
    HaloFloatSite(2348, 138.0f),
    HaloFloatSite(2362, 128.0f),
)

private val speakingMotion = listOf(
    // speaking_loop / 6 / 16
    HaloFloatSite(1373, 1.0f),
    HaloFloatSite(1386, 1.1179688f),
    HaloFloatSite(1399, 0.939843774f),
    HaloFloatSite(1412, 0.928125024f),
    HaloFloatSite(1423, 1.15468752f),
    HaloFloatSite(1434, 1.0f),
    // speaking_loop / 6 / 17
    HaloFloatSite(1449, 1.0f),
    HaloFloatSite(1460, 0.944921851f),
    HaloFloatSite(1471, 1.10343754f),
    HaloFloatSite(1482, 1.13999999f),
    HaloFloatSite(1493, 0.970703125f),
    HaloFloatSite(1504, 1.0f),
)

private val idleBreathing = listOf(
    // on_idle1 / 5 / 16
    HaloFloatSite(2896, 1.0f),
    HaloFloatSite(2909, 0.939999998f),
    HaloFloatSite(2923, 1.0f),
    // on_idle1 / 5 / 17
    HaloFloatSite(2938, 1.0f),
    HaloFloatSite(2951, 0.939999998f),
    HaloFloatSite(2965, 1.0f),
)

private val listeningEase = listOf(
    HaloEaseSite(1872, 1874, 80),
    HaloEaseSite(1885, 1887, 80),
    HaloEaseSite(1900, 1902, 80),
    HaloEaseSite(1913, 1915, 80),
    HaloEaseSite(1934, 1936, 80),
    HaloEaseSite(1947, 1949, 80),
    HaloEaseSite(1964, 1966, 80),
    HaloEaseSite(1977, 1979, 80),
    HaloEaseSite(1998, 2000, 80),
    HaloEaseSite(2011, 2013, 80),
    HaloEaseSite(2028, 2030, 80),
    HaloEaseSite(2041, 2043, 80),
    HaloEaseSite(2395, 2397, 81),
    HaloEaseSite(2408, 2410, 81),
    HaloEaseSite(2425, 2427, 81),
    HaloEaseSite(2438, 2440, 81),
    HaloEaseSite(2459, 2461, 81),
    HaloEaseSite(2472, 2474, 81),
    HaloEaseSite(2489, 2491, 81),
    HaloEaseSite(2502, 2504, 81),
    HaloEaseSite(2521, 2523, 81),
    HaloEaseSite(2534, 2536, 81),
    HaloEaseSite(2549, 2551, 81),
    HaloEaseSite(2562, 2564, 81),
    HaloEaseSite(2600, 2602, 81),
    HaloEaseSite(2615, 2617, 81),
    HaloEaseSite(2634, 2636, 81),
    HaloEaseSite(2649, 2651, 81),
    HaloEaseSite(2668, 2670, 81),
    HaloEaseSite(2683, 2685, 81),
)
