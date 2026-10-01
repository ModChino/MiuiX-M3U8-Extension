/* MiuiX M3U8 浏览器扩展 —— Service Worker
 *
 * 职责：用 webRequest **观察**（不改写）网页发出的 m3u8/mpd 请求 -> 落 chrome.storage.session
 *      -> 把用户手选的候选连同请求头 POST 给本地 MiuiX M3U8（app/core/server.py）。
 *
 * MV3 的三个坑（都在本文件里处理了，别改回去）：
 *   1) webRequest 在 MV3 只能观察：addListener 传 "blocking" 会让整个监听器**直接失效**，
 *      所以只传 extraInfoSpec（['requestHeaders'] / ['responseHeaders']）。
 *   2) Service Worker 随时被挂起：候选列表**不放在内存变量**里，全部落 chrome.storage.session
 *      （普通内存变量在 SW 重启后就没了，用户会看到「刚嗅探到就消失」）。
 *   3) 监听器必须在 SW **顶层同步注册**：包在 async/事件回调里注册，SW 重启后就注册不上，
 *      嗅探从此静默失效。
 */
importScripts('lib/logic.js');

const L = self.MiuiXM3U8;

const DEFAULT_SETTINGS = {
  serverPort: 0,          // MiuiX M3U8 设置页「浏览器扩展」卡片里显示的端口
  serverToken: '',        // 同上，点复制按钮拿到
  uiMode: 'popup',        // 'popup' = 点扩展图标弹面板；'overlay' = 页面右下角常驻悬浮窗
  theme: 'system',        // 'system' 跟随系统 | 'light' 强制浅色 | 'dark' 强制深色
  autoSelect: true,       // 复制的命令行里带 --auto-select
  enrich: true            // 额外请求一次播放列表，用于推断清晰度（拿不到就退回 URL 推断）
};

const SETTINGS_KEY = 'settings';
const MAX_PER_TAB = 60;             // 每个标签页最多留 60 条候选（够用且不撑爆 session storage）
const ENRICH_PER_TAB = 3;           // 每个页面最多额外请求 3 次播放列表
const ENRICH_TIMEOUT_MS = 4000;
const ENRICH_MAX_BYTES = 512 * 1024;
const STASH_LIMIT = 300;

// ================================================================ 顶层同步注册

/* Cookie / Referer / User-Agent 这几个敏感头，Chrome 默认不提供给扩展，要 extraHeaders 才可见；
 * 但万一某个版本/策略不接受这个参数，addListener 会同步抛错 —— 那整条监听就没了（嗅探全废）。
 * 所以先带 extraHeaders 注册，失败再退回基础版本，并在后面用 document.cookie 兜底。 */
function registerRequestHeaderListener() {
  const filter = { urls: ['<all_urls>'] };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders, filter, ['requestHeaders', 'extraHeaders']);
  } catch (error) {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders, filter, ['requestHeaders']);
  }
}
registerRequestHeaderListener();
chrome.webRequest.onHeadersReceived.addListener(
  onHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.webRequest.onBeforeRequest.addListener(
  onMainFrameRequest, { urls: ['<all_urls>'], types: ['main_frame'] });
chrome.webRequest.onCompleted.addListener(onRequestDone, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(onRequestDone, { urls: ['<all_urls>'] });
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.runtime.onMessage.addListener(onMessage);
chrome.storage.onChanged.addListener(onStorageChanged);

chrome.action.setBadgeBackgroundColor({ color: '#3482FF' });

// ================================================================ 小工具

/* 所有存储写操作串行化：webRequest 事件是成串来的，读-改-写并发会丢更新。 */
let writeChain = Promise.resolve();
function serialize(task) {
  const next = writeChain.then(task, task);
  writeChain = next.then(function () {}, function () {});
  return next;
}

function candKey(tabId) { return 'cand:' + tabId; }

async function readCandidates(tabId) {
  const key = candKey(tabId);
  const data = await chrome.storage.session.get(key);
  const list = data[key];
  return Array.isArray(list) ? list : [];
}

async function writeCandidates(tabId, list) {
  const trimmed = list.slice(0, MAX_PER_TAB);
  await chrome.storage.session.set({ [candKey(tabId)]: trimmed });
  setBadge(tabId, trimmed.length);
}

function setBadge(tabId, count) {
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(function () {});
}

function notifyTab(tabId, count) {
  chrome.tabs.sendMessage(tabId, { type: 'candidates-changed', count: count })
    .catch(function () { /* 页面上没有内容脚本（未挂悬浮窗）是正常的 */ });
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};
  const out = {};
  for (const key in DEFAULT_SETTINGS) {
    out[key] = (key in saved) ? saved[key] : DEFAULT_SETTINGS[key];
  }
  out.serverPort = L.normalizePort(out.serverPort);
  out.uiMode = out.uiMode === 'overlay' ? 'overlay' : 'popup';
  out.theme = L.normalizeTheme(out.theme);
  return out;
}

function headerValue(headers, want) {
  const list = headers || [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h && h.name && String(h.name).toLowerCase() === want) return String(h.value || '');
  }
  return '';
}

