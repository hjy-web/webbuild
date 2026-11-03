/**
 * Web H Android WebView connector.
 * Site-specific DOM adapters for supported providers; no API keys and no blind Enter.
 */
(() => {
  const installedKey = '__WEB_H_INJECTOR_INSTALLED_V3__';
  if (window[installedKey]) {
    window.__webHInjectorReady = true;
    return true;
  }
  window[installedKey] = true;

  const PROVIDERS = [
    {
      id: 'chatgpt',
      names: ['chatgpt', 'gpt', 'openai'],
      hosts: ['chatgpt.com', 'chat.openai.com'],
      inputs: ['#prompt-textarea', 'textarea[data-testid*="prompt-textarea"]', '[contenteditable="true"][data-placeholder*="Message"]'],
      sends: ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label*="Send prompt"]', 'button[aria-label*="发送"]'],
      assistants: ['[data-message-author-role="assistant"]', '[data-testid*="assistant-message"]'],
      users: ['[data-message-author-role="user"]'],
      generating: ['button[data-testid="stop-button"]', '[data-message-author-role="assistant"][data-is-streaming="true"]']
    },
    {
      id: 'gemini',
      names: ['gemini'],
      hosts: ['gemini.google.com'],
      inputs: ['rich-textarea [contenteditable="true"]', '[role="textbox"][contenteditable="true"]', 'div[contenteditable="true"]'],
      sends: ['button[data-test-id="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="发送"]'],
      assistants: ['model-response', '.model-response-text', '[data-message-author-role="assistant"]'],
      users: ['user-query', '[data-message-author-role="user"]'],
      generating: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]', '[data-test-id*="stop"]', 'model-response[aria-busy="true"]']
    },
    {
      id: 'claude',
      names: ['claude'],
      hosts: ['claude.ai'],
      inputs: ['div.ProseMirror[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"][data-placeholder]'],
      sends: ['button[aria-label="Send Message"]', 'button[aria-label*="Send"]', 'button[aria-label*="发送"]'],
      assistants: ['.font-claude-message', '[data-testid*="assistant-message"]', '[data-testid="chat-message"]'],
      users: ['[data-testid*="human-message"]', '[data-testid*="user-message"]'],
      generating: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]', '[data-is-streaming="true"]']
    },
    {
      id: 'kimi',
      names: ['kimi', 'moonshot'],
      hosts: ['kimi.com', 'moonshot.cn'],
      inputs: ['[data-testid*="chat-input"]', 'div[contenteditable="true"].chat-input', '[contenteditable="true"]', 'textarea'],
      sends: ['button[data-testid*="send"]', 'button.send-button', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
      assistants: ['[data-testid*="assistant-message"]', '[data-role="assistant"]', '.segment-assistant', 'message-content'],
      users: ['[data-testid*="user-message"]', '[data-role="user"]'],
      generating: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]', '[data-testid*="stop"]']
    },
    {
      id: 'doubao',
      names: ['doubao', '豆包'],
      hosts: ['doubao.com'],
      inputs: ['[contenteditable="true"][data-placeholder]', '[role="textbox"][contenteditable="true"]', 'textarea[placeholder]', '[contenteditable="true"]'],
      sends: ['button[data-testid*="send"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]', '[role="button"][aria-label*="发送"]'],
      assistants: ['[data-role="assistant"]', '[data-testid*="assistant-message"]', '[class*="assistant-message"]', '[class*="message-content"]', '[class*="markdown"]'],
      users: ['[data-role="user"]', '[data-testid*="user-message"]'],
      generating: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]', '[aria-busy="true"]']
    },
    {
      id: 'qwen',
      names: ['qwen', '千问', '通义'],
      hosts: ['qwen.ai', 'tongyi.com', 'aliyun.com'],
      inputs: ['textarea[placeholder]', '[role="textbox"][contenteditable="true"]', '[contenteditable="true"]'],
      sends: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', 'button[data-testid*="send"]', 'button[type="submit"]'],
      assistants: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[data-testid*="assistant-message"]', '[class*="assistant-message"]', '.markdown-body', '[class*="markdown"]', 'message-content'],
      users: ['[data-message-author-role="user"]', '[data-role="user"]', '[data-testid*="user-message"]'],
      generating: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]', '[aria-busy="true"]']
    },
    {
      id: 'deepseek',
      names: ['deepseek', '深度求索'],
      hosts: ['deepseek.com'],
      inputs: ['#chat-input', 'textarea#chat-input'],
      sends: ['div[role="button"].ds-send-btn', 'button[aria-label*="发送"]'],
      assistants: ['.ds-markdown', '[data-message-author-role="assistant"]'],
      users: ['[data-message-author-role="user"]'],
      generating: ['button.ds-stop-btn', '.result-thinking', '[data-testid*="stop"]']
    }
  ];

  const GENERIC_INPUTS = [
    '[role="textbox"][contenteditable="true"]',
    'textarea:not([disabled]):not([readonly]):not([type="password"]):not(#pending-conversation-input)',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]:not([disabled]):not([readonly])'
  ];
  const GENERIC_SENDS = [
    'button[aria-label*="Send"]', 'button[aria-label*="发送"]',
    '[role="button"][aria-label*="Send"]', '[role="button"][aria-label*="发送"]',
    'button[data-testid*="send"]', 'button[type="submit"]'
  ];
  const GENERIC_ASSISTANTS = [
    '[data-message-author-role="assistant"]', '[data-role="assistant"]', '[data-author="assistant"]',
    '[data-testid*="assistant-message"]', '[class*="assistant-message"]', '[class*="message_assistant"]',
    'model-response', 'message-content', '.ds-markdown', '.font-claude-message'
  ];
  const GENERIC_USERS = ['[data-message-author-role="user"]', '[data-role="user"]', '[data-author="user"]'];
  const GENERIC_GENERATING = [
    'button[data-testid*="stop"]', 'button[aria-label*="Stop"]', 'button[aria-label*="停止"]',
    'button[aria-label*="Cancel"]', '[data-is-streaming="true"]'
  ];
  const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
  const CHUNK_BYTES = 48 * 1024;
  const CANCEL_EVENT = '__webh_cancel_command_v3__';
  let activeRun = null;
  let lastManualSignature = '';
  let manualQuietTimer = null;

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hostMatches(host, allowed) {
    return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  function chooseProvider(command) {
    const host = String(location.hostname || '').toLowerCase();
    const platform = String(command.platform || '').toLowerCase();
    return PROVIDERS.find((provider) => hostMatches(host, provider.hosts) || provider.names.some((name) => platform.includes(name))) || null;
  }

  function collectRoots() {
    const roots = [document];
    const seen = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      let nodes = [];
      try { nodes = roots[index].querySelectorAll('*'); } catch (_error) {}
      for (const node of nodes) {
        if (node.shadowRoot && !seen.has(node.shadowRoot)) {
          seen.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    return roots;
  }

  function queryAllDeep(selector) {
    if (!selector) return [];
    const found = [];
    const seen = new Set();
    for (const root of collectRoots()) {
      try {
        for (const element of root.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            found.push(element);
          }
        }
      } catch (_error) {}
    }
    return found;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function isDisabled(element) {
    return Boolean(element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true');
  }

  function isEditable(element) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return !isDisabled(element);
    if (tag === 'INPUT') return !isDisabled(element) && !['search', 'email', 'password', 'file', 'checkbox', 'radio', 'button', 'submit'].includes(String(element.type || '').toLowerCase());
    return element.isContentEditable || element.getAttribute('role') === 'textbox';
  }

  function selectorCandidates(selectors) {
    const candidates = [];
    const seen = new Set();
    selectors.forEach((selector, rank) => {
      queryAllDeep(selector).forEach((element) => {
        if (!seen.has(element)) {
          seen.add(element);
          candidates.push({ element, rank, selector });
        }
      });
    });
    return candidates;
  }

  function findInput(command, provider) {
    const selectors = [...new Set([command.selectorInput, ...(provider?.inputs || []), ...GENERIC_INPUTS].filter(Boolean))];
    const candidates = selectorCandidates(selectors).filter(({ element }) => isVisible(element) && isEditable(element));
    const main = queryAllDeep('main,[role="main"]')[0] || document.body;
    const words = /message|prompt|ask|input|send|输入|消息|提问|发送|anything/i;
    return candidates.map((candidate) => {
      const element = candidate.element;
      const rect = element.getBoundingClientRect();
      const hint = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-placeholder') || ''}`;
      let score = 100 - candidate.rank * 5;
      if (candidate.rank === 0 && command.selectorInput) score += 150;
      if (provider?.inputs?.includes(candidate.selector)) score += 60;
      if (main.contains(element)) score += 15;
      if (words.test(hint)) score += 18;
      if (element.isContentEditable) score += 10;
      score += Math.min(25, Math.max(0, rect.top / Math.max(1, innerHeight)) * 25);
      if (/search|搜索/i.test(hint)) score -= 80;
      return { element, score };
    }).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function findSendButton(input, command, provider) {
    const selectors = [...new Set([command.selectorSend, ...(provider?.sends || []), ...GENERIC_SENDS].filter(Boolean))];
    const candidates = selectorCandidates(selectors).filter(({ element }) => isVisible(element) && !isDisabled(element));
    const inputForm = input?.closest('form');
    return candidates.map(({ element, rank }) => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.innerText || ''}`;
      let score = 100 - rank * 5;
      if (rank === 0 && command.selectorSend) score += 150;
      if (provider?.sends?.includes(selectors[rank])) score += 60;
      if (inputForm && element.closest('form') === inputForm) score += 80;
      if (/send|发送|submit|提交/i.test(label)) score += 25;
      if (/stop|cancel|停止|取消|upload|上传|attach|附件/i.test(label)) score -= 150;
      return { element, score };
    }).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function observeDeep(callback) {
    let closed = false;
    let observer;
    const observedRoots = new Set();
    const attachRoots = () => {
      if (closed) return;
      for (const root of collectRoots()) {
        if (observedRoots.has(root)) continue;
        try {
          observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'aria-label', 'aria-busy', 'disabled', 'data-is-streaming'] });
          observedRoots.add(root);
        } catch (_error) {}
      }
    };
    observer = new MutationObserver(() => {
      attachRoots();
      callback();
    });
    attachRoots();
    return () => {
      closed = true;
      observer.disconnect();
    };
  }

  function waitUntil(predicate, timeoutMs, timeoutMessage, run) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopObserving = () => {};
      const cleanup = () => {
        clearTimeout(timer);
        stopObserving();
        window.removeEventListener(CANCEL_EVENT, onCancel);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const inspect = () => {
        if (run?.cancelled) {
          finish(new Error('请求已停止'));
          return;
        }
        try {
          const value = predicate();
          if (value) finish(null, value);
        } catch (error) {
          finish(error);
        }
      };
      const onCancel = () => inspect();
      const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
      window.addEventListener(CANCEL_EVENT, onCancel);
      stopObserving = observeDeep(inspect);
      inspect();
    });
  }

  function readInput(element) {
    return normalize(element?.value ?? element?.innerText ?? element?.textContent ?? '');
  }

  function setInputValue(element, text) {
    element.focus();
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted || readInput(element) !== normalize(text)) {
      element.replaceChildren(document.createTextNode(text));
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getMessageNodes(selectors) {
    const nodes = selectorCandidates(selectors).map((item) => item.element).filter((element) => isVisible(element));
    return nodes
      .filter((node) => !nodes.some((other) => other !== node && node.contains(other)))
      .sort((a, b) => {
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
  }

  function extractMedia(node) {
    if (!node) return [];
    const result = [];
    node.querySelectorAll('img,video,a[href]').forEach((element, index) => {
      let url = '';
      let type = 'application/octet-stream';
      let name = '';
      if (element.tagName === 'IMG') {
        const rect = element.getBoundingClientRect();
        if (!isVisible(element) || rect.width < 48 || rect.height < 48 || (element.complete && element.naturalWidth === 0)) return;
        url = element.currentSrc || element.src || '';
        type = 'image/*';
        name = element.alt || `AI 图片 ${index + 1}`;
      } else if (element.tagName === 'VIDEO') {
        if (!isVisible(element)) return;
        url = element.currentSrc || element.src || '';
        type = 'video/*';
        name = `AI 视频 ${index + 1}`;
      } else {
        url = element.href || '';
        if (!element.hasAttribute('download') && !/\.(pdf|docx?|xlsx?|csv|txt|zip|pptx?|mp[34])(?:[?#]|$)/i.test(url)) return;
        type = 'application/octet-stream';
        name = (element.innerText || element.getAttribute('download') || `AI 文件 ${index + 1}`).trim();
      }
      if (!url || url.startsWith('data:image/svg')) return;
      result.push({ id: `web-reply-${Date.now()}-${index}`, name, type, url, element });
    });
    return result;
  }

  function isGenerating(provider) {
    const selectors = [...new Set([...(provider?.generating || []), ...GENERIC_GENERATING])];
    return selectorCandidates(selectors).some(({ element }) => {
      if (!isVisible(element) || element.disabled || element.getAttribute('aria-hidden') === 'true') return false;
      if (element.matches('[aria-busy="true"]')) {
        let current = element;
        let responseContext = false;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          const label = `${current.tagName} ${current.id || ''} ${current.className?.baseVal || current.className || ''} ${current.getAttribute?.('data-testid') || ''} ${current.getAttribute?.('data-role') || ''}`;
          if (/(assistant|model-response|answer|bot-response|reply)/i.test(label)) responseContext = true;
          if (/(user-query|human-message|user-message|chat-user|question)/i.test(label)) return false;
        }
        if (!responseContext) return false;
      }
      return true;
    });
  }

  function captureAssistant(provider) {
    const userSelectors = [...(provider?.users || []), ...GENERIC_USERS];
    const nodes = getMessageNodes([...(provider?.assistants || []), ...GENERIC_ASSISTANTS]).filter((node) => {
      let current = node;
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const label = `${current.tagName} ${current.id || ''} ${current.className?.baseVal || current.className || ''} ${current.getAttribute?.('data-testid') || ''} ${current.getAttribute?.('data-role') || ''} ${current.getAttribute?.('data-message-author-role') || ''}`;
        if (/(user-query|human-message|user-message|chat-user|user_turn|user-message|question)/i.test(label)) return false;
        if (userSelectors.some((selector) => {
          try { return current.matches(selector); } catch (_error) { return false; }
        })) return false;
      }
      return true;
    });
    const last = nodes[nodes.length - 1] || null;
    const text = normalize(last?.innerText || last?.textContent || '');
    const attachments = extractMedia(last);
    return { nodes, last, text, attachments, mediaSignature: attachments.map((item) => item.url).join('|') };
  }

  function captureUser(provider) {
    const nodes = getMessageNodes([...(provider?.users || []), ...GENERIC_USERS]);
    return nodes.map((node) => normalize(node.innerText || node.textContent || '')).filter(Boolean);
  }

  function readAttachmentBytes(item) {
    if (item.url?.startsWith('data:')) {
      const match = item.url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
      if (!match) throw new Error(`${item.name || '附件'}的数据格式无法读取`);
      const binary = match[2] ? atob(match[3]) : unescape(encodeURIComponent(decodeURIComponent(match[3])));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    const bridge = window.AndroidWebHHost;
    const fileId = item.attachmentId;
    const size = Number(item.size || 0);
    if (!bridge || typeof bridge.readAttachmentChunk !== 'function' || !fileId || !Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${item.name || '附件'}无法从本机附件缓存读取`);
    }
    const chunks = [];
    for (let offset = 0; offset < size;) {
      const encoded = bridge.readAttachmentChunk(fileId, offset, CHUNK_BYTES);
      if (!encoded) throw new Error(`${item.name || '附件'}读取中断（${offset}/${size} 字节）`);
      const binary = atob(encoded);
      const chunk = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) chunk[i] = binary.charCodeAt(i);
      chunks.push(chunk);
      offset += chunk.length;
    }
    return chunks;
  }

  async function attachCommandFiles(command) {
    const attachments = Array.isArray(command.attachments) ? command.attachments : [];
    if (!attachments.length) return 0;
    const inputs = queryAllDeep('input[type="file"]');
    const input = inputs.find((element) => !isDisabled(element)) || null;
    if (!input) throw new Error(`${command.platform || '此网页'}没有可用的文件上传控件；附件未发送`);
    const transfer = new DataTransfer();
    for (const item of attachments) {
      const chunks = readAttachmentBytes(item);
      const byteLength = Array.isArray(chunks) ? chunks.reduce((sum, part) => sum + part.byteLength, 0) : chunks.byteLength;
      if (!byteLength || byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${item.name || '附件'}为空或超过 100 MB 限制`);
      const parts = Array.isArray(chunks) ? chunks : [chunks];
      transfer.items.add(new File(parts, item.name || 'chat-attachment', { type: item.type || 'application/octet-stream' }));
    }
    try {
      input.files = transfer.files;
    } catch (_error) {
      throw new Error(`${command.platform || '此网页'}拒绝接收本地文件`);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (input.files.length !== attachments.length) throw new Error('网页文件控件未确认收到全部附件');
    return input.files.length;
  }

  async function stageReplyAttachments(attachments, command) {
    const bridge = window.AndroidWebHHost;
    const canStage = bridge && typeof bridge.beginReplyAttachmentUpload === 'function' &&
      typeof bridge.writeReplyAttachmentChunk === 'function' && typeof bridge.finishReplyAttachmentUpload === 'function';
    const staged = [];
    for (let index = 0; index < (attachments || []).length; index += 1) {
      const item = attachments[index];
      let nativeId = '';
      try {
        if (!canStage) {
          if (item.url.startsWith('http:') || item.url.startsWith('https:') || item.url.startsWith('data:')) staged.push({ id: item.id, name: item.name, type: item.type, url: item.url });
          else staged.push({ id: item.id, name: item.name, type: item.type, url: '', transferError: '该媒体只能在 AI 网页内访问' });
          continue;
        }
        const response = await fetch(item.url, { credentials: 'include', cache: 'force-cache' });
        if (!response.ok) throw new Error(`网页返回 ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || blob.size > MAX_ATTACHMENT_BYTES) throw new Error('文件为空或超过 100 MB');
        const safeRequestId = String(command.requestId || Date.now()).replace(/[^A-Za-z0-9_-]/g, '_');
        nativeId = `reply_${safeRequestId}_${index}_${Math.random().toString(36).slice(2, 8)}`;
        if (!bridge.beginReplyAttachmentUpload(nativeId, blob.size)) throw new Error('手机无法创建临时接收文件');
        for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
          const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + CHUNK_BYTES)).arrayBuffer());
          let binary = '';
          for (let cursor = 0; cursor < bytes.length; cursor += 0x8000) binary += String.fromCharCode(...bytes.subarray(cursor, Math.min(bytes.length, cursor + 0x8000)));
          if (!bridge.writeReplyAttachmentChunk(nativeId, btoa(binary))) throw new Error(`接收在 ${offset}/${blob.size} 字节处中断`);
        }
        if (!bridge.finishReplyAttachmentUpload(nativeId)) throw new Error('临时文件完整性校验失败');
        staged.push({ id: item.id, attachmentId: nativeId, name: item.name, type: blob.type || item.type, size: blob.size });
      } catch (error) {
        if (nativeId) bridge?.discardReplyAttachmentUpload?.(nativeId);
        staged.push({ id: item.id, name: item.name, type: item.type, url: item.url.startsWith('http:') || item.url.startsWith('https:') || item.url.startsWith('data:') ? item.url : '', transferError: error?.message || String(error) });
      }
    }
    return staged;
  }

  function replySignature(snapshot) {
    return `${snapshot.nodes.length}|${snapshot.text}|${snapshot.mediaSignature}`;
  }

  function waitForAccepted(command, provider, input, beforeUsers, beforeAssistant, run) {
    const expected = normalize(command.payload);
    return waitUntil(() => {
      const nowUsers = captureUser(provider);
      const newUserMessage = nowUsers.length > beforeUsers.length && (!expected || nowUsers.slice(beforeUsers.length).some((text) => text.includes(expected.slice(0, Math.min(48, expected.length)))));
      const inputCleared = !expected || readInput(input) === '';
      const assistant = captureAssistant(provider);
      const generating = isGenerating(provider);
      const assistantStarted = assistant.nodes.length > beforeAssistant.nodes.length || (assistant.text && assistant.text !== beforeAssistant.text);
      return newUserMessage || (Boolean(expected) && inputCleared) || (inputCleared && (generating || assistantStarted));
    }, Number(command.acceptTimeoutMs) || 15000, '网页没有确认接收这条消息；我已停止等待，避免把未发送内容当成成功', run);
  }

  function waitForReply(command, provider, before, run) {
    const timeoutMs = Math.min(300000, Math.max(30000, Number(command.replyTimeoutMs) || 180000));
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawGenerating = false;
      let quietTimer = null;
      let stopObserving = () => {};
      let latest = before;
      const cleanup = () => {
        clearTimeout(deadlineTimer);
        clearTimeout(quietTimer);
        stopObserving();
        window.removeEventListener(CANCEL_EVENT, onCancel);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const inspect = () => {
        if (settled) return;
        if (run.cancelled) {
          finish(new Error('请求已停止'));
          return;
        }
        const current = captureAssistant(provider);
        const generating = isGenerating(provider);
        sawGenerating = sawGenerating || generating;
        if (current.text && normalize(current.text) === normalize(command.payload)) return;
        const isNew = current.nodes.length > before.nodes.length || Boolean(current.text && current.text !== before.text) || current.mediaSignature !== before.mediaSignature;
        if (!isNew) return;
        latest = current;
        if (current.text || current.attachments.length) {
          if (!run.firstTokenSent) {
            run.firstTokenSent = true;
            run.emit({ type: 'BOT_PROGRESS', phase: 'first-token', text: current.text || 'AI 已返回媒体内容' });
          }
          if (!run.firstSentenceSent && /[。！？.!?\n]/.test(current.text)) {
            run.firstSentenceSent = true;
            run.emit({ type: 'BOT_PROGRESS', phase: 'first-sentence', text: current.text });
          }
        }
        clearTimeout(quietTimer);
        if (generating) return;
        const observedSignature = replySignature(current);
        quietTimer = setTimeout(() => {
          const finalSnapshot = captureAssistant(provider);
          if (isGenerating(provider)) {
            sawGenerating = true;
            inspect();
            return;
          }
          if (replySignature(finalSnapshot) !== observedSignature) {
            inspect();
            return;
          }
          const replyText = finalSnapshot.text;
          if (!replyText && !finalSnapshot.attachments.length) return;
          finish(null, finalSnapshot);
        }, sawGenerating ? 900 : 1600);
      };
      const onCancel = () => inspect();
      const deadlineTimer = setTimeout(() => {
        const detail = latest.text || latest.attachments.length
          ? 'AI 页面出现了新内容，但页面没有显示完成状态或内容仍在变化'
          : '网页已确认收件，但没有识别到新的 AI 回复气泡';
        finish(new Error(`${detail}（等待上限 ${Math.round(timeoutMs / 1000)} 秒）；请检查登录、页面提示或站点选择器`));
      }, timeoutMs);
      window.addEventListener(CANCEL_EVENT, onCancel);
      stopObserving = observeDeep(inspect);
      inspect();
    });
  }

  async function executeCommand(command) {
    const run = {
      requestId: command.requestId || '',
      cancelled: false,
      firstTokenSent: false,
      firstSentenceSent: false,
      emit(payload) {
        const full = { botId: command.botId, groupId: command.groupId, requestId: command.requestId, syncThrough: command.syncThrough, ...payload };
        if (window.AndroidWebHHost && typeof window.AndroidWebHHost.onBridgeEvent === 'function') {
          window.AndroidWebHHost.onBridgeEvent(JSON.stringify(full));
        } else if (window.parent && window.parent !== window) {
          window.parent.postMessage({ __webHBridge: true, payload: full }, '*');
        }
      }
    };
    activeRun = run;
    window.__webHLastCommand = command;
    const provider = chooseProvider(command);
    try {
      const input = await waitUntil(() => findInput(command, provider), Number(command.inputReadyTimeoutMs) || 45000,
        `没有找到${provider?.id || command.platform || '网页'}的聊天输入框；请确认已登录且对话页已打开`, run);
      const beforeAssistant = captureAssistant(provider);
      const beforeUsers = captureUser(provider);
      const expected = normalize(command.payload);
      setInputValue(input, command.payload || '');
      if (expected && readInput(input) !== expected) throw new Error('消息未完整写入输入框，已停止发送');
      await attachCommandFiles(command);

      const accepted = waitForAccepted(command, provider, input, beforeUsers, beforeAssistant, run);
      const sendButton = findSendButton(input, command, provider);
      if (sendButton) {
        sendButton.click();
      } else {
        const form = input.closest('form');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else throw new Error(`找到了输入框，但${provider?.id || '网页'}没有可识别的发送按钮；未盲目按 Enter`);
      }
      await accepted;
      const reply = await waitForReply(command, provider, beforeAssistant, run);
      const attachments = await stageReplyAttachments(reply.attachments, command);
      run.emit({ type: 'BOT_REPLY', text: reply.text, attachments, deltaPayload: command.payload || '' });
      lastManualSignature = replySignature(reply);
    } catch (error) {
      if (!run.cancelled) {
        run.emit({ type: 'BOT_ERROR', message: error?.message || String(error) });
      }
    } finally {
      if (activeRun === run) activeRun = null;
    }
  }

  window.__webHCancelCommand = (requestId) => {
    if (!activeRun || !requestId || activeRun.requestId !== requestId) return false;
    activeRun.cancelled = true;
    window.dispatchEvent(new Event(CANCEL_EVENT));
    return true;
  };
  window.__webHExecuteCommand = (command) => executeCommand(command);
  window.__webHInjectorReady = true;
  window.__WEB_H_INJECTOR_INSTALLED__ = true;
  return true;
})();
