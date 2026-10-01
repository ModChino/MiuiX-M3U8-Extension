/* MiuiX M3U8 浏览器扩展 —— 设置页逻辑
 * 读：走后台的 get-settings（默认值只维护一份，在 background.js）
 * 写：直接写 chrome.storage.local，后台的 storage.onChanged 会通知各标签页切换界面形式
 */
(function () {
  'use strict';

  var L = window.MiuiXM3U8;
  var U = window.MiuixUI;

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

  function setStatus(text, tone) {
    U.setStatus(nodes.status, text, tone);
  }

  async function load() {
    var res = await send({ type: 'get-settings' });
    var settings = (res && res.ok && res.settings) ||
      { serverPort: 0, serverToken: '', uiMode: 'popup', theme: 'system', autoSelect: true, enrich: true, threadCount: 0 };
    nodes.port.value = settings.serverPort ? String(settings.serverPort) : '';
    nodes.token.value = settings.serverToken || '';
    for (var radio of nodes.modeRadios) {
      radio.checked = (radio.value === settings.uiMode);
    }
    var theme = L.normalizeTheme(settings.theme);
    for (var themeRadio of nodes.themeRadios) {
      themeRadio.checked = (themeRadio.value === theme);
    }
    U.applyTheme(theme);
    var threadCount = L.normalizeThreadCount(settings.threadCount);
    for (var threadRadio of nodes.threadRadios) {
      threadRadio.checked = (L.normalizeThreadCount(threadRadio.value) === threadCount);
    }
    nodes.autoSelect.checked = settings.autoSelect !== false;
    nodes.enrich.checked = settings.enrich !== false;
  }

  function readForm() {
    var rawPort = nodes.port.value.trim();
    var port = rawPort ? L.normalizePort(rawPort) : 0;
    if (rawPort && !port) return { error: '端口必须是 10000-65535 之间的五位数' };
    var uiMode = 'popup';
    for (var radio of nodes.modeRadios) if (radio.checked) uiMode = radio.value;
    var theme = 'system';
    for (var themeRadio of nodes.themeRadios) if (themeRadio.checked) theme = themeRadio.value;
    var threadCount = 0;
    for (var threadRadio of nodes.threadRadios) {
      if (threadRadio.checked) threadCount = L.normalizeThreadCount(threadRadio.value);
    }
    return {
      settings: {
        serverPort: port,
        serverToken: nodes.token.value.trim(),
        uiMode: uiMode,
        theme: L.normalizeTheme(theme),
        autoSelect: nodes.autoSelect.checked,
        enrich: nodes.enrich.checked,
        threadCount: threadCount
      }
    };
  }

  async function save() {
    var result = readForm();
    if (result.error) {
      setStatus(result.error, 'error');
      return;
    }
    await chrome.storage.local.set({ settings: result.settings });
    U.applyTheme(result.settings.theme);   // 设置页自己也立刻换色（storage 事件不会回到本页）
    setStatus('已保存', 'success');
  }

  async function testConnection() {
    var result = readForm();
    if (result.error) {
      setStatus(result.error, 'error');
      return;
    }
    await chrome.storage.local.set({ settings: result.settings });   // 先保存，ping 用的是后台的配置
    setStatus('正在测试…', 'neutral');
    nodes.dot.className = 'mx-dot';
    var res = await send({ type: 'ping' });
    if (res && res.ok) {
      nodes.dot.className = 'mx-dot mx-dot-ok';
      nodes.connText.textContent = '已连接 ' + (res.app || 'MiuiX M3U8') + ' · 端口 ' + res.port;
      setStatus('连接正常', 'success');
    } else {
      nodes.dot.className = 'mx-dot mx-dot-bad';
      nodes.connText.textContent = (res && res.error) || '连接失败';
      setStatus((res && res.error) || '连接失败', 'error');
    }
  }

  function init() {
    nodes.port = $('port');
    nodes.token = $('token');
    nodes.status = $('status');
    nodes.autoSelect = $('auto-select');
    nodes.enrich = $('enrich');
    nodes.dot = $('conn-dot');
    nodes.connText = $('conn-text');
    nodes.modeRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="uiMode"]'));
    nodes.themeRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="theme"]'));
    nodes.threadRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="threadCount"]'));

    $('version').textContent = chrome.runtime.getManifest().version;

    nodes.port.addEventListener('change', save);
    nodes.token.addEventListener('change', save);
    nodes.autoSelect.addEventListener('change', save);
    nodes.enrich.addEventListener('change', save);
    for (var radio of nodes.modeRadios) radio.addEventListener('change', save);
    for (var themeRadio of nodes.themeRadios) themeRadio.addEventListener('change', save);
    for (var threadRadio of nodes.threadRadios) threadRadio.addEventListener('change', save);
    $('test').addEventListener('click', testConnection);

    load();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
