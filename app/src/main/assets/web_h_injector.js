/**
 * Web H (OmniChat) Android In-App WebView DOM Injector v2.4
 * 支持：
 * 1. 自动填入与多策略自动点击发送
 * 2. 手动点击发送后的自动回复监听
 * 3. 复制原网页 AI 回复（含图片、视频、文件链接）时自动捕获为「仅记忆一次」的零内存临时剪贴包
 */
(function () {
  if (window.__WEB_H_INJECTOR_INSTALLED__) return;
  window.__WEB_H_INJECTOR_INSTALLED__ = true;

  const INPUT_FALLBACKS = [
    '#chat-input',
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea:not([disabled]):not(#pending-conversation-input)',
    '[role="textbox"]',
    'input[type="text"]'
  ];

  const SEND_FALLBACKS = [
    'button[data-testid="send-button"]',
    'div[role="button"].ds-send-btn',
    'div.ds-icon-button[role="button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button.send-button',
    'button[type="submit"]',
    '[role="button"][aria-label*="Send"]',
    '[role="button"][aria-label*="发送"]'
  ];

  const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"] div.markdown',
    '[data-message-author-role="assistant"]',
    '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
    '.ds-markdown',
    '.font-claude-message',
    'message-content',
    '[class*="assistant"] .markdown-body',
    '[data-testid*="assistant-message"]',
    '.markdown-body',
    '.prose'
  ].join(',');

  const GENERATING_INDICATORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Cancel"]',
    'button.ds-stop-btn',
    '.result-thinking',
    '.streaming',
    '[data-testid*="stop"]'
  ].join(',');

  function emitToHost(payload) {
    if (window.AndroidWebHHost && typeof window.AndroidWebHHost.onBridgeEvent === 'function') {
      window.AndroidWebHHost.onBridgeEvent(JSON.stringify(payload));
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage({ __webHBridge: true, payload }, '*');
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findFirstVisible(selectors) {
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const list = Array.from(document.querySelectorAll(sel));
        const found = list.find(isVisible);
        if (found) return found;
      } catch (_e) {}
    }
    return null;
  }

  function waitForVisibleInput(selectors, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let observer = null;
      const timeout = setTimeout(() => finish(new Error('AI 网页已打开，但登录后仍未找到可用输入框；请检查网页或输入框选择器')), timeoutMs);
      const finish = (error, element) => {
        if (finished) return;
        finished = true;
        observer?.disconnect();
        clearTimeout(timeout);
        error ? reject(error) : resolve(element);
      };
      const inspect = () => {
        const element = findFirstVisible(selectors);
        if (element) finish(null, element);
      };
      if (document.documentElement) {
        observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-hidden'] });
      }
      inspect();
    });
  }

  function findNearbySendButton(inputEl, customSelector) {
    const selectors = customSelector ? [customSelector, ...SEND_FALLBACKS] : SEND_FALLBACKS;
    const direct = findFirstVisible(selectors);
    if (direct && !direct.disabled) return direct;

    let container = inputEl ? inputEl.parentElement : null;
    for (let depth = 0; depth < 5 && container; depth++) {
      const candidates = Array.from(
        container.querySelectorAll('button:not([disabled]), div[role="button"]:not([aria-disabled="true"])')
      ).filter((el) => isVisible(el) && el.querySelector('svg'));
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
      container = container.parentElement;
    }
    return null;
  }

  function getLeafAssistantNodes() {
    const raw = Array.from(document.querySelectorAll(ASSISTANT_SELECTORS));
    return raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));
  }

  function extractMediaFromNode(node) {
    if (!node) return [];
    const items = [];
    const imgs = Array.from(node.querySelectorAll('img'));
    imgs.forEach((img, idx) => {
      const src = img.currentSrc || img.src || '';
      if (src && !src.startsWith('data:image/svg')) {
        items.push({
          id: 'ai-img-' + Date.now() + '-' + idx,
          name: img.getAttribute('alt') || 'AI生成图片_' + (idx + 1) + '.png',
          type: 'image/png',
          url: src,
          ephemeralInMemoryOnly: true
        });
      }
    });
    const videos = Array.from(node.querySelectorAll('video, source'));
    videos.forEach((vid, idx) => {
      const src = vid.currentSrc || vid.src || '';
      if (src) {
        items.push({
          id: 'ai-vid-' + Date.now() + '-' + idx,
          name: 'AI生成视频_' + (idx + 1) + '.mp4',
          type: 'video/mp4',
          url: src,
          ephemeralInMemoryOnly: true
        });
      }
    });
    const links = Array.from(node.querySelectorAll('a[href]'));
    links.forEach((a, idx) => {
      const href = a.href || '';
      if (a.hasAttribute('download') || /\.(pdf|zip|docx?|xlsx?|csv|txt|py|js|json|mp3|wav)(\?|$)/i.test(href)) {
        items.push({
          id: 'ai-file-' + Date.now() + '-' + idx,
          name: (a.innerText || a.getAttribute('download') || 'AI生成文件_' + (idx + 1)).trim(),
          type: 'application/octet-stream',
          url: href,
          ephemeralInMemoryOnly: true
        });
      }
    });
    return items;
  }

  // 监听用户在原网页中的复制动作（捕获文字 + 图片/视频/文件，仅记忆一次，不写磁盘）
  document.addEventListener('copy', function () {
    try {
      const sel = window.getSelection();
      const selText = sel ? sel.toString().trim() : '';
      const nodes = getLeafAssistantNodes();
      const lastNode = nodes[nodes.length - 1];
      const targetNode = (sel && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(ASSISTANT_SELECTORS)) || lastNode;
      const text = selText || (targetNode ? (targetNode.innerText || '').trim() : '');
      const attachments = extractMediaFromNode(targetNode);
      if (text || attachments.length > 0) {
        const lastCmd = window.__webHLastCommand || {};
        emitToHost({
          type: 'EPHEMERAL_AI_COPY',
          botId: lastCmd.botId || 'deepseek',
          text: text,
          attachments: attachments
        });
      }
    } catch (_e) {}
  });

  function isPageGenerating() {
    const els = Array.from(document.querySelectorAll(GENERATING_INDICATORS));
    return els.some(isVisible);
  }

  function setNativeInputValue(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.innerText = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      return true;
    } catch (_e) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  function attachCommandFiles(attachments) {
    const files = (attachments || []).filter((item) => typeof item?.url === 'string' && item.url.startsWith('data:'));
    if (!files.length) return 0;
    const fileInput = Array.from(document.querySelectorAll('input[type="file"]'))[0];
    if (!fileInput) throw new Error('网页没有文件上传入口，图片或视频未发送');
    const transfer = new DataTransfer();
    for (const item of files) {
      const match = item.url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) continue;
      const mimeType = item.type || match[1] || 'application/octet-stream';
      let bytes;
      if (match[2]) {
        const binary = atob(match[3]);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
      }
      transfer.items.add(new File([bytes], item.name || 'chat-attachment', { type: mimeType }));
    }
    if (!transfer.files.length) throw new Error('附件格式无法读取，图片或视频未发送');
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return transfer.files.length;
  }

  let activeLoopId = 0;
  let loopSequence = 0;
  let activeRequestId = null;
  let lastReportedReplyText = '';
  let manualCompletionTimer = null;

  window.__webHCancelCommand = function (requestId) {
    if (!requestId || activeRequestId !== requestId) return false;
    activeLoopId = 0;
    activeRequestId = null;
    return true;
  };

  function readLatestReply(beforeCount, beforeText, beforeMediaSignature, payload) {
    const nodes = getLeafAssistantNodes();
    const lastNode = nodes[nodes.length - 1];
    const text = lastNode ? (lastNode.innerText || '').trim() : '';
    const attachments = extractMediaFromNode(lastNode);
    const mediaSignature = attachments.map((item) => item.url).join('|');
    const hasNewReply = nodes.length > beforeCount ||
      (text && text !== beforeText && text !== (payload || '').trim()) ||
      mediaSignature !== beforeMediaSignature;
    return { nodes, lastNode, text, attachments, mediaSignature, hasNewReply };
  }

  function waitForNewReply(command, myLoopId, beforeCount, beforeText, beforeMediaSignature) {
    return new Promise((resolve, reject) => {
      let observer = null;
      let timeoutTimer = null;
      let quietTimer = null;
      let sawGenerating = false;
      let firstTokenSent = false;
      let firstSentenceSent = false;
      let lastObservedText = '';
      let finished = false;
      const cleanup = () => { observer?.disconnect(); clearTimeout(timeoutTimer); clearTimeout(quietTimer); };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        cleanup();
        error ? reject(error) : resolve(value);
      };
      const inspect = () => {
        if (finished) return;
        if (activeLoopId !== myLoopId) { finish(null, null); return; }
        const current = readLatestReply(beforeCount, beforeText, beforeMediaSignature, command.payload);
        if (!current.hasNewReply) return;
        if (current.text && !firstTokenSent) {
          firstTokenSent = true;
          emitToHost({ type: 'BOT_PROGRESS', phase: 'first-token', botId: command.botId, groupId: command.groupId, requestId: command.requestId, text: current.text });
        }
        if (current.text && !firstSentenceSent && /[。！？.!?\n]/.test(current.text)) {
          firstSentenceSent = true;
          emitToHost({ type: 'BOT_PROGRESS', phase: 'first-sentence', botId: command.botId, groupId: command.groupId, requestId: command.requestId, text: current.text });
        }
        if (isPageGenerating()) {
          sawGenerating = true;
          lastObservedText = current.text;
          clearTimeout(quietTimer);
          quietTimer = null;
          return;
        }
        if (current.text === (command.payload || '').trim()) return;
        const settle = () => {
          if (activeLoopId !== myLoopId) { finish(null, null); return; }
          const latest = readLatestReply(beforeCount, beforeText, beforeMediaSignature, command.payload);
          if (!latest.hasNewReply || isPageGenerating()) { inspect(); return; }
          if (latest.text !== current.text || latest.mediaSignature !== current.mediaSignature) { inspect(); return; }
          lastReportedReplyText = latest.text;
          activeLoopId = 0;
          activeRequestId = null;
          const result = { type: 'BOT_REPLY', botId: command.botId, groupId: command.groupId,
            requestId: command.requestId, syncThrough: command.syncThrough,
            text: latest.text, attachments: latest.attachments, deltaPayload: command.payload || '' };
          emitToHost(result);
          finish(null, latest);
        };
        if (sawGenerating) queueMicrotask(settle);
        else if (current.text !== lastObservedText || !quietTimer) {
          lastObservedText = current.text;
          clearTimeout(quietTimer);
          // Adaptive quiet-window only for providers that expose no stop/generating marker.
          quietTimer = setTimeout(settle, 450);
        }
      };
      observer = new MutationObserver(inspect);
      if (document.documentElement) observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'style', 'aria-label', 'disabled', 'aria-busy']
      });
      timeoutTimer = setTimeout(() => finish(new Error('网页已接收消息，但 90 秒内没有识别到 AI 新回复；请检查登录状态、页面限制或回复选择器')), 90000);
      inspect();
    });
  }

  const initialAssistantNodes = getLeafAssistantNodes();
  if (initialAssistantNodes.length) lastReportedReplyText = (initialAssistantNodes[initialAssistantNodes.length - 1].innerText || '').trim();

  function watchManualReply() {
    if (activeLoopId > 0) return;
    const nodes = getLeafAssistantNodes();
    if (!nodes.length) return;
    const lastNode = nodes[nodes.length - 1];
    const currentText = (lastNode.innerText || '').trim();
    if (!currentText || currentText === lastReportedReplyText || isPageGenerating()) return;
    clearTimeout(manualCompletionTimer);
    manualCompletionTimer = setTimeout(() => {
      if (activeLoopId > 0 || isPageGenerating()) return;
      const latestNodes = getLeafAssistantNodes();
      const latestNode = latestNodes[latestNodes.length - 1];
      const latestText = latestNode ? (latestNode.innerText || '').trim() : '';
      if (!latestText || latestText !== currentText || latestText === lastReportedReplyText) return;
      lastReportedReplyText = latestText;
      const lastCmd = window.__webHLastCommand || {};
      emitToHost({ type: 'BOT_REPLY', botId: lastCmd.botId || 'deepseek', groupId: lastCmd.groupId,
        requestId: lastCmd.requestId, syncThrough: lastCmd.syncThrough, text: latestText,
        attachments: extractMediaFromNode(latestNode), deltaPayload: lastCmd.payload || '手动网页发送' });
    }, 450);
  }
  const manualReplyObserver = new MutationObserver(watchManualReply);
  if (document.documentElement) manualReplyObserver.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'aria-label', 'disabled', 'aria-busy']
  });

  window.__webHExecuteCommand = async function (command) {
    window.__webHLastCommand = command;
    const myLoopId = ++loopSequence;
    activeLoopId = myLoopId;
    activeRequestId = command.requestId || null;

    try {
      const inputSelectors = command.selectorInput ? [command.selectorInput, ...INPUT_FALLBACKS] : INPUT_FALLBACKS;
      const inputEl = await waitForVisibleInput(inputSelectors, Number(command.inputReadyTimeoutMs) || 30000);
      if (activeLoopId !== myLoopId) return;

      const beforeNodes = getLeafAssistantNodes();
      const beforeCount = beforeNodes.length;
      const beforeLastText = beforeCount > 0 ? (beforeNodes[beforeCount - 1].innerText || '').trim() : '';

      setNativeInputValue(inputEl, command.payload || '');
      const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const expectedText = normalizeText(command.payload);
      const insertedText = normalizeText(inputEl.value || inputEl.innerText);
      if (expectedText && insertedText !== expectedText) {
        throw new Error('消息没有完整写入 AI 输入框，已停止发送以免发出残缺内容');
      }

      attachCommandFiles(command.attachments);

      const sendBtn = findNearbySendButton(inputEl, command.selectorSend);
      if (sendBtn) {
        sendBtn.click();
      } else {
        const form = inputEl.closest('form');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else throw new Error('输入框已找到，但没有可用的发送按钮；请检查发送按钮选择器');
      }

      const beforeMediaSignature = extractMediaFromNode(beforeNodes[beforeNodes.length - 1]).map((item) => item.url).join('|');
      const reply = await waitForNewReply(command, myLoopId, beforeCount, beforeLastText, beforeMediaSignature);
      if (!reply) return;
    } catch (err) {
      if (activeLoopId === myLoopId) {
        activeLoopId = 0;
        activeRequestId = null;
      }
      emitToHost({
        type: 'BOT_ERROR',
        botId: command.botId,
        groupId: command.groupId,
        requestId: command.requestId,
        syncThrough: command.syncThrough,
        message: err && err.message ? err.message : String(err)
      });
    }
  };
})();
