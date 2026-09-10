package com.arthack.agentvoice

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ShippingLauncherTest {
    @Test fun installedLauncherUsesTheAdoptedAdaptiveArtworkAndThemedLayer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue(ShippingDesign.launcher in previewLaunchers)
        val icon = context.packageManager.getApplicationIcon(context.packageName)
        assertTrue(icon is AdaptiveIconDrawable)
        icon as AdaptiveIconDrawable
        if (android.os.Build.VERSION.SDK_INT >= 33) assertNotNull(icon.monochrome)
        val foreground = Bitmap.createBitmap(108, 108, Bitmap.Config.ARGB_8888)
        icon.foreground.setBounds(0, 0, 108, 108)
        icon.foreground.draw(Canvas(foreground))
        if (ShippingDesign.launcher == "relay-aperture") {
            assertEquals(0, Color.alpha(foreground.getPixel(54, 54)))
            assertEquals(Color.rgb(212, 255, 114), foreground.getPixel(30, 54))
            assertEquals(Color.rgb(187, 170, 255), foreground.getPixel(78, 54))
        }
        assertTrue((0 until 108).any { x -> (0 until 108).any { y -> Color.alpha(foreground.getPixel(x, y)) > 0 } })
        val rendered = Bitmap.createBitmap(216, 216, Bitmap.Config.ARGB_8888)
        icon.setBounds(0, 0, 216, 216)
        icon.draw(Canvas(rendered))
        File(context.cacheDir, "shipping-launcher.png").outputStream().use {
            assertTrue(rendered.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }
}
