package com.arthack.agentvoice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

internal enum class ConnectionCameraState { Permission, Denied, Opening, Scanning, Unavailable }

/** Camera frames stay on this device. This first slice creates no analyzer or grant. */
@Composable
internal fun ConnectionCamera(
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
            CameraSurface(modifier) { cameraState = it }
        }
    }
}

@Composable
private fun CameraSurface(modifier: Modifier, status: (ConnectionCameraState) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latestStatus by rememberUpdatedState(status)
    val view = remember(context) {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }
    AndroidView(factory = { view }, modifier = modifier)
    DisposableEffect(view, owner) {
        var disposed = false
        var provider: ProcessCameraProvider? = null
        var preview: Preview? = null
        var cameraInfo: androidx.camera.core.CameraInfo? = null
        val cameraObserver = androidx.lifecycle.Observer<androidx.camera.core.CameraState> {
            if (!disposed && it.error != null) latestStatus(ConnectionCameraState.Unavailable)
        }
        val streamObserver = androidx.lifecycle.Observer<PreviewView.StreamState> {
            if (!disposed && it == PreviewView.StreamState.STREAMING) latestStatus(ConnectionCameraState.Scanning)
        }
        view.previewStreamState.observe(owner, streamObserver)
        latestStatus(ConnectionCameraState.Opening)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!disposed) try {
                val cameras = future.get()
                provider = cameras
                if (!cameras.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    latestStatus(ConnectionCameraState.Unavailable)
                } else {
                    val useCase = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    preview = useCase
                    val camera = cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, useCase)
                    cameraInfo = camera.cameraInfo
                    camera.cameraInfo.cameraState.observe(owner, cameraObserver)
                }
            } catch (_: Exception) {
                if (!disposed) latestStatus(ConnectionCameraState.Unavailable)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            disposed = true
            view.previewStreamState.removeObserver(streamObserver)
            cameraInfo?.cameraState?.removeObserver(cameraObserver)
            // Only this overlay's use case belongs to us; never unbind another camera owner.
            preview?.let { provider?.unbind(it) }
        }
    }
}
