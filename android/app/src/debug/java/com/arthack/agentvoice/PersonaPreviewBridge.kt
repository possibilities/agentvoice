package com.arthack.agentvoice

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.system.Os
import android.system.OsConstants
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** One authenticated peer at a time; reconnects must present this host run's same token. */
internal class PersonaPreviewBridge(
    name: String,
    private val token: String,
    private val command: suspend (JSONObject) -> JSONObject,
) : Closeable {
    private val server = LocalServerSocket(name)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val closed = AtomicBoolean(false)
    @Volatile private var peer: LocalSocket? = null

    init {
        scope.launch {
            try {
                while (isActive) {
                    val socket = server.accept()
                    peer = socket
                    if (closed.get()) { socket.close(); break }
                    socket.use {
                        try {
                            socket.soTimeout = 2000
                            val input = socket.inputStream.buffered()
                            val hello = JSONObject(readFrame(input) ?: error("Missing hello"))
                            require(hello.fields() == setOf("token"))
                            require(MessageDigest.isEqual(token.toByteArray(), hello.getString("token").toByteArray()))
                            socket.soTimeout = 10000
                            val output = socket.outputStream.buffered()
                            while (isActive) {
                                val request = JSONObject(readFrame(input) ?: break)
                                val id = request.get("id")
                                require(id is Int && id > 0)
                                val result = try { command(request) } catch (cancel: CancellationException) {
                                    throw cancel
                                } catch (_: Exception) {
                                    JSONObject().put("error", "Phone rejected the change or could not save. Refresh and try again.")
                                }
                                val frame = result.put("id", id).toString().toByteArray(Charsets.UTF_8)
                                require(frame.size < 65536)
                                output.write(frame)
                                output.write(10)
                                output.flush()
                            }
                        } catch (_: Exception) { /* Closing, invalid authentication, or malformed input ends this peer. */ }
                    }
                    peer = null
                }
            } catch (_: Exception) { /* Listener shutdown wakes a blocking accept. */ }
            finally { close() }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        scope.cancel()
        // close alone leaves Android's blocking read/accept alive until their next operation.
        runCatching { Os.shutdown(server.fileDescriptor, OsConstants.SHUT_RDWR) }
        runCatching { server.close() }
        runCatching { peer?.shutdownInput() }
        runCatching { peer?.shutdownOutput() }
        runCatching { peer?.close() }
    }
}

internal fun readFrame(input: InputStream, maxBytes: Int = 8192): String? {
    val bytes = ByteArrayOutputStream()
    while (bytes.size() < maxBytes) {
        val next = input.read()
        if (next == -1) { require(bytes.size() == 0); return null }
        if (next == 10) return bytes.toString(Charsets.UTF_8.name())
        bytes.write(next)
    }
    error("Preview frame too large")
}
