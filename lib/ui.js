/* MiuiX M3U8 浏览器扩展 —— popup 与页面悬浮窗共用的 DOM 片段。
 * 依赖 lib/logic.js（先加载）。这里只做「渲染」，不做任何 chrome API 调用。 */
(function (root) {
  'use strict';

  var L = root.MiuiXM3U8;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* 线性图标（stroke + currentColor），不引外部资源 */
  var ICONS = {
    send: '<path d="M4 11.5 20 4l-7.5 16-2-6.5z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V8h-4.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>'
  };

  function icon(name, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mx-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 20));
    svg.setAttribute('height', String(size || 20));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  /** 画质/带宽小标签 */
  function qualityChip(candidate) {
    var quality = (candidate && candidate.quality) || {};
    var label = L.qualityLabel(quality);
    var chip = el('span', 'mx-chip', label);
    if (label === '未知') chip.classList.add('mx-chip-muted');
    else chip.classList.add('mx-chip-primary');
    return chip;
  }

  function metaLine(candidate) {
    var quality = (candidate && candidate.quality) || {};
    var bits = [];
    var ago = L.formatTimeAgo(candidate && candidate.time);
    if (ago) bits.push(ago);
    var bps = L.formatBandwidth(quality.bandwidth);
    if (bps && !quality.height) bits.push(bps);
    if (candidate && candidate.hits > 1) bits.push('命中 ' + candidate.hits + ' 次');
    if (candidate && candidate.fromBody) bits.push('已读清单');
    return bits.join(' · ');
  }

  /** 一行候选（button + role=radio，键盘也能选） */
  function candidateRow(candidate, options) {
    var opts = options || {};
    var row = el('button', 'mx-cand');
    row.type = 'button';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', opts.selected ? 'true' : 'false');
    row.title = candidate.url;

    var main = el('div', 'mx-cand-main');
    var head = el('div', 'mx-cand-head');
    head.appendChild(qualityChip(candidate));
    head.appendChild(el('span', 'mx-cand-host', L.hostOf(candidate.url) || '未知来源'));
    var kind = candidate.kind || L.streamKind(candidate.url, candidate.contentType);
    if (kind) head.appendChild(el('span', 'mx-cand-kind', kind));
    main.appendChild(head);
    main.appendChild(el('div', 'mx-cand-path', L.shortPath(candidate.url)));
    var meta = metaLine(candidate);
    if (meta) main.appendChild(el('div', 'mx-cand-meta', meta));

    row.appendChild(main);
    row.appendChild(el('span', 'mx-cand-check'));
    if (opts.onPick) {
      row.addEventListener('click', function () { opts.onPick(candidate); });
    }
    return row;
  }

  function emptyState(text) {
    var box = el('div', 'mx-empty');
    box.appendChild(icon('download', 28));
    box.appendChild(el('div', 'mx-empty-text', text));
    return box;
  }

  /** 渲染候选列表。selectedUrl 为空时默认选第一条（排序保证了第一条就是最高画质）。 */
  function renderList(container, candidates, selectedUrl, onPick) {
    container.textContent = '';
    if (!candidates || !candidates.length) {
      container.appendChild(emptyState('还没嗅探到 m3u8 / mpd。先让页面把视频播起来。'));
      return '';
    }
    var chosen = selectedUrl || candidates[0].url;
    for (var i = 0; i < candidates.length; i++) {
      container.appendChild(candidateRow(candidates[i], {
        selected: candidates[i].url === chosen,
        onPick: onPick
      }));
    }
    return chosen;
  }

  /** 把「跟随系统 / 浅色 / 深色」落到根元素上（system = 两个类都不加，交给 prefers-color-scheme）。
   *  target 默认 <html>（popup / options 页）；**悬浮窗必须传自己的 .mx-ov 元素** ——
   *  Shadow DOM 里 :root 不匹配，类挂到页面 <html> 上悬浮窗不会跟着变。 */
  function applyTheme(theme, target) {
    var element = target || document.documentElement;
    var className = L.themeClass(theme);
    element.classList.toggle('mx-force-light', className === 'mx-force-light');
    element.classList.toggle('mx-force-dark', className === 'mx-force-dark');
  }

  function setStatus(node, text, tone) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'mx-status' + (tone ? ' mx-status-' + tone : '');
    node.hidden = !text;
  }

  function findByUrl(candidates, url) {
    for (var i = 0; i < (candidates || []).length; i++) {
      if (candidates[i].url === url) return candidates[i];
    }
    return null;
  }

  /* 复制到剪贴板：优先 async clipboard（内容脚本里需要用户手势 + 安全上下文），
   * 失败退回 textarea + execCommand（老办法，页面里一定能用）。 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  }

  root.MiuixUI = {
    el: el,
    icon: icon,
    qualityChip: qualityChip,
    candidateRow: candidateRow,
    renderList: renderList,
    emptyState: emptyState,
    applyTheme: applyTheme,
    setStatus: setStatus,
    findByUrl: findByUrl,
    copyText: copyText
  };
})(typeof window !== 'undefined' ? window : this);
