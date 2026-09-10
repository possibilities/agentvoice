import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// A distributor's paid attribution waiver does not transfer to public-source forks.
val localIconLicenses = Properties().apply {
    rootProject.file("local.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
}
val paidNounIcons = localIconLicenses.getProperty("agentvoice.paidNounIcons") == "856601,974802"

val verifyShippingDesign by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir.parentFile)
    commandLine("bun", "android/configurator/src/shipping.ts", "generate", "--check")
}
tasks.named("preBuild") { dependsOn(verifyShippingDesign) }

android {
    namespace = "com.arthack.agentvoice"
    compileSdk = 36
    defaultConfig {
        buildConfigField("boolean", "PAID_NOUN_ICONS", paidNounIcons.toString())
        applicationId = "com.arthack.agentvoice"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    buildTypes {
        debug { applicationIdSuffix = ".dev"; versionNameSuffix = "-dev" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        create("studio") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".studio"
            versionNameSuffix = "-studio"
            matchingFallbacks += "debug"
        }
        create("production") {
            initWith(getByName("release"))
            // Preserve the installed real app's identity/data; this is a local signed production build.
            applicationIdSuffix = ".dev"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }
    testBuildType = "studio"
    sourceSets.getByName("studio").apply {
        java.srcDir("src/debug/java")
        res.srcDir("src/debug/res")
        assets.srcDir("src/debug/assets")
    }
    sourceSets.getByName("production").apply {
        java.srcDir("src/release/java")
        res.srcDir("src/release/res")
        assets.srcDir("src/release/assets")
    }
    sourceSets.getByName("testStudio").java.srcDir("src/testDebug/java")
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    sourceSets.getByName("test").resources.srcDir("../contract")
    lint { abortOnError = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    implementation("app.rive:rive-android:11.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    add("studioImplementation", "androidx.compose.ui:ui-test-manifest")
}
