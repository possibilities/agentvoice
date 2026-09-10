package com.arthack.agentvoice

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer

internal object QrFrameDecoder {
    private const val MAX_DIMENSION = 1920
    private const val MAX_PIXELS = 1280 * 1280
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

    /** Returns null for an absent QR code or a malformed/oversized luminance plane. */
    fun decode(
        data: ByteBuffer,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotationDegrees: Int,
    ): String? {
        if (!validLayout(data, width, height, rowStride, pixelStride)) return null
        if (rotationDegrees !in setOf(0, 90, 180, 270)) return null

        val packed = ByteArray(width * height)
        val source = data.duplicate()
        val start = source.position()
        for (y in 0 until height) {
            val row = start + y * rowStride
            for (x in 0 until width) packed[y * width + x] = source.get(row + x * pixelStride)
        }
        val (luminance, rotatedWidth, rotatedHeight) = rotate(packed, width, height, rotationDegrees)
        val bitmap = BinaryBitmap(
            HybridBinarizer(
                PlanarYUVLuminanceSource(
                    luminance,
                    rotatedWidth,
                    rotatedHeight,
                    0,
                    0,
                    rotatedWidth,
                    rotatedHeight,
                    false,
                ),
            ),
        )
        return try {
            QRCodeReader().decode(bitmap, hints).text
        } catch (_: ReaderException) {
            null
        }
    }

    private fun validLayout(
        data: ByteBuffer,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
    ): Boolean {
        if (!acceptsFrameSize(width, height)) return false
        if (rowStride <= 0 || pixelStride <= 0) return false
        val rowWidth = (width.toLong() - 1) * pixelStride + 1
        if (rowStride.toLong() < rowWidth) return false
        val required = (height.toLong() - 1) * rowStride + rowWidth
        return required <= data.remaining().toLong()
    }

    fun acceptsFrameSize(width: Int, height: Int): Boolean =
        width > 0 &&
            height > 0 &&
            width <= MAX_DIMENSION &&
            height <= MAX_DIMENSION &&
            width.toLong() * height <= MAX_PIXELS.toLong()

    private data class RotatedPlane(val bytes: ByteArray, val width: Int, val height: Int)

    private fun rotate(bytes: ByteArray, width: Int, height: Int, degrees: Int): RotatedPlane {
        if (degrees == 0) return RotatedPlane(bytes, width, height)
        val rotatedWidth = if (degrees == 180) width else height
        val rotatedHeight = if (degrees == 180) height else width
        val rotated = ByteArray(bytes.size)
        for (y in 0 until height) for (x in 0 until width) {
            val source = bytes[y * width + x]
            when (degrees) {
                90 -> rotated[x * rotatedWidth + (height - 1 - y)] = source
                180 -> rotated[(height - 1 - y) * rotatedWidth + (width - 1 - x)] = source
                270 -> rotated[(width - 1 - x) * rotatedWidth + y] = source
            }
        }
        return RotatedPlane(rotated, rotatedWidth, rotatedHeight)
    }
}
