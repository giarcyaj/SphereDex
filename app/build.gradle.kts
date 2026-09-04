plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Push is optional at build time: apply the google-services plugin only when the config file is
// present, so the app still builds before Firebase is configured. Drop app/google-services.json in
// (Firebase console -> Project settings -> your Android app) to activate push. The plugins DSL can't
// take a conditional, so this legacy apply(...) does it after the block.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "app.spheredex"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.spheredex"
        minSdk = 24
        targetSdk = 36
        // CI sets VERSION_CODE from the build number so each upload is unique; local builds fall back to 4.
        versionCode = System.getenv("VERSION_CODE")?.toIntOrNull() ?: 5
        versionName = "1.2"
    }
    signingConfigs {
        create("release") {
            // Supplied by CI from GitHub secrets; nothing sensitive lives in the repo.
            System.getenv("KEYSTORE_FILE")?.let { storeFile = file(it) }
            storePassword = System.getenv("KEYSTORE_PASSWORD")
            keyAlias = System.getenv("KEY_ALIAS")
            keyPassword = System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false   // keep JS bridge (JavascriptInterface) intact; no R8 stripping
            // Sign the release only when the keystore secrets are present (i.e. in CI).
            if (System.getenv("KEYSTORE_FILE") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Camera + on-device OCR
    // CameraX 1.4.0+ ships 16 KB-page-aligned native libs (libimage_processing_util_jni.so);
    // 1.3.x was compiled for 4 KB pages and fails Google Play's 16 KB page-size check.
    val camerax = "1.4.2"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.mlkit:text-recognition:16.0.1")

    // Card art
    implementation("io.coil-kt:coil-compose:2.6.0")

    // Push notifications (Firebase Cloud Messaging only - no Analytics, per our privacy policy).
    // Inert until app/google-services.json is added; the code guards every FCM call until then.
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-messaging")
}
