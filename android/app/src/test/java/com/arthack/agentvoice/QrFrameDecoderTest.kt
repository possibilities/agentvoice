package com.arthack.agentvoice

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.nio.ByteBuffer
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrFrameDecoderTest {
    @Test fun decodesGeneratedQrFromPaddedInterleavedLuminancePlane() {
        val text = "agentvoice://enroll/test-padded-plane"
        val qr = generatedQr(text)
        val plane = strided(qr.bytes, qr.width, qr.height, pixelStride = 3, rowPadding = 17, prefix = 9)

        assertEquals(
            text,
            QrFrameDecoder.decode(plane.data, qr.width, qr.height, plane.rowStride, 3, 0),
        )
    }

    @Test fun decodesGeneratedQrAfterApplyingFrameRotation() {
        val text = "agentvoice://enroll/test-rotated-frame"
        val qr = generatedQr(text)
        val sensor = rotateCounterClockwise(qr.bytes, qr.width, qr.height)
        val plane = strided(sensor.bytes, sensor.width, sensor.height, pixelStride = 2, rowPadding = 13)

        assertEquals(
            text,
            QrFrameDecoder.decode(plane.data, sensor.width, sensor.height, plane.rowStride, 2, 90),
        )
    }

    @Test fun decodesCliGeneratedNoncredentialMatrixFixture() {
        val fixture = javaClass.getResourceAsStream("/cli-qr-fixture.json")!!
            .bufferedReader()
            .use { Json.parseToJsonElement(it.readText()).jsonObject }
        assertEquals("noncredential", fixture.getValue("fixture").jsonPrimitive.content)
        val payload = fixture.getValue("payload").jsonPrimitive.content
        val width = fixture.getValue("width").jsonPrimitive.int
        val height = fixture.getValue("height").jsonPrimitive.int
        val matrix = fixture.getValue("matrix").jsonArray
        assertEquals(height, matrix.size)
        matrix.forEach { assertEquals(width, it.jsonArray.size) }
        val qr = rasterize(matrix, width, height)
        val plane = strided(qr.bytes, qr.width, qr.height, pixelStride = 2, rowPadding = 7)

        assertEquals(
            payload,
            QrFrameDecoder.decode(plane.data, qr.width, qr.height, plane.rowStride, 2, 0),
        )
    }

    @Test fun rejectsTruncatedAndOversizedPlanesWithoutReadingThem() {
        assertNull(QrFrameDecoder.decode(ByteBuffer.allocate(8), 8, 8, 8, 1, 0))
        assertNull(QrFrameDecoder.decode(ByteBuffer.allocate(1), 1920, 1080, 1920, 1, 0))
        assertNull(QrFrameDecoder.decode(ByteBuffer.allocate(1), 1, 1, 1, 1, 45))
    }

    private data class Plane(val data: ByteBuffer, val rowStride: Int)
    private data class Luminance(val bytes: ByteArray, val width: Int, val height: Int)

    private fun generatedQr(text: String, size: Int = 257): Luminance {
        val bits = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        return Luminance(
            ByteArray(size * size) { index -> if (bits[index % size, index / size]) 0 else 0xff.toByte() },
            size,
            size,
        )
    }

    private fun rasterize(matrix: JsonArray, width: Int, height: Int): Luminance {
        val scale = 4
        val quietModules = 4
        val rasterWidth = (width + quietModules * 2) * scale
        val rasterHeight = (height + quietModules * 2) * scale
        val bytes = ByteArray(rasterWidth * rasterHeight) { 0xff.toByte() }
        matrix.forEachIndexed { moduleY, rowElement ->
            rowElement.jsonArray.forEachIndexed { moduleX, moduleElement ->
                if (moduleElement.jsonPrimitive.boolean) {
                    val left = (quietModules + moduleX) * scale
                    val top = (quietModules + moduleY) * scale
                    for (y in top until top + scale) for (x in left until left + scale) {
                        bytes[y * rasterWidth + x] = 0
                    }
                }
            }
        }
        return Luminance(bytes, rasterWidth, rasterHeight)
    }

    private fun strided(
        bytes: ByteArray,
        width: Int,
        height: Int,
        pixelStride: Int,
        rowPadding: Int,
        prefix: Int = 0,
    ): Plane {
        val rowStride = width * pixelStride + rowPadding
        val required = (height - 1) * rowStride + (width - 1) * pixelStride + 1
        val storage = ByteArray(prefix + required) { 0x55 }
        for (y in 0 until height) for (x in 0 until width) {
            storage[prefix + y * rowStride + x * pixelStride] = bytes[y * width + x]
        }
        return Plane(ByteBuffer.wrap(storage, prefix, required).slice(), rowStride)
    }

    private fun rotateCounterClockwise(bytes: ByteArray, width: Int, height: Int): Luminance {
        val rotatedWidth = height
        val rotatedHeight = width
        val rotated = ByteArray(bytes.size)
        for (y in 0 until height) for (x in 0 until width) {
            rotated[(width - 1 - x) * rotatedWidth + y] = bytes[y * width + x]
        }
        return Luminance(rotated, rotatedWidth, rotatedHeight)
    }
}