/* 请求头按 requestId 暂存，供 onHeadersReceived（只能按 Content-Type 识别的那条路）复用。
 * ponytail: 只放内存、上限 300 条；SW 重启会丢，丢了就退回「用标签页 URL 当 Referer」，
 * 不为此再写一份 session storage（每个请求都写存储不值得）。 */
const headerStash = new Map();
function stashHeaders(requestId, headers) {
  headerStash.set(requestId, headers);
  if (headerStash.size > STASH_LIMIT) {
    const oldest = headerStash.keys().next().value;
    headerStash.delete(oldest);
  }
}

async function fallbackHeaders(tabId) {
  let referer = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    referer = (tab && tab.url) || '';
  } catch (e) { /* 标签页已经关了 */ }
  return { referer: referer, cookie: '', userAgent: navigator.userAgent || '', extra: {} };
}

/* 补齐缺失的请求头（**只填空缺，不覆盖抓到的** —— 抓到的更准）：
 *   - Referer / User-Agent：退回标签页 URL 与 navigator.userAgent
 *   - Cookie：退回页面的 document.cookie（content script 提供）—— 与任务约定里
 *     "cookie": "document.cookie" 一致；拿不到就是空，不影响其它流程。 */
async function fillMissingHeaders(tabId, list) {
  const needReferer = list.some(function (c) { return !c.headers || !c.headers.referer || !c.headers.userAgent; });
  const needCookie = list.some(function (c) { return !c.headers || !c.headers.cookie; });
  if (!needReferer && !needCookie) return list;

  let fallback = null;
  if (needReferer) fallback = await fallbackHeaders(tabId);
  let cookie = '';
  if (needCookie) {
    try {
      const info = await chrome.tabs.sendMessage(tabId, { type: 'page-info' });
      cookie = (info && info.cookie) || '';
    } catch (e) { /* 页面没有内容脚本（chrome:// 页 / 扩展页 / 还没注入） */ }
  }
  for (const candidate of list) {
    if (!candidate.headers) candidate.headers = { referer: '', cookie: '', userAgent: '', extra: {} };
    if (fallback && !candidate.headers.referer) candidate.headers.referer = fallback.referer;
    if (fallback && !candidate.headers.userAgent) candidate.headers.userAgent = fallback.userAgent;
    if (cookie && !candidate.headers.cookie) candidate.headers.cookie = cookie.slice(0, 8000);
  }
  return list;
}

// ================================================================ webRequest

function onBeforeSendHeaders(details) {
  if (details.tabId < 0) return;            // -1 = 扩展自己的请求 / 非标签页请求，不要收进列表
  /* 先原样存一份引用（不解析、不复制，成本接近于零）：有些流地址里没有 .m3u8/.mpd，
   * 只能等 onHeadersReceived 看 Content-Type 才知道它是清单 —— 那时请求头早过去了。
   * 到真正需要时再 filterHeaders，避免给每个请求都做一次解析。 */
  if (details.requestHeaders) stashHeaders(details.requestId, details.requestHeaders);
  if (!L.isMediaUrl(details.url)) return;   // 按 URL 命中的这条走这里
  record(details, L.filterHeaders(details.requestHeaders), '').catch(function () {});
}

