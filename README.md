# Web H Android repair copy

This is a reconstructed Android project with the original bundled Web H interface and assets. Its separate application ID is `com.webh.aiwechat.recovered`, so the debug build can be installed alongside the original APK.

## Build

The project uses JDK 17, Android Gradle Plugin 8.9.2, Gradle 8.11.1, Android SDK Platform 35, and Build Tools 35.0.0. The GitHub Actions workflow builds `app-debug.apk` on pushes to `main` or `master` and can also be run manually from the Actions tab. Download the `webh-recovered-app-debug` artifact from the workflow run.

The original APK signing key is not included; this debug build cannot replace the original installation.