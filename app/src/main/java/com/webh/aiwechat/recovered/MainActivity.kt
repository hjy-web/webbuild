package com.webh.aiwechat.recovered

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
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
    }

    private lateinit var root: FrameLayout
    private lateinit var backgroundWebViews: FrameLayout
    private lateinit var mainWebView: WebView
    private lateinit var embeddedBrowserSlot: FrameLayout
    private lateinit var injectorScript: String
    private val aiPages = mutableMapOf<String, AiPage>()
    private var activeVisibleBotId: String? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserRequestCode = 7314

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        injectorScript = assets.open("web_h_injector.js").bufferedReader().use { it.readText() }

        root = FrameLayout(this)
        backgroundWebViews = FrameLayout(this)
        embeddedBrowserSlot = FrameLayout(this).apply {
            visibility = View.GONE
            setBackgroundColor(Color.TRANSPARENT)
        }

        mainWebView = WebView(this).apply {
            configureSettings(settings)
            addJavascriptInterface(MainUiBridge(), "AndroidWebHBridge")
            webChromeClient = AppWebChromeClient()
            webViewClient = WebViewClient()
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

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureSettings(settings: WebSettings) {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportMultipleWindows(true)
        // Keep Android System WebView's real UA; do not claim an unrelated old Chrome/device.
    }

    private fun normalizeUrl(value: String): String = try {
        Uri.parse(value.trim()).buildUpon().fragment(null).build().toString().trimEnd('/')
    } catch (_: Exception) {
        value.trim().trimEnd('/')
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun getOrCreateAiPage(botId: String, targetUrl: String): AiPage {
        val requestedUrl = targetUrl.trim()
        val existing = aiPages[botId]
        if (existing != null) {
            if (requestedUrl.isNotBlank() && normalizeUrl(requestedUrl) != normalizeUrl(existing.targetUrl)) {
                failInFlight(existing, "聊天人的网页地址已更改，旧页面请求已取消")
                existing.queue.clear()
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
            configureSettings(settings)
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
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        page.ready = false
        if (page.installingInjector) return
        page.installingInjector = true
        webView.evaluateJavascript(injectorScript) {
            runOnUiThread {
                val current = aiPages[botId]
                if (current !== page) return@runOnUiThread
                page.installingInjector = false
                page.ready = true
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
        if (targetUrl.isBlank()) {
            notifyMainUi(errorJson(command, botId, "请先填写该聊天人的网页对话地址"))
            return
        }
        val requestId = command.optString("requestId", "").ifBlank { "req-${System.nanoTime()}" }
        val page = getOrCreateAiPage(botId, targetUrl)
        if (page.inFlight?.requestId == requestId || page.queue.any { it.requestId == requestId }) return
        page.loadFailure?.let { notifyMainUi(errorJson(command, botId, it)); return }
        page.queue.addLast(PendingCommand(command.toString(), requestId, command.optString("groupId", "")))
        drainQueue(page)
    }

    private fun drainQueue(page: AiPage) {
        if (!page.ready || page.installingInjector || page.inFlight != null || page.queue.isEmpty()) return
        val task = page.queue.removeFirst()
        page.inFlight = task
        val encoded = JSONObject.quote(task.raw)
        val script = "(function(){if(typeof window.__webHExecuteCommand!=='function')return 'NO_INJECTOR';window.__webHExecuteCommand(JSON.parse($encoded));return 'STARTED';})()"
        page.webView.evaluateJavascript(script) { result ->
            runOnUiThread {
                if (aiPages[page.botId] !== page || page.inFlight?.requestId != task.requestId) return@runOnUiThread
                if (result == null || result.contains("NO_INJECTOR")) {
                    page.ready = false
                    page.inFlight = null
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
                page.ready = true
                drainQueue(page)
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
            if (page.inFlight == null || requestId.isBlank() || page.inFlight?.requestId == requestId) {
                page.inFlight = null
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
    }

    private fun failPage(page: AiPage, message: String) {
        page.ready = false
        page.loadFailure = message
        failInFlight(page, message)
        while (page.queue.isNotEmpty()) {
            val task = page.queue.removeFirst()
            notifyMainUi(errorJson(JSONObject(task.raw), page.botId, message))
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
                    val existing = aiPages[botId]
                    if (existing != null && normalizeUrl(existing.targetUrl) == normalizeUrl(target)) {
                        failInFlight(existing, "网页地址正在重新加载，当前请求已取消")
                        existing.queue.clear()
                        existing.ready = false
                        existing.loadFailure = null
                        existing.webView.loadUrl(target)
                    } else getOrCreateAiPage(botId, target)
                }
            }
            "EMERGENCY_STOP", "CANCEL_REQUEST" -> stopCommands(command)
        }
    }

    inner class MainUiBridge {
        @JavascriptInterface
        fun postCommand(rawJson: String) {
            runOnUiThread { handleCommandOnUi(rawJson) }
        }
    }

    inner class AiPageHostBridge(private val botId: String) {
        @JavascriptInterface
        fun onBridgeEvent(rawJson: String) {
            runOnUiThread { handleBridgeEvent(rawJson) }
        }
    }

    inner class AiPageWebViewClient(private val botId: String) : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            aiPages[botId]?.takeIf { it.webView === view }?.apply {
                ready = false
                installingInjector = false
                loadFailure = null
            }
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            if (view != null && !url.isNullOrBlank()) onAiPageFinished(botId, view, url)
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

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
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
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
        if (::mainWebView.isInitialized) {
            mainWebView.stopLoading()
            mainWebView.destroy()
        }
        super.onDestroy()
    }
}
