/* MiuiX M3U8 浏览器扩展 —— 页面悬浮窗（右下角常驻，可在设置里关闭）
 *
 * 只有在设置里把「界面形式」选成「页面悬浮窗」时才挂载；选「点图标弹出面板」时
 * 本脚本什么都不做（收到 settings-changed 再决定挂/卸，外观也跟着一起变）。
 * 样式放在 Shadow DOM 里，避免和页面 CSS 互相污染。
 */
(function () {
  'use strict';

  var HOST_ID = 'miuix-m3u8-overlay-host';
  if (window.top !== window) return;                 // 只在顶层文档显示
  if (document.getElementById(HOST_ID)) return;      // 防重复注入

  var L = window.MiuiXM3U8;
  var U = window.MiuixUI;

  var host = null;
  var shadow = null;
  var nodes = {};
  var state = { candidates: [], title: '', selectedUrl: '', settings: null, tabId: -1, busy: false };

  var POS_KEY = 'overlayPos';   // 悬浮窗位置（拖过之后才有）
  var EDGE_MARGIN = 8;          // 吸附/夹边时离屏幕边的距离
  var SNAP_THRESHOLD = 24;      // 松手时离边缘多近算"靠边"（只吸附左右）
  var dragState = null;
  var suppressClick = false;

  // ---------------------------------------------------------------- 拖动
  /** 视口内留 8px 边距，避免拖出屏幕再也点不到（算法在纯逻辑层，可单测）。 */
  function clampPos(left, top) {
    var rect = nodes.root.getBoundingClientRect();
    return L.clampOverlayPos(left, top, rect.width || 56, rect.height || 56,
                             window.innerWidth, window.innerHeight, 8);
  }

  /** pos 为空表示回到 CSS 默认的右下角。 */
  function setPos(pos, persist) {
    if (!nodes.root) return;
    if (!pos) {
      nodes.root.style.left = '';
      nodes.root.style.top = '';
      nodes.root.style.right = '';
      nodes.root.style.bottom = '';
      return;
    }
    var p = clampPos(pos.left, pos.top);
    // 默认定位用的是 right/bottom，一旦拖动就要切成 left/top，否则两个方向会打架
    nodes.root.style.right = 'auto';
    nodes.root.style.bottom = 'auto';
    nodes.root.style.left = p.left + 'px';
    nodes.root.style.top = p.top + 'px';
    // 面板朝哪边展开，跟着球所在的半边走：球在右半边就右对齐（面板向左撑开），
    // 在左半边就左对齐。固定锚右边的话，球被拖到左侧时面板会被推出视口。
    applySide(p.left + (nodes.root.offsetWidth || 56) / 2);
    if (persist) {
      try { chrome.storage.local.set({ [POS_KEY]: p }); } catch (e) { /* 存不了就先算了 */ }
    }
  }

  function loadPos() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(POS_KEY, function (r) {
          resolve((r && r[POS_KEY]) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** 根据中心位置决定 flex 对齐方向（left 半边 -> flex-start）。 */
  function applySide(centerX) {
    if (!nodes.root) return;
    nodes.root.style.alignItems = centerX < window.innerWidth / 2 ? 'flex-start' : 'flex-end';
  }

  /** 手柄可拖动；内部按钮不参与拖动（否则点"收起"会变成拖窗）。 */
  function makeDraggable(handle, skipButtons) {
    handle.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      if (skipButtons && ev.target.closest && ev.target.closest('button')) return;
      var rect = nodes.root.getBoundingClientRect();
      dragState = { id: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, moved: false };
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* 老浏览器忽略 */ }
      nodes.root.classList.add('mx-dragging');
      // ⚠️ 这里**绝对不能** preventDefault：pointerdown 上调用它会连后续的 click
      //    一起掐掉，结果悬浮球只剩拖动、点不开了（踩过一次）。
      //    防触摸滚动改由 CSS 的 touch-action: none 负责。
    });

    handle.addEventListener('pointermove', function (ev) {
      if (!dragState || ev.pointerId !== dragState.id) return;
      dragState.moved = true;
      setPos({ left: ev.clientX - dragState.dx, top: ev.clientY - dragState.dy }, false);
      ev.preventDefault();
    });

    function finish(ev) {
      if (!dragState || ev.pointerId !== dragState.id) return;
      var moved = dragState.moved;
      dragState = null;
      nodes.root.classList.remove('mx-dragging');
      if (moved) {
        var rect = nodes.root.getBoundingClientRect();
        /* 松手时的左右边缘吸附：净空 ≤24px 就贴边（留 8px）。判定在纯逻辑层（snapToEdge，有单测）。
         * 吸附后仍走 setPos -> clampPos 收尾，所以不会被吸到视口外；持久化也由 setPos 负责。
         * 贴到左边后面板从左往右展开由 applySide 处理（它按控件中心点选对齐方向）。 */
        var snapped = L.snapToEdge(rect.left, rect.width || nodes.root.offsetWidth || 56,
                                   window.innerWidth, EDGE_MARGIN, SNAP_THRESHOLD);
        setPos({ left: snapped, top: rect.top }, true);     // 落位 + 记住
        suppressClick = true;                               // 拖完那一下不要当成点击
        setTimeout(function () { suppressClick = false; }, 0);
      }
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    // 捕获阶段拦掉"拖动结束后的 click"
    handle.addEventListener('click', function (ev) {
      if (suppressClick) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);
  }

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response || { ok: false, error: '扩展后台没有响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // ---------------------------------------------------------------- 挂载/卸载
  async function boot() {
    var res = await send({ type: 'get-settings' });
    var settings = (res && res.ok && res.settings) ? res.settings : {};
    state.settings = settings;
    applyMode(settings.uiMode || 'popup');   // mount() 里会把外观一起应用（那时 .mx-ov 才存在）
  }

  function applyMode(mode) {
    if (mode === 'overlay') mount();
    else unmount();
  }

  /** 外观：悬浮窗住在 Shadow DOM 里，强制类必须挂到 .mx-ov（:root 在 shadow 里不匹配）。 */
  function applyTheme(theme) {
    if (nodes.root) U.applyTheme(theme, nodes.root);
  }

  async function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    var css = await loadCss();
    var style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);

    var root = document.createElement('div');
    root.className = 'mx-ov';
    root.innerHTML = [
      '<button class="mx-fab" type="button" title="MiuiX M3U8 嗅探到的视频">',
      '  <svg class="mx-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"',
      '       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
      '    <path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
      '  </svg>',
      '  <span class="mx-fab-badge" hidden>0</span>',
      '</button>',
      '<section class="mx-card" hidden>',
      '  <header class="mx-card-head">',
      '    <span class="mx-brand">MiuiX M3U8</span>',
      '    <span class="mx-card-title"></span>',
      '    <button class="mx-icon-btn" type="button" data-act="refresh" title="重新扫描此页"></button>',
      '    <button class="mx-icon-btn" type="button" data-act="collapse" title="收起"></button>',
      '  </header>',
      '  <div class="mx-status" hidden></div>',
      '  <div class="mx-list" role="radiogroup" aria-label="候选视频流"></div>',
      '  <footer class="mx-card-foot">',
      '    <button class="mx-btn mx-btn-primary" type="button" data-act="send">发送到 MiuiX M3U8</button>',
      '    <button class="mx-btn" type="button" data-act="copy">复制命令</button>',
      '  </footer>',
      '</section>'
    ].join('');
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    nodes.root = root;
    U.applyTheme(state.settings && state.settings.theme, root);
    nodes.fab = shadow.querySelector('.mx-fab');
    nodes.badge = shadow.querySelector('.mx-fab-badge');
    nodes.card = shadow.querySelector('.mx-card');
    nodes.title = shadow.querySelector('.mx-card-title');
    nodes.status = shadow.querySelector('.mx-status');
    nodes.list = shadow.querySelector('.mx-list');
    nodes.refreshBtn = shadow.querySelector('[data-act="refresh"]');
    nodes.collapseBtn = shadow.querySelector('[data-act="collapse"]');

    nodes.refreshBtn.appendChild(U.icon('refresh', 18));
    nodes.collapseBtn.appendChild(U.icon('close', 18));

    nodes.fab.addEventListener('click', toggleCard);
    nodes.refreshBtn.addEventListener('click', function () { refresh(true); });
    nodes.collapseBtn.addEventListener('click', function () { setCardOpen(false); });
    nodes.card.querySelector('[data-act="send"]').addEventListener('click', onSend);
    nodes.card.querySelector('[data-act="copy"]').addEventListener('click', onCopy);

    // 悬浮球与卡片标题栏都能拖；标题栏里的按钮不参与拖动
    makeDraggable(nodes.fab);
    makeDraggable(nodes.card.querySelector('.mx-card-head'), true);
    loadPos().then(function (pos) { if (pos) setPos(pos, false); });
    window.addEventListener('resize', onViewportResize);

    await refresh(false);
  }

  function unmount() {
    window.removeEventListener('resize', onViewportResize);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    nodes = {};
    dragState = null;
  }

  /** 窗口尺寸变化后把悬浮窗夹回视口内（否则缩小窗口会把球顶出可视区）。 */
  function onViewportResize() {
    if (!nodes.root || !nodes.root.style.left) return;
    var rect = nodes.root.getBoundingClientRect();
    setPos({ left: rect.left, top: rect.top }, true);
  }

  function loadCss() {
    var files = ['common.css', 'content.css'];
    return Promise.all(files.map(function (name) {
      return fetch(chrome.runtime.getURL(name)).then(function (r) { return r.text(); })
        .catch(function () { return ''; });
    })).then(function (parts) { return parts.join('\n'); });
  }

  /**
   * 展开 / 收起面板。
   *
   * 面板宽 340px、收起后只剩 56px 的悬浮球，而 .mx-ov 是 align-items: flex-end 的
   * 竖向 flex 容器：**一旦拖动过**（定位由 right/bottom 换成了 left/top），宽度收缩时
   * 是"左边缘不动、右边缩走"，看上去就是球往左跑。
   * 所以切换前后按**右边缘**重新锚定一次。
   */
  function setCardOpen(open) {
    if (!nodes.card || nodes.card.hidden === !open) return;
    var before = nodes.root.getBoundingClientRect();
    nodes.card.hidden = !open;
    if (nodes.root.style.left) {        // 只有拖动过（left 定位）才需要重锚
      var after = nodes.root.getBoundingClientRect();
      // 右对齐时球贴在面板右边 -> 锚右边缘；左对齐时球贴在左边 -> 锚左边缘。
      // 一句话：**球停在原地，让面板从它那一侧撑开**。
      var anchorLeft = nodes.root.style.alignItems === 'flex-start';
      setPos({ left: anchorLeft ? before.left : before.right - after.width, top: after.top }, true);
    }
    if (open) refresh(false);
  }

  function toggleCard() {
    setCardOpen(nodes.card.hidden);
  }

  // ---------------------------------------------------------------- 数据
  async function refresh(showSpinner) {
    if (!host) return;
    if (showSpinner) U.setStatus(nodes.status, '重新扫描…', 'neutral');
    var res = await send({ type: 'get-candidates' });
    if (!res || !res.ok) {
      U.setStatus(nodes.status, (res && res.error) || '读取候选失败', 'error');
      return;
    }
    state.candidates = res.candidates || [];
    state.title = res.title || '';
    state.tabId = res.tabId;
    state.settings = res.settings || state.settings;
    state.selectedUrl = U.renderList(nodes.list, state.candidates, state.selectedUrl, onPick);
    nodes.title.textContent = state.title || '未命名页面';
    nodes.title.title = state.rawTitle || state.title || '';
    var count = state.candidates.length;
    nodes.badge.textContent = String(count);
    nodes.badge.hidden = count === 0;
    nodes.fab.classList.toggle('mx-fab-active', count > 0);
    U.setStatus(nodes.status, '', '');
  }

  function onPick(candidate) {
    state.selectedUrl = candidate.url;
    U.renderList(nodes.list, state.candidates, state.selectedUrl, onPick);
  }

  function selected() {
    return U.findByUrl(state.candidates, state.selectedUrl) || state.candidates[0] || null;
  }

  // ---------------------------------------------------------------- 动作
  async function onSend() {
    if (state.busy) return;
    var candidate = selected();
    if (!candidate) {
      U.setStatus(nodes.status, '还没有可发送的候选', 'warning');
      return;
    }
    state.busy = true;
    U.setStatus(nodes.status, '正在发送…', 'neutral');
    var res = await send({ type: 'send', tabId: state.tabId, url: candidate.url, title: state.title });
    state.busy = false;
    if (res && res.ok) {
      U.setStatus(nodes.status, '已交给 MiuiX M3U8 建任务' + (res.taskId ? '：' + res.taskId : ''), 'success');
      setTimeout(function () { setCardOpen(false); }, 1200);
    } else {
      U.setStatus(nodes.status, (res && res.error) || '发送失败', 'error');
    }
  }

  async function onCopy() {
    var candidate = selected();
    if (!candidate) {
      U.setStatus(nodes.status, '还没有可复制的候选', 'warning');
      return;
    }
    var settings = state.settings || {};
    var command = L.buildCommand({
      url: candidate.url,
      title: state.title,
      headers: candidate.headers
    }, { exe: 'N_m3u8DL-RE', autoSelect: settings.autoSelect !== false });
    var ok = await U.copyText(command);
    U.setStatus(nodes.status, ok ? '命令已复制到剪贴板' : '复制失败，请在扩展面板里复制', ok ? 'success' : 'error');
  }

  // ---------------------------------------------------------------- 消息

  /** 后台要的页面信息：document.cookie 是「webRequest 拿不到 Cookie 时」的兜底
   *  （Chrome 对 Cookie 这类敏感请求头默认不给扩展看），og:title 是标题的次选来源。 */
  function pageInfo() {
    var title = document.title || '';
    var og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) title = og.content;
    return { url: location.href, title: title, cookie: document.cookie || '' };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) return;
    if (message.type === 'page-info') {
      sendResponse(pageInfo());       // 同步回复
      return;
    }
    if (message.type === 'candidates-changed') {
      if (host && !nodes.card.hidden) refresh(false);
      else if (host) {
        var count = Number(message.count) || 0;
        nodes.badge.textContent = String(count);
        nodes.badge.hidden = count === 0;
        nodes.fab.classList.toggle('mx-fab-active', count > 0);
      }
    } else if (message.type === 'settings-changed') {
      state.settings = Object.assign({}, state.settings, {
        uiMode: message.uiMode,
        theme: message.theme
      });
      applyMode(message.uiMode);      // 切到悬浮窗时 mount() 会自己应用外观
      applyTheme(message.theme);      // 已经在挂载状态时立刻换色
    }
  });

  boot();
})();
