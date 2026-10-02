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
  var CARD_GAP = 12;            // 面板与球之间的空隙（与 content.css 里 .mx-ov 的 gap 一致）
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
    // 展开方向**不在这里决定**：它依赖面板的真实尺寸，只有面板显示着才量得到，
    // 所以统一由 applyPlacement() 在展开的那一刻算（见 setCardOpen）。
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

  /** 按球的位置、面板尺寸、视口剩余空间，决定面板往上下左右哪边展开。
   *  判定在纯逻辑层（planOverlayPlacement，有单测）；这里只把它落到 flex 上：
   *    x='right' -> align-items: flex-start   （面板左边缘贴球左边缘，朝右铺）
   *    x='left'  -> align-items: flex-end     （面板右边缘贴球右边缘，朝左铺）
   *    y='down'  -> flex-direction: column        （球在上、面板在下）
   *    y='up'    -> flex-direction: column-reverse（面板在上、球在下）
   *  **必须在面板已经可见时调用** —— hidden 时量到的是 0，判断会退化成默认方向。 */
  function applyPlacement() {
    if (!nodes.root || !nodes.card || nodes.card.hidden) return;
    var fab = nodes.fab.getBoundingClientRect();
    var card = nodes.card.getBoundingClientRect();
    var plan = L.planOverlayPlacement(fab, card,
      { width: window.innerWidth, height: window.innerHeight }, CARD_GAP, EDGE_MARGIN);
    nodes.root.style.alignItems = plan.x === 'right' ? 'flex-start' : 'flex-end';
    nodes.root.style.flexDirection = plan.y === 'down' ? 'column' : 'column-reverse';
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
         * 贴到左边后面板该往哪边展开，不在这里管 —— 由展开那一刻的 applyPlacement
         * 按球的位置和视口剩余空间现算（见 planOverlayPlacement）。 */
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
   * 展开方向是**自适应**的（applyPlacement）：球贴着屏幕下边就往上开、贴着右边就往左开，
   * 不再写死"面板永远在球下方"——那样球拖到屏幕底部时，面板会被顶出视口。
   *
   * 方向一变，球在这个 flex 容器里的位置就整体挪一格（column 时球在上、column-reverse 时球在下），
   * 而容器是按 left/top（或 CSS 的 right/bottom）锚定的，球就会跳。
   * 所以切换前后量一次**球自身**的位置差并回补，保证**球原地不动**，只有面板从它旁边长出来。
   * （原实现只按右边缘重锚，只覆盖了横向；纵向一翻转球就会跳。）
   */
  function setCardOpen(open) {
    if (!nodes.card || nodes.card.hidden === !open) return;
    var fabBefore = nodes.fab.getBoundingClientRect();
    nodes.card.hidden = !open;
    if (open) applyPlacement();      // 必须在卡片可见之后：这时才量得到面板真实宽高
    var fabAfter = nodes.fab.getBoundingClientRect();
    var rect = nodes.root.getBoundingClientRect();
    setPos({
      left: rect.left + (fabBefore.left - fabAfter.left),
      top: rect.top + (fabBefore.top - fabAfter.top)
    }, true);
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
