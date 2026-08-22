plugins {
    id("com.android.application") version "8.6.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Firebase Cloud Messaging (push). On the classpath here; :app applies it only when
    // google-services.json is present, so the project still builds before Firebase is set up.
    id("com.google.gms.google-services") version "4.5.0" apply false
}
