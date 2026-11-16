// AGP 9 compiles Kotlin itself and ships an older compiler. Putting the current stable
// Kotlin Gradle plugin on the buildscript classpath moves that compiler up to match the
// Compose compiler plugin below.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    id("com.android.application") version "9.5.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    // Firebase Cloud Messaging (push). On the classpath here; :app applies it only when
    // google-services.json is present, so the project still builds before Firebase is set up.
    id("com.google.gms.google-services") version "4.5.0" apply false
}
