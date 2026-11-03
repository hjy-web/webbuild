plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.webh.aiwechat.recovered"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    defaultConfig {
        // A separate ID keeps the existing APK installed and preserves its local data.
        applicationId = "com.webh.aiwechat.recovered"
        minSdk = 26
        targetSdk = 34
        versionCode = 273
        versionName = "2.7.3-fullscreen-media"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
}
