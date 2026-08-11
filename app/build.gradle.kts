plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.spheredex"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.spheredex"
        minSdk = 24
        targetSdk = 35
        // CI sets VERSION_CODE from the build number so each upload is unique; local builds fall back to 4.
        versionCode = System.getenv("VERSION_CODE")?.toIntOrNull() ?: 4
        versionName = "1.0"
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
    val camerax = "1.3.4"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.mlkit:text-recognition:16.0.1")

    // Card art
    implementation("io.coil-kt:coil-compose:2.6.0")
}
