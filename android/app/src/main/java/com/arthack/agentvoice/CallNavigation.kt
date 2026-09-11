package com.arthack.agentvoice

internal const val CALL_NAVIGATION_HINT = "Back returns to connections. Your call stays active."

internal enum class CallRoute { Persona, Connection, Scanner }

/** Navigation never owns the transport; only an explicit call action changes it. */
internal data class CallNavigation(
    val route: CallRoute = CallRoute.Persona,
    val autoConnectPending: Boolean = true,
) {
    fun loaded(paired: Boolean): CallNavigation = if (!paired && route == CallRoute.Persona)
        copy(route = CallRoute.Scanner) else this
    fun back() = copy(route = CallRoute.Connection)
    fun enterCall() = copy(route = CallRoute.Persona, autoConnectPending = false)
    fun disconnected() = copy(route = CallRoute.Connection, autoConnectPending = false)
    fun scan() = copy(route = CallRoute.Scanner)
    fun consumeAutoConnect() = copy(autoConnectPending = false)
    fun shouldAutoConnect(loaded: Boolean, paired: Boolean, resumed: Boolean, ownerReady: Boolean): Boolean =
        autoConnectPending && loaded && paired && resumed && ownerReady
}

internal data class PersonaHintBounds(val x: Float, val y: Float, val width: Float, val height: Float)

internal fun personaHintBounds(geometry: PreviewOrientationGeometry, width: Float, height: Float): PersonaHintBounds =
    when {
        geometry.portrait -> PersonaHintBounds(0f, 0f, width, geometry.deckY.coerceIn(0f, height))
        geometry.personaSide == "left" -> PersonaHintBounds(0f, 0f, geometry.deckX.coerceIn(0f, width), height)
        else -> {
            val start = (geometry.deckX + geometry.deckWidth).coerceIn(0f, width)
            PersonaHintBounds(start, 0f, width - start, height)
        }
    }
