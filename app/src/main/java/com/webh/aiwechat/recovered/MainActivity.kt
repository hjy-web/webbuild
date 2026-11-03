package com.webh.aiwechat.recovered

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import org.json.JSONObject
import java.util.ArrayDeque
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap

/**
 * Recovered Web H Android host. The bundled web UI is kept intact; this class fixes
 * command loss while AI pages load, stale bot URLs, and unhandled cancellation.
 */
class MainActivity : ComponentActivity() {
    private data class PendingCommand(
        val raw: String,
        val requestId: String,
        val groupId: String
    )

    private data class AttachmentUploadSession(
        val file: File,
        val expectedSize: Long,
        var writtenSize: Long = 0L
    )

    private class AiPage(
        val botId: String,
        val webView: WebView,
        var targetUrl: String
    ) {
        var ready = false
        var installingInjector = false
        var loadFailure: String? = null
        var inFlight: PendingCommand? = null
        val queue = ArrayDeque<PendingCommand>()
        val activeAttachmentIds: MutableSet<String> = ConcurrentHashMap.newKeySet()
    }

    private lateinit var root: FrameLayout
    private lateinit var backgroundWebViews: FrameLayout
    private lateinit var mainWebView: WebView
    private lateinit var embeddedBrowserSlot: FrameLayout
    private lateinit var injectorScript: String
    private val aiPages = mutableMapOf<String, AiPage>()
    private val attachmentUploadSessions = ConcurrentHashMap<String, AttachmentUploadSession>()
    private val stagedAttachmentFiles = ConcurrentHashMap<String, File>()
    private var activeVisibleBotId: String? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserRequestCode = 7314

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyImmersiveFullscreen()
        injectorScript = assets.open("web_h_injector.js").bufferedReader().use { it.readText() }

        root = FrameLayout(this)
        backgroundWebViews = FrameLayout(this)
        embeddedBrowserSlot = FrameLayout(this).apply {
            visibility = View.GONE
            setBackgroundColor(Color.TRANSPARENT)
        }