function onHeadersReceived(details) {
  if (details.tabId < 0) return;
  const contentType = headerValue(details.responseHeaders, 'content-type');
  if (!contentType) return;
  if (!L.isStreamContentType(contentType) && !L.isMediaUrl(details.url)) return;
  const raw = headerStash.get(details.requestId);
  const headers = raw ? L.filterHeaders(raw) : null;
  record(details, headers, contentType).catch(function () {});
}

function onRequestDone(details) {
  headerStash.delete(details.requestId);
}

function onTabRemoved(tabId) {
  chrome.storage.session.remove(candKey(tabId)).catch(function () {});
  enrichCount.delete(tabId);
}

/* 主文档请求（进入页面 / 刷新 / 跳转）= 换了个视频页，旧候选全部作废，
 * 否则用户可能选到上一个视频的流。（SPA 的 pushState 不产生主文档请求，所以不会误清。） */
function onMainFrameRequest(details) {
  if (details.tabId < 0) return;
  serialize(async function () {
    enrichCount.delete(details.tabId);
    const existing = await readCandidates(details.tabId);
    if (existing.length) {
      await writeCandidates(details.tabId, []);
      notifyTab(details.tabId, 0);
    }
  }).catch(function () {});
}

// ================================================================ 候选记录

async function record(details, headers, contentType) {
  return serialize(async function () {
    const tabId = details.tabId;
    const list = await readCandidates(tabId);
    const index = list.findIndex(function (c) { return c.url === details.url; });
    const now = Date.now();
    let candidate;
    let needEnrich = false;

    if (index >= 0) {
      candidate = list[index];
      candidate.hits = (candidate.hits || 1) + 1;
      candidate.time = now;
      if (contentType) candidate.contentType = contentType;
      if (headers) candidate.headers = headers;
      if (details.frameId) candidate.frameId = details.frameId;
      list.splice(index, 1);
    } else {
      candidate = {
        url: details.url,
        tabId: tabId,
        frameId: details.frameId || 0,
        time: now,
        hits: 1,
        kind: L.streamKind(details.url, contentType),
        contentType: contentType || '',
        headers: headers || null,
        quality: L.parseQuality(details.url, ''),
        fromBody: false
      };
      needEnrich = true;
    }
    list.unshift(candidate);
    await writeCandidates(tabId, list);
    notifyTab(tabId, list.length);
    if (needEnrich) maybeEnrich(tabId, details.url);
  });
}

// ================================================================ 清晰度补全
/* 只靠 URL 推断不出画质时（如 /master.m3u8、.mpd），自己去拉一次清单正文解析
 * #EXT-X-STREAM-INF / <Representation>。拿不到就保持「未知」，不影响其它流程。 */

const enrichCount = new Map();

async function maybeEnrich(tabId, url) {
  const settings = await getSettings();
  if (!settings.enrich) return;
  if (!L.isMediaUrl(url)) return;
  if ((enrichCount.get(tabId) || 0) >= ENRICH_PER_TAB) return;
  enrichCount.set(tabId, (enrichCount.get(tabId) || 0) + 1);
  await enrich(tabId, url);
}

async function enrich(tabId, url) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ENRICH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > ENRICH_MAX_BYTES) return;
    const text = (await response.text()).slice(0, ENRICH_MAX_BYTES);
    const info = L.parsePlaylist(text);
    if (!info || (!info.height && !info.bandwidth)) return;   // 正文没给出信息就别动 URL 推断的结果
    await serialize(async function () {
      const list = await readCandidates(tabId);
      const hit = list.find(function (c) { return c.url === url; });
      if (!hit) return;
      hit.fromBody = true;
      hit.quality = L.parseQuality(url, text);   // 正文优先、URL 兜底（与纯逻辑单测用同一条路径）
      await writeCandidates(tabId, list);
      notifyTab(tabId, list.length);
    });
  } catch (e) {
    /* 防盗链 / 跨域 / 超时都无所谓：URL 推断的结果仍然在 */
  } finally {
    clearTimeout(timer);
  }
}

// ================================================================ 消息

function onMessage(message, sender, sendResponse) {
  handleMessage(message, sender).then(sendResponse, function (error) {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  });
  return true;   // 异步回复
}

