/* MiuiX M3U8 浏览器扩展 —— 纯逻辑层（**不许出现任何 chrome API**）。
 *
 * 为什么单独一个文件：background.js / popup.js / content.js 都要用这些函数，
 * 而 test/logic.test.js 必须在 node 里直接跑（不依赖 chrome.*），所以逻辑必须与
 * 平台代码分离。加载方式用 UMD 包装：
 *   - Service Worker：importScripts('lib/logic.js') -> self.MiuiXM3U8
 *   - 普通页面/内容脚本：<script src="lib/logic.js"> -> window.MiuiXM3U8
 *   - node：require('../lib/logic.js')
 * 没有构建步骤，改完即生效。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiuiXM3U8 = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ================================================================ 常量

  /* 已知清晰度档位（像素高度）。URL 里只有出现这些数字才算清晰度线索 ——
   * 不加白名单的话 /2024/、/seg-1234/ 这类数字全会被当成画质。 */
  var KNOWN_HEIGHTS = [4320, 2880, 2160, 1440, 1080, 900, 720, 576, 540, 480, 360, 288, 240, 144];
  var HEIGHT_SET = {};
  for (var i = 0; i < KNOWN_HEIGHTS.length; i++) HEIGHT_SET[KNOWN_HEIGHTS[i]] = true;

  /* 这些 Content-Type 视为流媒体清单（HLS/DASH）。其余（video/mp4、video/mp2t 等）不算，
   * 否则每个分片都会被当成候选。 */
  var STREAM_TYPES = {
    'application/vnd.apple.mpegurl': true,
    'application/x-mpegurl': true,
    'application/mpegurl': true,
    'audio/mpegurl': true,
    'audio/x-mpegurl': true,
    'application/dash+xml': true,
    'video/vnd.mpeg.dash.mpd': true
  };

  /* 不该转发给下载器的传输层请求头。白送一堆 Accept-Encoding/Range 过去反而会把下载搞坏
   * （app/main.py 会把它们全部变成 -H 传给 N_m3u8DL-RE）。x-* / authorization 之类保留。 */
  var HEADER_NOISE = {
    'accept': true, 'accept-charset': true, 'accept-encoding': true, 'accept-language': true,
    'access-control-request-headers': true, 'access-control-request-method': true,
    'cache-control': true, 'connection': true, 'content-length': true, 'content-type': true,
    'dnt': true, 'expect': true, 'host': true, 'if-modified-since': true, 'if-none-match': true,
    'if-range': true, 'if-unmodified-since': true, 'origin': true, 'pragma': true,
    'priority': true, 'proxy-connection': true, 'range': true, 'te': true, 'trailer': true,
    'transfer-encoding': true, 'upgrade-insecure-requests': true, 'via': true, 'x-forwarded-for': true
  };

  /* 文件名非法字符，与 app/main.py 的 _BAD_NAME_CHARS 保持一致
   * （服务端还会再清一遍；两边规则一致，才不会出现「扩展里看到的」和「服务端存的」不一样） */
  var BAD_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]+/g;
  /* 站点名 / 观看提示词尾（标题清洗用） */
  var SITE_WORDS = '哔哩哔哩|bilibili|b站|腾讯视频|爱奇艺|iqiyi|优酷|youku|芒果tv|mgtv|youtube|acfun|西瓜视频|ixigua|抖音|douyin|微博|weibo|搜狐视频|sohu|乐视|pptv|咪咕视频|miguvideo|netflix|niconico|twitch|vimeo|dailymotion|在线观看|免费观看|高清完整版|完整版|在线播放|高清在线|高清视频|未删减版';
  /* 多级域名也要认：v.qq.com / m.iqiyi.com 这种（单段 [\\w-]+ 只能匹配 a.com） */
  var DOMAIN_TAIL = '(?:[\\w-]+\\.)+(?:com|cn|net|tv|cc|me|org|io|xyz|top|site|vip|app)(?:\\.(?:cn|com))?';
  var SITE_TAIL = new RegExp('[\\s\\-_|｜·,，]+(?:' + SITE_WORDS + '|' + DOMAIN_TAIL + ')\\s*$', 'i');
  var MAX_TITLE = 120;   // 与 app/main.py 的 _MAX_NAME 一致

  // ================================================================ URL / 类型

  function isHlsUrl(url) {
    return typeof url === 'string' && /\.m3u8?(?:[?#]|$)/i.test(url);
  }

  function isDashUrl(url) {
    return typeof url === 'string' && /\.mpd(?:[?#]|$)/i.test(url);
  }

  function isMediaUrl(url) {
    return isHlsUrl(url) || isDashUrl(url);
  }

  function normalizeContentType(ct) {
    if (!ct) return '';
    return String(ct).split(';')[0].trim().toLowerCase();
  }

  function isStreamContentType(ct) {
    var base = normalizeContentType(ct);
    if (!base) return false;
    return STREAM_TYPES[base] === true || base.indexOf('mpegurl') >= 0;
  }

  function streamKind(url, contentType) {
    if (isDashUrl(url)) return 'DASH';
    if (isHlsUrl(url)) return 'HLS';
    var base = normalizeContentType(contentType);
    if (base === 'application/dash+xml' || base === 'video/vnd.mpeg.dash.mpd') return 'DASH';
    if (base && base.indexOf('mpegurl') >= 0) return 'HLS';
    return '';
  }

  // ================================================================ 清晰度

  function heightLabel(h) {
    h = Number(h) || 0;
    if (h >= 4320) return '8K';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    return h + 'p';
  }

  function formatBandwidth(bps) {
    var n = Number(bps) || 0;
    if (n <= 0) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' Mbps';
    return Math.round(n / 1e3) + ' Kbps';
  }

  function qualityLabel(quality) {
    var q = quality || {};
    if (q.height) return heightLabel(q.height);
    if (q.bandwidth) return formatBandwidth(q.bandwidth);
    return '未知';
  }

  function heightFromUrl(url) {
    if (typeof url !== 'string' || !url) return 0;
    var found = [];
    var m;
    // 4k / 8k / 2k / 1k 简称（后面不能再跟字母，避免 4kbps 之类误判）
    var reK = /(?:^|[^\da-z])(\d{1,2})\s*k(?![\da-z])/gi;
    while ((m = reK.exec(url))) {
      var byK = { 8: 4320, 4: 2160, 2: 1440, 1: 1080 }[parseInt(m[1], 10)];
      if (byK) found.push(byK);
    }
    // 1080p / 720P
    var reP = /(?:^|[^\da-z])(\d{3,4})\s*p(?![\da-z])/gi;
    while ((m = reP.exec(url))) {
      if (HEIGHT_SET[parseInt(m[1], 10)]) found.push(parseInt(m[1], 10));
    }
    // 1920x1080 / 1920×1080 -> 取高度
    var reX = /(?:^|[^\d])(\d{3,4})\s*[x×]\s*(\d{3,4})(?!\d)/gi;
    while ((m = reX.exec(url))) {
      if (HEIGHT_SET[parseInt(m[2], 10)]) found.push(parseInt(m[2], 10));
    }
    // 裸数字：/1080/index.m3u8、_720_、?hd=1080（用白名单挡住年份 / 随机串）
    var reN = /(?<![\da-z])(\d{3,4})(?!\d)/g;
    while ((m = reN.exec(url))) {
      if (HEIGHT_SET[parseInt(m[1], 10)]) found.push(parseInt(m[1], 10));
    }
    return found.length ? Math.max.apply(null, found) : 0;
  }

  function bandwidthFromUrl(url) {
    if (typeof url !== 'string' || !url) return 0;
    var best = 0;
    var m;
    var reQ = /(?:bandwidth|br|bw)=(\d{3,})/gi;
    while ((m = reQ.exec(url))) best = Math.max(best, parseInt(m[1], 10));
    var reS = /(\d+(?:\.\d+)?)\s*([km])bps/gi;
    while ((m = reS.exec(url))) {
      var v = parseFloat(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : 1e3);
      best = Math.max(best, Math.round(v));
    }
    return best;
  }

  /** 解析 HLS 主播放列表里的 #EXT-X-STREAM-INF（取最高档）。媒体列表没有这些行 -> 全 0。 */
  function parseHlsMaster(text) {
    var out = { height: 0, bandwidth: 0 };
    if (typeof text !== 'string' || text.indexOf('#EXTM3U') < 0) return out;
    var re = /#EXT-X-STREAM-INF:([^\r\n]*)/gi;
    var m;
    while ((m = re.exec(text))) {
      var line = m[1];
      var res = /RESOLUTION=(\d{2,5})x(\d{2,5})/i.exec(line);
      if (res) {
        var h = parseInt(res[2], 10);
        if (h >= 100 && h <= 5000 && h > out.height) out.height = h;
      }
      var bw = /BANDWIDTH=(\d+)/i.exec(line);
      if (bw) {
        var b = parseInt(bw[1], 10);
        if (b > out.bandwidth) out.bandwidth = b;
      }
    }
    return out;
  }

  /** 解析 DASH MPD 里 <Representation> 的 height / bandwidth（取最高档）。 */
  function parseMpdRepresentations(text) {
    var out = { height: 0, bandwidth: 0 };
    if (typeof text !== 'string' || !/<MPD[\s>]/i.test(text)) return out;
    var m;
    var reH = /height="(\d{3,4})"/gi;
    while ((m = reH.exec(text))) {
      var h = parseInt(m[1], 10);
      if (h >= 100 && h <= 5000 && h > out.height) out.height = h;
    }
    var reB = /bandwidth="(\d+)"/gi;
    while ((m = reB.exec(text))) {
      var b = parseInt(m[1], 10);
      if (b > out.bandwidth) out.bandwidth = b;
    }
    return out;
  }

  /** 嗅探清单正文属于哪种协议，返回 {height, bandwidth}；不是清单返回 null。 */
  function parsePlaylist(text) {
    if (typeof text !== 'string' || !text) return null;
    if (text.indexOf('#EXTM3U') >= 0) return parseHlsMaster(text);
    if (/<MPD[\s>]/i.test(text)) return parseMpdRepresentations(text);
    return null;
  }

  /** 清晰度推断：响应体（更准）优先，URL（兜底）其次。bodyText 为空时纯靠 URL 推断。 */
  function parseQuality(url, bodyText) {
    var fromBody = parsePlaylist(bodyText) || { height: 0, bandwidth: 0 };
    var height = fromBody.height || heightFromUrl(url);
    var bandwidth = fromBody.bandwidth || bandwidthFromUrl(url);
    return { height: height, bandwidth: bandwidth, label: qualityLabel({ height: height, bandwidth: bandwidth }) };
  }

  // ================================================================ 候选管理

  /** 去重：同一 URL 只留一条。
   *  - 时间取**首次**捕获（列表先后顺序稳定）
   *  - 请求头 / Content-Type 取**最后一次**（Cookie 用最新的才对）
   *  - 清晰度取信息更全的那条
   *  - hits 记录这个 URL 被请求了几次 */
  function dedupeCandidates(list) {
    var byUrl = new Map();
    var items = list || [];
    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!raw || !raw.url) continue;
      var prev = byUrl.get(raw.url);
      if (!prev) {
        var copy = {};
        for (var k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) copy[k] = raw[k];
        copy.hits = copy.hits || 1;
        if (!copy.time) copy.time = 0;
        byUrl.set(raw.url, copy);
        continue;
      }
      prev.hits = (prev.hits || 1) + 1;
      if (raw.headers) prev.headers = raw.headers;
      if (raw.contentType) prev.contentType = raw.contentType;
      if (raw.kind) prev.kind = raw.kind;
      var a = prev.quality || {};
      var b = raw.quality || {};
      if ((b.height || 0) > (a.height || 0) ||
          ((b.height || 0) === (a.height || 0) && (b.bandwidth || 0) > (a.bandwidth || 0))) {
        prev.quality = raw.quality;
      }
    }
    return Array.from(byUrl.values());
  }

  /** 排序规则刻意设计成「默认选项永远排在第一条」：
   *  清晰度高 -> 带宽大 -> 最后捕获。于是
   *  「默认预选最高画质；推断不出时选最后捕获的（主播放列表通常在后面）」
   *  就等于永远取 sortCandidates(list)[0]。 */
  function sortCandidates(list) {
    return (list || []).slice().sort(function (a, b) {
      var qa = (a && a.quality) || {};
      var qb = (b && b.quality) || {};
      return ((qb.height || 0) - (qa.height || 0)) ||
             ((qb.bandwidth || 0) - (qa.bandwidth || 0)) ||
             (((b && b.time) || 0) - ((a && a.time) || 0));
    });
  }

  function pickDefaultIndex(sorted) {
    return (sorted && sorted.length) ? 0 : -1;
  }

  function pickDefault(list) {
    var sorted = sortCandidates(list);
    return sorted.length ? sorted[0] : null;
  }

  /** 去重 + 排序，UI 直接用这个结果。 */
  function normalizeCandidates(list) {
    return sortCandidates(dedupeCandidates(list));
  }

  // ================================================================ 请求头

  /** webRequest 给的 requestHeaders -> {referer, cookie, userAgent, extra}。
   *  长度上限与 app/core/server.py 一致（referer 1000 / cookie 8000 / ua 500 / 其他 800）。 */
  function filterHeaders(rawHeaders) {
    var out = { referer: '', cookie: '', userAgent: '', extra: {} };
    var extraCount = 0;
    var list = rawHeaders || [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || !h.name) continue;
      var name = String(h.name);
      var lower = name.toLowerCase();
      var value = String(h.value == null ? '' : h.value).replace(/[\r\n]+/g, ' ').trim();
      if (!value) continue;
      if (lower === 'referer' || lower === 'referrer') { out.referer = value.slice(0, 1000); continue; }
      if (lower === 'cookie') { out.cookie = value.slice(0, 8000); continue; }
      if (lower === 'user-agent') { out.userAgent = value.slice(0, 500); continue; }
      if (HEADER_NOISE[lower] || lower.indexOf('sec-') === 0 || lower.charAt(0) === ':') continue;
      if (extraCount >= 20) continue;
      extraCount++;
      out.extra[name] = value.slice(0, 800);
    }
    return out;
  }

  // ================================================================ 标题清洗

  /** 网页标题 -> 安全文件名。
   *  1) 去控制字符  2) 反复剥尾部的站点名 / 域名 /「在线观看」这类词
   *  3) 非法文件名字符换 _（与 app/main.py 一致）  4) 截断到 120 字 */
  function cleanTitle(raw, opts) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (var n = 0; n < 5; n++) {
      var next = s.replace(SITE_TAIL, '').replace(/[\s\-_|｜·,，]+$/, '').replace(/\s+$/, '');
      if (next === s) break;
      s = next;
    }
    s = s.replace(BAD_CHARS, '_');
    s = s.replace(/\s+/g, ' ').replace(/^[\s._-]+/, '').replace(/[\s._-]+$/, '');
    var max = (opts && opts.max) || MAX_TITLE;
    return s.slice(0, max);
  }

  // ================================================================ 命令行

  /** Windows 命令行参数加引号。规则遵循 CommandLineToArgvW / .NET 的解析：
   *  引号内的 \" 表示一个字面引号；紧随结束引号的反斜杠要加倍，否则会把引号吃掉。
   *  （N_m3u8DL-RE 是 .NET 程序，按这套规则解析。） */
  function winQuote(value) {
    var s = String(value == null ? '' : value);
    s = s.replace(/(\\*)"/g, '$1$1\\"');
    s = s.replace(/(\\+)$/, '$1$1');
    return '"' + s + '"';
  }

  /** 拼一条可直接粘进 cmd 的 N_m3u8DL-RE 命令（不经 GUI，参考「猫抓」的做法）。
   *  opts: {exe, autoSelect}。
   *  ponytail: 不做 cmd 的 %VAR% 转义 —— 交互式 cmd 里只有匹配到变量名才会展开，
   *  标题里带 % 的极端情况会变形；真要覆盖就得自己解析 % 配对，暂不值得。 */
  function buildCommand(candidate, opts) {
    var c = candidate || {};
    var o = opts || {};
    var exe = o.exe || 'N_m3u8DL-RE';
    var parts = [exe, winQuote(c.url || '')];
    var title = cleanTitle(c.title || '');
    if (title) parts.push('--save-name', winQuote(title));
    var h = c.headers || {};
    if (h.referer) parts.push('-H', winQuote('Referer: ' + h.referer));
    if (h.cookie) parts.push('-H', winQuote('Cookie: ' + h.cookie));
    if (h.userAgent) parts.push('-H', winQuote('User-Agent: ' + h.userAgent));
    var extra = h.extra || {};
    for (var name in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, name)) parts.push('-H', winQuote(name + ': ' + extra[name]));
    }
    if (o.autoSelect !== false) parts.push('--auto-select');
    return parts.join(' ');
  }

  // ================================================================ 发给本地服务

  /** 端口必须是服务端认可的五位数（app/core/server.py: PORT_LOW = 10000）。非法返回 0。 */
  function normalizePort(value) {
    var n = parseInt(value, 10);
    if (!isFinite(n) || n < 10000 || n > 65535) return 0;
    return n;
  }

  function baseUrl(port) {
    var p = normalizePort(port);
    return p ? 'http://127.0.0.1:' + p : '';
  }

  // ================================================================ 下载线程数

  /* 发给桌面端时用几个线程并发拉分片。
   * **0 = 跟随桌面端**（默认）：payload 里**不带** thread_count，桌面端沿用它在
   * 「新建下载」页的那套默认参数 —— 也就是加这个功能之前的行为，所以默认值不改变任何东西。
   *
   * 白名单与桌面端下载页的 THREAD_CHOICES 一致（主项目 app/ui/pages/download.py）。
   * 只允许送出桌面端下拉框里给得出的值：storage 被手改成 999 之类的野值一律回退
   * 「跟随桌面端」，免得把一个下载器没见过的数字塞进命令行。
   * 桌面端要加档位时，这里和 options.html 的单选值得一起加（static-check 会对拍两边）。 */
  var THREAD_CHOICES = [4, 8, 16, 32, 64];

  function normalizeThreadCount(value) {
    var n = parseInt(value, 10);
    return THREAD_CHOICES.indexOf(n) >= 0 ? n : 0;
  }

  /** POST /add 的请求体（字段与 app/core/server.py 逐一对齐）。
   *  只在 options.threadCount 有效时才带 thread_count —— 桌面端靠「键在不在」区分
   *  「没设（用它自己的默认）」和「设成了某个值」，所以不能发 0 或空串。 */
  function buildAddPayload(candidate, token, options) {
    var c = candidate || {};
    var h = c.headers || {};
    var o = options || {};
    var payload = {
      token: String(token || ''),
      url: String(c.url || ''),
      title: cleanTitle(c.title || ''),
      referer: h.referer || '',
      cookie: h.cookie || '',
      user_agent: h.userAgent || '',
      headers: h.extra || {}
    };
    var threads = normalizeThreadCount(o.threadCount);
    if (threads) payload.thread_count = threads;
    return payload;
  }

  // ================================================================ 外观主题

  /* 三选一：跟随系统（默认）/ 强制浅色 / 强制深色。
   * 归一化放宽大小写与首尾空格，非法值一律回退 system —— 存进 storage 的值可能被手改过。 */
  var THEMES = ['system', 'light', 'dark'];

  function normalizeTheme(theme) {
    var value = String(theme == null ? '' : theme).trim().toLowerCase();
    return THEMES.indexOf(value) >= 0 ? value : 'system';
  }

  /* 主题 -> 挂到根元素上的强制类名（system 返回空串 = 不加类，交给 prefers-color-scheme）。
   * 这个类名必须**同时**挂到 <html>（popup / options 页）和悬浮窗的 .mx-ov 上：
   * Shadow DOM 里 :root 不匹配，只挂 :root 的话悬浮窗不会跟着变。 */
  function themeClass(theme) {
    var value = normalizeTheme(theme);
    if (value === 'light') return 'mx-force-light';
    if (value === 'dark') return 'mx-force-dark';
    return '';
  }

  // ================================================================ 展示辅助

  function hostOf(url) {
    try { return new URL(url).host || ''; } catch (e) { return ''; }
  }

  function shortPath(url) {
    try {
      var u = new URL(url);
      var segs = u.pathname.split('/').filter(Boolean);
      var tail = segs.slice(-2).join('/') || u.pathname;
      if (u.search) tail += u.search;
      return tail.length > 56 ? '…' + tail.slice(-55) : tail;
    } catch (e) {
      var s = String(url || '');
      return s.length > 56 ? '…' + s.slice(-55) : s;
    }
  }

  function formatTimeAgo(time, now) {
    var t = Number(time) || 0;
    if (!t) return '';
    var seconds = Math.max(0, ((Number(now) || Date.now()) - t) / 1000);
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return Math.floor(seconds) + ' 秒前';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    return Math.floor(seconds / 3600) + ' 小时前';
  }

  /**
   * 悬浮球松手时的**左右边缘吸附**：离边缘够近（净空 ≤ threshold）就贴边（留 margin），
   * 否则原地不动。只吸左右 —— 长页面上上下吸附会显得莫名其妙。
   * 净空按"控件到边缘还剩多少"算：左侧 left - margin，右侧 viewportW - (left + width) - margin，
   * 所以**刚好等于 threshold 也算吸附**（<=）。
   * 返回值是吸附后的 left（整数）；调用方还要再过一次 clampOverlayPos 收尾。
   */
  function snapToEdge(left, width, viewportW, margin, threshold) {
    var m = typeof margin === 'number' ? margin : 8;
    var limit = typeof threshold === 'number' ? threshold : 24;
    var w = Math.max(0, Number(width) || 0);
    var vw = Math.max(0, Number(viewportW) || 0);
    var x = Number(left) || 0;
    if (vw <= 0) return Math.round(x);                       // 量不到视口就当不吸附
    if (x - m <= limit) return m;                            // 贴左
    var rightTarget = Math.max(m, vw - w - m);               // 控件比视口还宽时退化为贴左
    if (vw - (x + w) - m <= limit) return rightTarget;       // 贴右
    return Math.round(x);
  }

  /**
   * 把悬浮窗坐标夹进视口内（四周留 margin），避免拖出屏幕再也点不到。
   * 纯函数、不碰 DOM —— 拖动逻辑里最容易算错的就是边界，抽出来才测得到。
   * 控件比视口还大时退化为贴住左上角，不会产生负坐标。
   */
  function clampOverlayPos(left, top, width, height, viewportW, viewportH, margin) {
    var m = typeof margin === 'number' ? margin : 8;
    var w = Math.max(0, Number(width) || 0);
    var h = Math.max(0, Number(height) || 0);
    var maxLeft = Math.max(m, (Number(viewportW) || 0) - w - m);
    var maxTop = Math.max(m, (Number(viewportH) || 0) - h - m);
    return {
      left: Math.round(Math.min(Math.max(m, Number(left) || 0), maxLeft)),
      top: Math.round(Math.min(Math.max(m, Number(top) || 0), maxTop))
    };
  }

  /**
   * 悬浮面板该往哪边展开（自适应）：球贴着屏幕哪条边，就往还有空间的那一侧长。
   *
   * fab / panel 用 getBoundingClientRect() 的字段；viewport 是 {width, height}。
   * 返回 { x, y }：
   *   x='right' 面板左边缘贴球左边缘，朝右铺开   （CSS align-items: flex-start）
   *   x='left'  面板右边缘贴球右边缘，朝左铺开   （CSS align-items: flex-end）
   *   y='down'  面板在球下方                     （CSS flex-direction: column）
   *   y='up'    面板在球上方                     （CSS flex-direction: column-reverse）
   *
   * 优先级：首选方向放得下就用它；放不下再看另一侧；两边都放不下就选**空间更大**的那侧 ——
   * 面板自带 max-width / max-height，挤一挤还能用，选大的那侧溢出最少。
   * 全程用 <=（刚好放得下也算放得下），与 snapToEdge 的边界口径一致。
   */
  function planOverlayPlacement(fab, panel, viewport, gap, margin) {
    var g = typeof gap === 'number' ? gap : 12;
    var m = typeof margin === 'number' ? margin : 8;
    var f = fab || {};
    var p = panel || {};
    var v = viewport || {};
    var pw = Math.max(0, Number(p.width) || 0);
    var ph = Math.max(0, Number(p.height) || 0);
    var vw = Math.max(0, Number(v.width) || 0);
    var vh = Math.max(0, Number(v.height) || 0);
    var fabLeft = Number(f.left) || 0;
    var fabTop = Number(f.top) || 0;
    var fabRight = Number(f.right) || 0;
    var fabBottom = Number(f.bottom) || 0;

    /* 朝右铺：左边缘对齐球左边缘，占 [left, left+pw]，需要 pw <= vw - m - left
     * 朝左铺：右边缘对齐球右边缘，占 [right-pw, right]，需要 pw <= right - m */
    var roomRight = vw - m - fabLeft;
    var roomLeft = fabRight - m;
    var x;
    if (roomRight >= pw) x = 'right';
    else if (roomLeft >= pw) x = 'left';
    else x = roomRight >= roomLeft ? 'right' : 'left';

    /* 朝下铺：上边缘贴球下边缘 + gap，需要 ph <= vh - m - bottom - gap
     * 朝上铺：下边缘贴球上边缘 - gap，需要 ph <= top - gap - m */
    var roomDown = vh - m - fabBottom - g;
    var roomUp = fabTop - g - m;
    var y;
    if (roomDown >= ph) y = 'down';
    else if (roomUp >= ph) y = 'up';
    else y = roomDown >= roomUp ? 'down' : 'up';

    return { x: x, y: y };
  }

  return {
    KNOWN_HEIGHTS: KNOWN_HEIGHTS,
    MAX_TITLE: MAX_TITLE,
    normalizeContentType: normalizeContentType,
    isHlsUrl: isHlsUrl,
    isDashUrl: isDashUrl,
    isMediaUrl: isMediaUrl,
    isStreamContentType: isStreamContentType,
    streamKind: streamKind,
    heightLabel: heightLabel,
    formatBandwidth: formatBandwidth,
    qualityLabel: qualityLabel,
    heightFromUrl: heightFromUrl,
    bandwidthFromUrl: bandwidthFromUrl,
    parseHlsMaster: parseHlsMaster,
    parseMpdRepresentations: parseMpdRepresentations,
    parsePlaylist: parsePlaylist,
    parseQuality: parseQuality,
    dedupeCandidates: dedupeCandidates,
    sortCandidates: sortCandidates,
    pickDefaultIndex: pickDefaultIndex,
    pickDefault: pickDefault,
    normalizeCandidates: normalizeCandidates,
    filterHeaders: filterHeaders,
    cleanTitle: cleanTitle,
    winQuote: winQuote,
    buildCommand: buildCommand,
    normalizePort: normalizePort,
    baseUrl: baseUrl,
    buildAddPayload: buildAddPayload,
    THREAD_CHOICES: THREAD_CHOICES,
    normalizeThreadCount: normalizeThreadCount,
    hostOf: hostOf,
    shortPath: shortPath,
    formatTimeAgo: formatTimeAgo,
    clampOverlayPos: clampOverlayPos,
    planOverlayPlacement: planOverlayPlacement,
    snapToEdge: snapToEdge,
    THEMES: THEMES,
    normalizeTheme: normalizeTheme,
    themeClass: themeClass
  };
});
