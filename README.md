# Web H Android connector repair

This is the recovered Android project for Web H. The existing chat UI and custom appearance settings remain in place. The Android host now uses immersive full-screen layout and a dynamic viewport that respects display cutouts and the on-screen keyboard.

## Connector changes

- Uses one persistent Android WebView per AI chat person, with a separate serial queue for each page and concurrent work across different AI pages.
- Provides site-aware adapters for ChatGPT, Gemini, Claude, Kimi, Doubao, Qwen, and DeepSeek. It checks that the page accepted the message and reads the newest assistant response from DOM changes. It does not send by blind Enter.
- Sends local files to AI pages through 48 KB chunks in the Android cache. It also copies generated images, videos, and downloadable files back from the AI page into the chat UI. Temporary files are removed when the request finishes or is cancelled. The per-file limit is 100 MB.
- Fails visibly when the native Android bridge is unavailable instead of showing a synthetic reply as if it came from an AI page.
- Migrates the two known invalid sample DeepSeek and ChatGPT URLs while preserving other saved URLs and settings.

Provider pages still require the user to sign in, and a provider can change its page structure or block embedded browsers. Those conditions produce a visible error instead of a successful-looking empty reply.

## Build

The project uses Android Gradle Plugin 8.9.2, Gradle 8.11.1, Android SDK Platform 35, Build Tools 35.0.0, and JDK 17. A GitHub Actions workflow at `.github/workflows/android-debug.yml` builds on pushes to `main` or `master` and uploads `webh-recovered-app-debug` for 14 days.

For a local build, open this folder in Android Studio and run **Build > Build APK(s)**, or use Gradle 8.11.1 with `gradle --no-daemon assembleDebug`.

The application ID is `com.webh.aiwechat.recovered`, so the repaired build installs alongside the original app. The original APK signing key was not included in the supplied APK, so this recovered copy cannot update the original package in place.
