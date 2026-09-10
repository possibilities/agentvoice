package com.arthack.agentvoice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.view.PreviewView
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal enum class ConnectionCameraState { Permission, Denied, Opening, Scanning, Unavailable }

/** Camera frames and decoded values stay in memory on this device. */
@Composable
internal fun ConnectionCamera(
    onCode: ((String) -> Unit)? = null,
    content: @Composable (ConnectionCameraState, () -> Unit, @Composable (Modifier) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    fun allowed() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    var granted by remember { mutableStateOf(allowed()) }
    var denied by remember { mutableStateOf(false) }
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var cameraState by remember { mutableStateOf(ConnectionCameraState.Opening) }
    var retry by remember { mutableIntStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        denied = !it
    }
    DisposableEffect(owner, context) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (resumed) granted = allowed()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val state = when {
        !granted -> if (denied) ConnectionCameraState.Denied else ConnectionCameraState.Permission
        !resumed -> ConnectionCameraState.Opening
        else -> cameraState
    }
    val action: () -> Unit = {
        when (state) {
            ConnectionCameraState.Permission -> permission.launch(Manifest.permission.CAMERA)
            ConnectionCameraState.Denied -> context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
            else -> { cameraState = ConnectionCameraState.Opening; retry++ }
        }
    }
    content(state, action) { modifier ->
        if (granted && resumed) key(retry) {
            CameraSurface(modifier, onCode) { cameraState = it }
        }
    }
}

@Composable
private fun CameraSurface(
    modifier: Modifier,
    onCode: ((String) -> Unit)?,
    status: (ConnectionCameraState) -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latestStatus by rememberUpdatedState(status)
    val latestOnCode by rememberUpdatedState(onCode)
    val view = remember(context) {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }
    AndroidView(factory = { view }, modifier = modifier)
    DisposableEffect(view, owner, onCode != null) {
        val active = AtomicBoolean(true)
        val delivered = AtomicBoolean(false)
        fun cameraActive() = active.get() && owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        var provider: ProcessCameraProvider? = null
        var preview: Preview? = null
        var analysis: ImageAnalysis? = null
        var cameraInfo: androidx.camera.core.CameraInfo? = null
        val analyzerExecutor = onCode?.let { Executors.newSingleThreadExecutor() }
        val cameraObserver = androidx.lifecycle.Observer<androidx.camera.core.CameraState> {
            if (cameraActive() && it.error != null) latestStatus(ConnectionCameraState.Unavailable)
        }
        val streamObserver = androidx.lifecycle.Observer<PreviewView.StreamState> {
            if (cameraActive() && it == PreviewView.StreamState.STREAMING) latestStatus(ConnectionCameraState.Scanning)
        }
        view.previewStreamState.observe(owner, streamObserver)
        latestStatus(ConnectionCameraState.Opening)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (cameraActive()) try {
                val cameras = future.get()
                provider = cameras
                if (!cameras.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    latestStatus(ConnectionCameraState.Unavailable)
                } else {
                    val useCase = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    preview = useCase
                    val analyzer = analyzerExecutor?.let { executor ->
                        ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .setResolutionSelector(
                                ResolutionSelector.Builder()
                                    .setResolutionStrategy(
                                        ResolutionStrategy(
                                            Size(1280, 720),
                                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                                        ),
                                    )
                                    .setResolutionFilter { sizes, _ ->
                                        sizes.filter { QrFrameDecoder.acceptsFrameSize(it.width, it.height) }
                                    }
                                    .build(),
                            )
                            .build()
                            .also { imageAnalysis ->
                                imageAnalysis.setAnalyzer(executor) { image ->
                                    try {
                                        if (!active.get() || delivered.get()) return@setAnalyzer
                                        val plane = image.planes.firstOrNull() ?: return@setAnalyzer
                                        val code = QrFrameDecoder.decode(
                                            data = plane.buffer,
                                            width = image.width,
                                            height = image.height,
                                            rowStride = plane.rowStride,
                                            pixelStride = plane.pixelStride,
                                            rotationDegrees = image.imageInfo.rotationDegrees,
                                        ) ?: return@setAnalyzer
                                        if (active.get() && delivered.compareAndSet(false, true)) {
                                            ContextCompat.getMainExecutor(context).execute {
                                                if (cameraActive()) latestOnCode?.invoke(code)
                                            }
                                        }
                                    } finally {
                                        image.close()
                                    }
                                }
                            }
                    }
                    analysis = analyzer
                    val useCases = listOfNotNull(useCase, analyzer).toTypedArray()
                    if (!cameraActive()) return@addListener
                    val camera = cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, *useCases)
                    cameraInfo = camera.cameraInfo
                    camera.cameraInfo.cameraState.observe(owner, cameraObserver)
                }
            } catch (_: Exception) {
                if (cameraActive()) latestStatus(ConnectionCameraState.Unavailable)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            active.set(false)
            view.previewStreamState.removeObserver(streamObserver)
            cameraInfo?.cameraState?.removeObserver(cameraObserver)
            analysis?.clearAnalyzer()
            analyzerExecutor?.shutdownNow()
            // Only this overlay's use cases belong to us; never unbind another camera owner.
            listOfNotNull(preview, analysis).takeIf { it.isNotEmpty() }?.let { provider?.unbind(*it.toTypedArray()) }
        }
    }
}
