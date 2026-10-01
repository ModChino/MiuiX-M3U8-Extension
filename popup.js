/* MiuiX M3U8 浏览器扩展 —— 弹出面板逻辑 */
(function () {
  'use strict';

  var L = window.MiuiXM3U8;
  var U = window.MiuixUI;

  var state = { candidates: [], title: '', rawTitle: '', selectedUrl: '', tabId: -1, settings: null, busy: false };
  var nodes = {};

  function $(id) { return document.getElementById(id); }

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: '扩展后台没有响应' });
      });
    });
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0]) || null;
  }

  function pageTitle() {
    var tab = state.tab;
    return (tab && tab.title) || '';
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    state.selectedUrl = U.renderList(nodes.list, state.candidates, state.selectedUrl, onPick);
    var hasAny = state.candidates.length > 0;
    nodes.send.disabled = !hasAny;
    nodes.copy.disabled = !hasAny;
    nodes.title.textContent = state.title || pageTitle() || '未命名页面';
    nodes.title.title = state.rawTitle || pageTitle() || '';
  }

  function onPick(candidate) {
    state.selectedUrl = candidate.url;
    U.renderList(nodes.list, state.candidates, state.selectedUrl, onPick);
  }

  function selected() {
    return U.findByUrl(state.candidates, state.selectedUrl) || state.candidates[0] || null;
  }

  // ---------------------------------------------------------------- 数据
  async function refresh(showSpinner) {
    if (showSpinner) U.setStatus(nodes.status, '重新扫描…', 'neutral');
    var tab = state.tab || await activeTab();
    state.tab = tab;
    if (!tab || !tab.id) {
      U.setStatus(nodes.status, '读不到当前标签页', 'error');
      return;
    }
    var url = tab.url || '';
    if (url && !/^https?:/i.test(url)) {
      state.tabId = tab.id;
      state.candidates = [];
      render();
      U.setStatus(nodes.status, '当前页面不是普通网页（' + url.split(':')[0] + ':），扩展读不到它的网络请求。', 'warning');
      return;
    }
    var res = await send({ type: 'get-candidates', tabId: tab.id });
    if (!res || !res.ok) {
      U.setStatus(nodes.status, (res && res.error) || '读取候选失败', 'error');
      return;
    }
    state.tabId = res.tabId;
    state.title = res.title || '';
    state.rawTitle = res.rawTitle || res.title || '';
    state.settings = res.settings || state.settings;
    if (state.settings) U.applyTheme(state.settings.theme);
    state.candidates = res.candidates || [];
    state.selectedUrl = res.defaultUrl || '';
    render();
    U.setStatus(nodes.status, '', '');
  }

  async function checkConnection() {
    var res = await send({ type: 'ping' });
    if (res && res.ok) {
      nodes.dot.className = 'mx-dot mx-dot-ok';
      nodes.connText.textContent = '已连接 ' + (res.app || 'MiuiX M3U8') + ' · 端口 ' + res.port;
    } else {
      nodes.dot.className = 'mx-dot mx-dot-bad';
      nodes.connText.textContent = (res && res.error) || '未连接本地接收端';
    }
  }

  // ---------------------------------------------------------------- 动作
  async function onSend() {
    if (state.busy) return;
    var candidate = selected();
    if (!candidate) return;
    state.busy = true;
    nodes.send.disabled = true;
    U.setStatus(nodes.status, '正在发送…', 'neutral');
    var res = await send({ type: 'send', tabId: state.tabId, url: candidate.url, title: state.title });
    state.busy = false;
    nodes.send.disabled = false;
    if (res && res.ok) {
      U.setStatus(nodes.status, '已交给 MiuiX M3U8 建任务' + (res.taskId ? '：' + res.taskId : ''), 'success');
    } else {
      U.setStatus(nodes.status, (res && res.error) || '发送失败', 'error');
    }
  }

  async function onCopy() {
    var candidate = selected();
    if (!candidate) return;
    var settings = state.settings || {};
    var command = L.buildCommand({
      url: candidate.url,
      title: state.title,
      headers: candidate.headers
    }, { exe: 'N_m3u8DL-RE', autoSelect: settings.autoSelect !== false });
    var ok = await U.copyText(command);
    U.setStatus(nodes.status, ok ? '命令已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
  }

  async function onClear() {
    await send({ type: 'clear', tabId: state.tabId });
    state.selectedUrl = '';
    await refresh(false);
    U.setStatus(nodes.status, '已清空此页候选', 'neutral');
  }

  // ---------------------------------------------------------------- 启动
  async function init() {
    nodes.list = $('list');
    nodes.title = $('page-title');
    nodes.status = $('status');
    nodes.send = $('send');
    nodes.copy = $('copy');
    nodes.dot = $('conn-dot');
    nodes.connText = $('conn-text');

    $('refresh').appendChild(U.icon('refresh', 18));
    $('clear').appendChild(U.icon('close', 18));

    $('refresh').addEventListener('click', function () { refresh(true); });
    $('clear').addEventListener('click', onClear);
    $('send').addEventListener('click', onSend);
    $('copy').addEventListener('click', onCopy);
    $('options').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });

    await refresh(false);
    await checkConnection();
    if (!state.candidates.length && !nodes.status.textContent) {
      U.setStatus(nodes.status, '让页面把视频播起来，扩展会自动嗅探 m3u8 / mpd。', 'neutral');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