        mainWebView = WebView(this).apply {
            configureSettings(settings, isLocalUi = true)
            addJavascriptInterface(MainUiBridge(), "AndroidWebHBridge")
            webChromeClient = AppWebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val uri = request?.url ?: return true
                    if (uri.scheme == "file" && uri.path?.startsWith("/android_asset/www/") == true) return false
                    if (uri.scheme == "https" || uri.scheme == "http") {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }
                    return true
                }
            }
            loadUrl("file:///android_asset/www/index.html")
        }

        // Keep AI WebViews attached behind the main UI so page JS remains available.
        root.addView(backgroundWebViews, matchParent())
        root.addView(mainWebView, matchParent())
        root.addView(embeddedBrowserSlot, matchParent())
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val page = activeVisibleBotId?.let(aiPages::get)
                when {
                    embeddedBrowserSlot.visibility == View.VISIBLE && page?.webView?.canGoBack() == true -> page.webView.goBack()
                    mainWebView.canGoBack() -> mainWebView.goBack()
                    else -> finish()
                }
            }
        })
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
    )

    @Suppress("DEPRECATION")
    private fun applyImmersiveFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let { controller ->
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveFullscreen()
    }

    private fun validAttachmentId(value: String): Boolean =
        value.length in 8..100 && value.matches(Regex("[A-Za-z0-9_-]+"))

    private fun attachmentIds(rawCommand: String): List<String> {
        return try {
            val attachments = JSONObject(rawCommand).optJSONArray("attachments") ?: return emptyList()
            buildList {
                for (index in 0 until attachments.length()) {
                    val id = attachments.optJSONObject(index)?.optString("attachmentId", "") ?: ""
                    if (validAttachmentId(id)) add(id)
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun discardAttachment(id: String) {
        if (!validAttachmentId(id)) return
        attachmentUploadSessions.remove(id)?.file?.delete()
        stagedAttachmentFiles.remove(id)?.delete()
    }

    private fun discardCommandAttachments(rawCommand: String) {
        attachmentIds(rawCommand).forEach(::discardAttachment)
    }

    private fun clearActiveAttachments(page: AiPage) {
        val ids = page.activeAttachmentIds.toList()
        page.activeAttachmentIds.clear()
        ids.forEach(::discardAttachment)
    }

    private fun clearQueuedCommands(page: AiPage) {
        page.queue.toList().forEach { task -> discardCommandAttachments(task.raw) }
        page.queue.clear()
    }

    private fun beginAttachmentUpload(id: String, size: Long): Boolean {
        if (!validAttachmentId(id) || size !in 1..MAX_ATTACHMENT_BYTES) return false
        return try {
            discardAttachment(id)
            val file = File(cacheDir, "webh-$id.part")
            file.parentFile?.mkdirs()
            if (!file.createNewFile()) return false
            attachmentUploadSessions[id] = AttachmentUploadSession(file, size)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun writeAttachmentChunk(id: String, encodedChunk: String): Boolean {
        if (!validAttachmentId(id) || encodedChunk.length > MAX_BASE64_CHUNK_CHARS) return false
        val session = attachmentUploadSessions[id] ?: return false
        return try {
            val bytes = Base64.decode(encodedChunk, Base64.NO_WRAP)
            if (bytes.isEmpty() || bytes.size > MAX_ATTACHMENT_CHUNK_BYTES) return false
            synchronized(session) {
                if (session.writtenSize + bytes.size > session.expectedSize) return false
                FileOutputStream(session.file, true).use { it.write(bytes) }
                session.writtenSize += bytes.size
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun finishAttachmentUpload(id: String): Boolean {
        if (!validAttachmentId(id)) return false
        val session = attachmentUploadSessions[id] ?: return false
        return try {
            synchronized(session) {
                if (session.writtenSize != session.expectedSize) {
                    discardAttachment(id)
                    return false
                }
                val finalFile = File(cacheDir, "webh-$id.bin")
                finalFile.delete()
                if (!session.file.renameTo(finalFile)) {
                    discardAttachment(id)
                    return false
                }
                attachmentUploadSessions.remove(id, session)
                stagedAttachmentFiles[id] = finalFile
            }
            true
        } catch (_: Exception) {
            discardAttachment(id)
            false
        }
    }

    private fun readAttachmentChunk(botId: String, id: String, offset: Long, requestedLength: Int): String {
        if (!validAttachmentId(id) || offset < 0) return ""
        val page = aiPages[botId] ?: return ""
        if (!page.activeAttachmentIds.contains(id)) return ""
        return readStagedAttachmentChunk(id, offset, requestedLength)
    }

    private fun readStagedAttachmentChunk(id: String, offset: Long, requestedLength: Int): String {
        if (!validAttachmentId(id) || offset < 0) return ""
        val file = stagedAttachmentFiles[id] ?: return ""
        val remaining = file.length() - offset
        if (remaining <= 0) return ""
        val length = minOf(requestedLength.coerceIn(1, MAX_ATTACHMENT_CHUNK_BYTES), remaining.toInt())
        return try {
            val bytes = ByteArray(length)
            RandomAccessFile(file, "r").use { input ->
                input.seek(offset)
                input.readFully(bytes)
            }
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } catch (_: Exception) {
            ""
        }
    }

    private companion object {
        const val MAX_ATTACHMENT_BYTES = 100L * 1024L * 1024L
        const val MAX_ATTACHMENT_CHUNK_BYTES = 48 * 1024
        const val MAX_BASE64_CHUNK_CHARS = 70 * 1024
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureSettings(settings: WebSettings, isLocalUi: Boolean) {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccess = isLocalUi
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.allowContentAccess = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportMultipleWindows(true)
        // Keep Android System WebView's real UA; do not claim an unrelated old Chrome/device.
    }

    private fun normalizeUrl(value: String): String {
        return try {
            val uri = Uri.parse(value.trim())
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || !uri.userInfo.isNullOrBlank()) ""
            else uri.buildUpon().fragment(null).build().toString().trimEnd('/')
        } catch (_: Exception) {
            ""
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun getOrCreateAiPage(botId: String, targetUrl: String): AiPage {
        val requestedUrl = targetUrl.trim()
        if (normalizeUrl(requestedUrl).isBlank()) throw IllegalArgumentException("AI 网页地址必须是有效的 HTTPS 地址")
        val existing = aiPages[botId]
        if (existing != null) {
            if (requestedUrl.isNotBlank() && normalizeUrl(requestedUrl) != normalizeUrl(existing.targetUrl)) {
                failInFlight(existing, "聊天人的网页地址已更改，旧页面请求已取消")
                clearQueuedCommands(existing)
                existing.targetUrl = requestedUrl
                existing.ready = false
                existing.installingInjector = false
                existing.loadFailure = null
                existing.webView.loadUrl(requestedUrl)
            }
            return existing
        }

        val webView = WebView(this).apply {
            layoutParams = matchParent()
            configureSettings(settings, isLocalUi = false)
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            addJavascriptInterface(AiPageHostBridge(botId), "AndroidWebHHost")
            webChromeClient = AppWebChromeClient()
            webViewClient = AiPageWebViewClient(botId)
        }
        backgroundWebViews.addView(webView, matchParent())
        val page = AiPage(botId, webView, requestedUrl)
        aiPages[botId] = page
        if (requestedUrl.isNotBlank()) webView.loadUrl(requestedUrl)
        return page
    }

    private fun onAiPageFinished(botId: String, webView: WebView, url: String) {
        val page = aiPages[botId] ?: return
        if (page.webView !== webView) return
        if (normalizeUrl(url).isBlank()) return
        page.ready = false
        if (page.installingInjector) return
        page.installingInjector = true
        webView.evaluateJavascript(injectorScript) { result ->
            runOnUiThread {
                val current = aiPages[botId]
                if (current !== page) return@runOnUiThread
                page.installingInjector = false
                page.ready = result?.trim() == "true"
                if (!page.ready) {
                    failPage(page, "网页连接脚本未能安装；请更新 Android System WebView 后重试")
                    return@runOnUiThread
                }
                CookieManager.getInstance().flush()
                notifyMainUi(JSONObject().apply {
                    put("type", "WEBVIEW_URL_CHANGED")
                    put("botId", botId)
                    put("url", url)
                }.toString())
                drainQueue(page)
            }
        }
    }

    private fun enqueueCommand(raw: String) {
        val command = try { JSONObject(raw) } catch (_: Exception) {
            notifyMainUi(errorJson(null, null, "收到无法解析的发送命令"))
            return
        }
        val botId = command.optString("botId", "deepseek").ifBlank { "deepseek" }
        val targetUrl = command.optString("targetUrl", "")
        if (targetUrl.isBlank() || normalizeUrl(targetUrl).isBlank()) {
            notifyMainUi(errorJson(command, botId, "请先填写该聊天人的网页对话地址"))
            discardCommandAttachments(raw)
            return
        }
        val requestId = command.optString("requestId", "").ifBlank { "req-${System.nanoTime()}" }
        val page = try {
            getOrCreateAiPage(botId, targetUrl)
        } catch (error: Exception) {
            notifyMainUi(errorJson(command, botId, error.message ?: "AI 网页地址无效"))
            discardCommandAttachments(raw)
            return
        }
        if (page.inFlight?.requestId == requestId || page.queue.any { it.requestId == requestId }) return
        page.loadFailure?.let {
            notifyMainUi(errorJson(command, botId, it))
            discardCommandAttachments(raw)
            return
        }
        page.queue.addLast(PendingCommand(command.toString(), requestId, command.optString("groupId", "")))
        drainQueue(page)
    }

    private fun drainQueue(page: AiPage) {
        if (!page.ready || page.installingInjector || page.inFlight != null || page.queue.isEmpty()) return
        val task = page.queue.removeFirst()
        page.inFlight = task
        page.activeAttachmentIds.clear()
        page.activeAttachmentIds.addAll(attachmentIds(task.raw))
        val encoded = JSONObject.quote(task.raw)
        val script = "(function(){if(typeof window.__webHExecuteCommand!=='function')return 'NO_INJECTOR';window.__webHExecuteCommand(JSON.parse($encoded));return 'STARTED';})()"
        page.webView.evaluateJavascript(script) { result ->
            runOnUiThread {
                if (aiPages[page.botId] !== page || page.inFlight?.requestId != task.requestId) return@runOnUiThread
                if (result == null || result.contains("NO_INJECTOR")) {
                    page.ready = false
                    page.inFlight = null
                    page.activeAttachmentIds.clear()
                    page.queue.addFirst(task)
                    installInjectorAgain(page)
                }
            }
        }
    }

    private fun installInjectorAgain(page: AiPage) {
        if (page.installingInjector) return
        page.installingInjector = true
        page.webView.evaluateJavascript(injectorScript) {
            runOnUiThread {
                if (aiPages[page.botId] !== page) return@runOnUiThread
                page.installingInjector = false
                page.ready = it?.trim() == "true"
                if (page.ready) drainQueue(page)
                else failPage(page, "网页连接脚本未能重新安装；请重新加载该聊天网页")
            }
        }
    }

    private fun handleBridgeEvent(rawJson: String) {
        val event = try { JSONObject(rawJson) } catch (_: Exception) { return }
        val botId = event.optString("botId", "")
        val type = event.optString("type", "")
        val page = aiPages[botId]
        if (page != null && type in setOf("BOT_REPLY", "BOT_ERROR", "BOT_CANCELLED")) {
            val requestId = event.optString("requestId", "")
            if (page.inFlight?.requestId == requestId && requestId.isNotBlank()) {
                page.inFlight = null
                clearActiveAttachments(page)
                drainQueue(page)
            }
        }
        notifyMainUi(event.toString())
    }

    private fun stopCommands(command: JSONObject) {
        val groupId = command.optString("groupId", "")
        val requestId = command.optString("requestId", "")
        val botId = command.optString("botId", "")
        aiPages.values.forEach { page ->
            if (botId.isNotBlank() && botId != page.botId) return@forEach
            val queued = page.queue.toList()
            page.queue.clear()
            queued.forEach { task ->
                if ((requestId.isBlank() || requestId == task.requestId) &&
                    (groupId.isBlank() || groupId == task.groupId)) {
                    notifyMainUi(cancelledJson(page.botId, task))
                    discardCommandAttachments(task.raw)
                } else {
                    page.queue.addLast(task)
                }
            }
            val active = page.inFlight
            if (active != null && (requestId.isBlank() || requestId == active.requestId) &&
                (groupId.isBlank() || groupId == active.groupId)) {
                val encoded = JSONObject.quote(active.requestId)
                page.webView.evaluateJavascript("window.__webHCancelCommand && window.__webHCancelCommand($encoded)", null)
                page.inFlight = null
                clearActiveAttachments(page)
                notifyMainUi(cancelledJson(page.botId, active))
                drainQueue(page)
            }
        }
    }

    private fun errorJson(command: JSONObject?, botId: String?, message: String) = JSONObject().apply {
        put("type", "BOT_ERROR")
        if (!botId.isNullOrBlank()) put("botId", botId)
        if (command != null) {
            put("groupId", command.optString("groupId", ""))
            put("requestId", command.optString("requestId", ""))
            if (command.has("syncThrough")) put("syncThrough", command.optInt("syncThrough"))
        }
        put("message", message)
    }.toString()

    private fun cancelledJson(botId: String, task: PendingCommand) = JSONObject().apply {
        put("type", "BOT_CANCELLED")
        put("botId", botId)
        put("groupId", task.groupId)
        put("requestId", task.requestId)
    }.toString()

    private fun failInFlight(page: AiPage, message: String) {
        val task = page.inFlight ?: return
        page.inFlight = null
        notifyMainUi(errorJson(JSONObject(task.raw), page.botId, message))
        clearActiveAttachments(page)
    }

    private fun failPage(page: AiPage, message: String) {
        page.ready = false
        page.loadFailure = message
        failInFlight(page, message)
        while (page.queue.isNotEmpty()) {
            val task = page.queue.removeFirst()
            notifyMainUi(errorJson(JSONObject(task.raw), page.botId, message))
            discardCommandAttachments(task.raw)
        }
    }

    private fun notifyMainUi(rawJson: String) {
        if (!::mainWebView.isInitialized) return
        runOnUiThread {
            val escaped = JSONObject.quote(rawJson)
            mainWebView.evaluateJavascript(
                "window.__onAndroidBridgeEvent && window.__onAndroidBridgeEvent($escaped);",
                null
            )
        }
    }

    private fun showPage(botId: String, targetUrl: String, topPx: Int, heightPx: Int) {
        if (normalizeUrl(targetUrl).isBlank()) {
            notifyMainUi(errorJson(null, botId, "AI 网页地址必须是有效的 HTTPS 地址"))
            return
        }
        val page = getOrCreateAiPage(botId, targetUrl)
        activeVisibleBotId?.takeIf { it != botId }?.let { previousBotId ->
            aiPages[previousBotId]?.webView?.let { previousView ->
                (previousView.parent as? ViewGroup)?.removeView(previousView)
                backgroundWebViews.addView(previousView, matchParent())
            }
        }
        (page.webView.parent as? ViewGroup)?.removeView(page.webView)
        embeddedBrowserSlot.removeAllViews()
        embeddedBrowserSlot.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            if (heightPx > 0) heightPx else ViewGroup.LayoutParams.MATCH_PARENT
        ).apply { topMargin = topPx.coerceAtLeast(0) }
        embeddedBrowserSlot.addView(page.webView, matchParent())
        embeddedBrowserSlot.visibility = View.VISIBLE
        activeVisibleBotId = botId
    }

    private fun hideEmbeddedPage() {
        val botId = activeVisibleBotId
        val webView = botId?.let(aiPages::get)?.webView
        if (webView != null) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            backgroundWebViews.addView(webView, matchParent())
        }
        embeddedBrowserSlot.visibility = View.GONE
        activeVisibleBotId = null
    }

    private fun handleCommandOnUi(raw: String) {
        val command = try { JSONObject(raw) } catch (_: Exception) { return }
        when (command.optString("action")) {
            "SEND_TO_TAB" -> enqueueCommand(raw)
            "SHOW_EMBEDDED_WEBVIEW" -> showPage(
                command.optString("botId", "deepseek"),
                command.optString("targetUrl", ""),
                command.optInt("topPx", 140),
                command.optInt("heightPx", -1)
            )
            "HIDE_EMBEDDED_WEBVIEW" -> hideEmbeddedPage()
            "RELOAD_WEBVIEW" -> command.optString("botId", "deepseek").let { botId ->
                aiPages[botId]?.let { it.ready = false; it.webView.reload() }
            }
            "NAVIGATE_WEBVIEW" -> {
                val botId = command.optString("botId", "deepseek")
                val target = command.optString("targetUrl", "")
                if (target.isNotBlank()) {
                    if (normalizeUrl(target).isBlank()) {
                        notifyMainUi(errorJson(command, botId, "AI 网页地址必须是有效的 HTTPS 地址"))
                        return
                    }
                    val existing = aiPages[botId]
                    if (existing != null && normalizeUrl(existing.targetUrl) == normalizeUrl(target)) {
                        failInFlight(existing, "网页地址正在重新加载，当前请求已取消")
                        clearQueuedCommands(existing)
                        existing.ready = false
                        existing.loadFailure = null
                        existing.webView.loadUrl(target)
                    } else {
                        getOrCreateAiPage(botId, target)
                    }
                }
            }
            "EMERGENCY_STOP", "CANCEL_REQUEST" -> stopCommands(command)
        }
    }

    inner class MainUiBridge {
        @JavascriptInterface
        fun postCommand(rawJson: String) {
            runOnUiThread {
                try {
                    handleCommandOnUi(rawJson)
                } catch (error: Exception) {
                    notifyMainUi(errorJson(runCatching { JSONObject(rawJson) }.getOrNull(), null, error.message ?: "Android 网页桥发生错误"))
                    discardCommandAttachments(rawJson)
                }
            }
        }

        @JavascriptInterface
        fun beginAttachmentUpload(id: String, size: Long): Boolean = this@MainActivity.beginAttachmentUpload(id, size)

        @JavascriptInterface
        fun writeAttachmentChunk(id: String, base64Chunk: String): Boolean = this@MainActivity.writeAttachmentChunk(id, base64Chunk)

        @JavascriptInterface
        fun finishAttachmentUpload(id: String): Boolean = this@MainActivity.finishAttachmentUpload(id)

        @JavascriptInterface
        fun discardAttachment(id: String): Boolean {
            this@MainActivity.discardAttachment(id)
            return true
        }

        @JavascriptInterface
        fun readReplyAttachmentChunk(id: String, offset: Long, length: Int): String =
            this@MainActivity.readStagedAttachmentChunk(id, offset, length)

        @JavascriptInterface
        fun discardReplyAttachment(id: String): Boolean {
            this@MainActivity.discardAttachment(id)
            return true
        }
    }

    inner class AiPageHostBridge(private val botId: String) {
        @JavascriptInterface
        fun onBridgeEvent(rawJson: String) {
            runOnUiThread { handleBridgeEvent(rawJson) }
        }

        @JavascriptInterface
        fun readAttachmentChunk(id: String, offset: Long, length: Int): String = this@MainActivity.readAttachmentChunk(botId, id, offset, length)

        @JavascriptInterface
        fun beginReplyAttachmentUpload(id: String, size: Long): Boolean = this@MainActivity.beginAttachmentUpload(id, size)

        @JavascriptInterface
        fun writeReplyAttachmentChunk(id: String, base64Chunk: String): Boolean = this@MainActivity.writeAttachmentChunk(id, base64Chunk)

        @JavascriptInterface
        fun finishReplyAttachmentUpload(id: String): Boolean = this@MainActivity.finishAttachmentUpload(id)

        @JavascriptInterface
        fun discardReplyAttachmentUpload(id: String): Boolean {
            this@MainActivity.discardAttachment(id)
            return true
        }
    }

    inner class AiPageWebViewClient(private val botId: String) : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            aiPages[botId]?.takeIf { it.webView === view }?.apply {
                failInFlight(this, "AI 网页正在重新加载；当前发送已取消")
                ready = false
                installingInjector = false
                loadFailure = null
            }
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            if (view != null && !url.isNullOrBlank()) onAiPageFinished(botId, view, url)
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val uri = request?.url ?: return true
            return uri.scheme != "https" || uri.host.isNullOrBlank() || !uri.userInfo.isNullOrBlank()
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            super.onReceivedError(view, request, error)
            if (request?.isForMainFrame == true) {
                val page = aiPages[botId] ?: return
                failPage(page, "网页加载失败 (${error?.errorCode ?: -1})：${error?.description ?: "网络连接错误"}")
            }
        }

        override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, response: android.webkit.WebResourceResponse?) {
            super.onReceivedHttpError(view, request, response)
            if (request?.isForMainFrame == true && (response?.statusCode ?: 200) >= 400) {
                val page = aiPages[botId] ?: return
                failPage(page, "AI 网页返回 HTTP ${response?.statusCode}，请检查登录状态或该平台是否允许内嵌访问")
            }
        }

        override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) {
            handler?.cancel()
            val page = aiPages[botId] ?: return
            failPage(page, "AI 网页 TLS 证书校验失败，已安全停止连接")
        }
    }

    inner class AppWebChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback
            val intent = try {
                fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
            } catch (_: Exception) {
                Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
            }
            return try {
                startActivityForResult(Intent.createChooser(intent, "选择文件"), fileChooserRequestCode)
                true
            } catch (_: Exception) {
                fileChooserCallback = null
                false
            }
        }
    }

    @Deprecated("Deprecated in Android API; retained for WebView file chooser callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == fileChooserRequestCode) {
            val result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            fileChooserCallback?.onReceiveValue(result)
            fileChooserCallback = null
        }
    }

    override fun onDestroy() {
        aiPages.values.forEach { page ->
            (page.webView.parent as? ViewGroup)?.removeView(page.webView)
            page.webView.stopLoading()
            page.webView.destroy()
        }
        aiPages.clear()
        attachmentUploadSessions.keys.toList().forEach(::discardAttachment)
        stagedAttachmentFiles.keys.toList().forEach(::discardAttachment)
        if (::mainWebView.isInitialized) {
            mainWebView.stopLoading()
            mainWebView.destroy()
        }
        super.onDestroy()
    }
}