async function handleMessage(message, sender) {
  const msg = message || {};
  const tabId = (msg.tabId !== undefined && msg.tabId !== null)
    ? Number(msg.tabId)
    : (sender && sender.tab ? sender.tab.id : -1);

  if (msg.type === 'get-settings') {
    return { ok: true, settings: await getSettings() };
  }

  if (msg.type === 'get-candidates') {
    const settings = await getSettings();
    const list = tabId >= 0 ? await readCandidates(tabId) : [];
    if (tabId >= 0) await fillMissingHeaders(tabId, list);   // 面板要展示/复制完整命令，缺的头先补齐
    const candidates = L.normalizeCandidates(list);
    let title = msg.title || '';
    if (tabId >= 0) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.title) title = tab.title;   // chrome.tabs 的标题优先
      } catch (e) { /* 标签页没了 */ }
    }
    const clean = L.cleanTitle(title);
    for (const candidate of candidates) candidate.title = clean;
    const first = candidates.length ? candidates[0] : null;
    return {
      ok: true,
      tabId: tabId,
      title: clean,
      rawTitle: title,
      candidates: candidates,
      defaultUrl: first ? first.url : '',
      settings: settings
    };
  }

  if (msg.type === 'clear') {
    if (tabId < 0) return { ok: false, error: 'no tab' };
    await serialize(async function () {
      await writeCandidates(tabId, []);
      enrichCount.delete(tabId);
    });
    notifyTab(tabId, 0);
    return { ok: true };
  }

  if (msg.type === 'ping') {
    const settings = await getSettings();
    const base = L.baseUrl(settings.serverPort);
    if (!base) return { ok: false, error: '还没填端口' };
    try {
      const response = await fetch(base + '/ping', { cache: 'no-store' });
      const data = await response.json();
      return { ok: true, app: data.app || '', port: settings.serverPort };
    } catch (e) {
      return { ok: false, error: '连不上 ' + base + '（MiuiX M3U8 是否已启动？端口对不对？）' };
    }
  }

  if (msg.type === 'send') {
    return await sendToApp(tabId, msg, await getSettings());
  }

  return { ok: false, error: 'unknown message: ' + msg.type };
}

async function sendToApp(tabId, msg, settings) {
  const base = L.baseUrl(settings.serverPort);
  if (!base) return { ok: false, error: '还没填端口：打开扩展设置，填入 MiuiX M3U8 设置页显示的端口' };
  if (!settings.serverToken) return { ok: false, error: '还没填访问令牌：打开扩展设置，粘贴 MiuiX M3U8 里复制的令牌' };
  if (!msg.url) return { ok: false, error: '没有选中候选' };

  const list = tabId >= 0 ? await readCandidates(tabId) : [];
  if (tabId >= 0) await fillMissingHeaders(tabId, list);
  const hit = list.find(function (c) { return c.url === msg.url; });
  if (!hit) return { ok: false, error: '这个候选已经不在列表里了，刷新后重试' };

  const candidate = { url: hit.url, title: msg.title || '', headers: hit.headers };
  const payload = L.buildAddPayload(candidate, settings.serverToken);
  try {
    const response = await fetch(base + '/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (response.ok && data && data.ok) {
      return { ok: true, taskId: data.task_id || '' };
    }
    if (response.status === 403) {
      return { ok: false, error: '访问令牌不对（回 MiuiX M3U8 设置页重新复制令牌）' };
    }
    return { ok: false, error: (data && data.error) || ('HTTP ' + response.status) };
  } catch (e) {
    return { ok: false, error: '连不上 ' + base + '：' + String((e && e.message) || e) };
  }
}

// ================================================================ 设置变更
/* 设置页改了「界面形式」或「外观」，正在开着的页面要立刻跟上（不用刷新页面）。
 * popup / options 是独立页面，各自读设置（popup 每次打开都会重读），只有内容脚本需要推送。 */
function onStorageChanged(changes, area) {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const next = changes[SETTINGS_KEY].newValue || {};
  const payload = {
    type: 'settings-changed',
    uiMode: next.uiMode === 'overlay' ? 'overlay' : 'popup',
    theme: L.normalizeTheme(next.theme)
  };
  chrome.tabs.query({}).then(function (tabs) {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, payload).catch(function () {});
    }
  }).catch(function () {});
}
