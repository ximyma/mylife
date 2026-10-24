/**
 * 朗读：一套调用，两种引擎。
 *
 *   安卓 —— window.NativeTTS（原生 TextToSpeech，逐句回调，最可控）
 *   浏览器 —— speechSynthesis（逐句排队，onend 接下一句）
 *
 * 对外只暴露 TTS.speakFrom(根节点)，它会自己把文本按句子拆开、
 * 给每个节点打上 data-tts 索引，然后交由引擎逐句读、逐句高亮。
 */
(function () {
  'use strict';

  var native = (typeof window.NativeTTS !== 'undefined' && window.NativeTTS) || null;

  var queue = [];      // [{text, node}]
  var idx = -1;
  var playing = false;
  var rate = 0.95;
  var bar = null;
  var utter = null;    // 浏览器端的当前句
  var audioEl = null;  // 云端的当前句（<audio> 播 mp3）
  var cloudMode = 'system';   // system | cloud
  var cloudTried = false;     // 云端失败只提示一次，别每句都弹

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 按句末标点切句；太长再按逗号切 */
  function splitSentences(text) {
    var s = String(text || ''), out = [], cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      cur += ch;
      if ('。！？；'.indexOf(ch) >= 0) {
        if (cur.trim().length > 1) out.push(cur.trim());
        cur = '';
      }
    }
    if (cur.trim().length > 1) out.push(cur.trim());

    // 一句超过 120 字再按逗号切，避免一口气读太长
    var finer = [];
    for (var k = 0; k < out.length; k++) {
      if (out[k].length <= 120) { finer.push(out[k]); continue; }
      var parts = out[k].split('，');
      var buf = '';
      for (var p = 0; p < parts.length; p++) {
        buf += parts[p] + (p < parts.length - 1 ? '，' : '');
        if (buf.length >= 60) { finer.push(buf); buf = ''; }
      }
      if (buf.trim()) finer.push(buf);
    }
    return finer.length ? finer : [String(text || '').trim()];
  }

  /** 从根节点收集可读内容，顺便给元素挂上 data-tts 索引 */
  function collect(root) {
    var sel = '.ch-quote, .en p, .ph-event, .md-cap, .cover-intro, .fact dd';
    var nodes = root.querySelectorAll(sel);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = (el.textContent || '').trim();
      if (t.length < 2) continue;
      var sents = splitSentences(t);
      // 一个元素可能拆成多句，都指向同一个节点，只高亮整块
      for (var j = 0; j < sents.length; j++) {
        items.push({ text: sents[j], node: el });
      }
    }
    for (var k = 0; k < items.length; k++) {
      items[k].node.setAttribute('data-tts', k);
    }
    return items;
  }

  /* ---------------- 顶部提示条 ---------------- */

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'tts-bar';
    bar.innerHTML =
      '<span class="tts-pos" id="ttsPos">准备朗读</span>' +
      '<button id="ttsSlow" title="慢一点">慢</button>' +
      '<button id="ttsRate" title="当前语速">' + rate.toFixed(2).replace(/0$/, '') + '×</button>' +
      '<button id="ttsFast" title="快一点">快</button>' +
      '<button id="ttsBgm" title="背景配乐">配乐</button>' +
      '<button id="ttsEngine" title="音色来源">系统</button>' +
      '<button id="ttsStop" class="tts-stop">停止</button>';
    document.body.appendChild(bar);
    bar.querySelector('#ttsStop').onclick = function () { window.TTS.stop(); };
    var setRate = function (d) {
      rate = Math.max(0.6, Math.min(1.5, Math.round((rate + d) * 100) / 100));
      try { localStorage.setItem('ms_tts_rate', String(rate)); } catch (e) {}
      var el = bar.querySelector('#ttsRate');
      if (el) el.textContent = rate.toFixed(2).replace(/0$/, '') + '×';
      if (typeof DB !== 'undefined' && DB.setPref) DB.setPref('rate', rate);
      restartCurrent();
    };
    bar.querySelector('#ttsSlow').onclick = function () { setRate(-0.1); };
    bar.querySelector('#ttsFast').onclick = function () { setRate(0.1); };

    var bgmBtn = bar.querySelector('#ttsBgm');
    var list = (window.Mixer && window.Mixer.presets()) ? window.Mixer.presets() : [];
    var cur = window.Mixer ? window.Mixer.current() : 'none';
    for (var bi = 0; bi < list.length; bi++) if (list[bi].k === cur) bgmBtn.textContent = '配乐·' + list[bi].short;
    bgmBtn.onclick = function () {
      if (!window.Mixer) return;
      var all = window.Mixer.presets();
      var now = window.Mixer.current();
      var pos = 0;
      for (var i = 0; i < all.length; i++) if (all[i].k === now) pos = i;
      var next = all[(pos + 1) % all.length];
      window.Mixer.setPreset(next.k);
      bgmBtn.textContent = '配乐·' + next.short;
      if (next.k !== 'none' && playing) window.Mixer.start();
    };

    var engBtn = bar.querySelector('#ttsEngine');
    engBtn.textContent = (cloudMode === 'cloud' && !native) ? '云端' : '系统';
    engBtn.onclick = function () {
      if (native) { alert('手机上用的是系统自带音色，可离线朗读'); return; }
      cloudMode = (cloudMode === 'cloud') ? 'system' : 'cloud';
      try { localStorage.setItem('ms_tts_mode', cloudMode); } catch (e) {}
      engBtn.textContent = (cloudMode === 'cloud') ? '云端' : '系统';
      if (cloudMode === 'cloud') {
        if (!window.API || !API.tts) { cloudMode = 'system'; engBtn.textContent = '系统'; alert('这个版本不支持云端音色'); return; }
        alert('云端音色会用「朗读」环节绑定的模型（设置 → 模型来源）。没配就自动退回系统音色。');
      }
      if (playing) restartCurrent();
    };
    return bar;
  }

  function hideBar() {
    if (bar) { bar.parentNode.removeChild(bar); bar = null; }
  }

  function updateBar() {
    if (!bar) return;
    var el = bar.querySelector('#ttsPos');
    if (el) el.textContent = (idx + 1) + ' / ' + queue.length;
  }

  /* ---------------- 高亮与滚动 ---------------- */

  function clearMark() {
    var olds = document.querySelectorAll('.tts-reading');
    for (var i = 0; i < olds.length; i++) olds[i].className = olds[i].className.replace(/\s*tts-reading/g, '');
  }

  function mark(i) {
    clearMark();
    if (i < 0 || i >= queue.length) return;
    var node = queue[i].node;
    if (!node) return;
    node.className += ' tts-reading';
    try {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      try { node.scrollIntoView(); } catch (e2) {}
    }
    updateBar();
  }

  /* ---------------- 开始 / 继续 / 停止 ---------------- */

  function start(at) {
    idx = at || 0;
    playing = true;
    ensureBar();
    updateBar();
    if (!native && cloudMode === 'cloud' && window.API && API.tts) {
      startCloud(idx);
      if (window.Mixer && window.Mixer.current() !== 'none') window.Mixer.start();
      return;
    }
    if (window.Mixer && window.Mixer.current() !== 'none') window.Mixer.start();

    if (native) {
      var items = [];
      for (var i = 0; i < queue.length; i++) items.push(queue[i].text);
      var r;
      try {
        r = JSON.parse(native.speak(JSON.stringify(items), rate));
      } catch (e) {
        r = { ok: false, message: '朗读调用失败' };
      }
      if (!r.ok) {
        playing = false;
        hideBar();
        alert(r.message || '朗读不可用');
        return;
      }
      // 原生侧会从第 0 句开始，且通过 onSeg 回调；如果要求从中间开始，先略过
      if (idx > 0) { /* 原生侧暂不支持指定起点，从头读 */ }
    } else {
      speakBrowser(idx);
    }
  }

  /** 语速变了，从当前句重读 */
  function restartCurrent() {
    if (!playing) return;
    var at = idx < 0 ? 0 : idx;
    stop(false);
    start(at);
  }

  function stop(hide) {
    playing = false;
    idx = -1;
    clearMark();
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      audioEl = null;
    }
    if (window.Mixer) { window.Mixer.duck(false); window.Mixer.stop(); }
    if (native) {
      try { native.stop(); } catch (e) {}
    } else {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      utter = null;
    }
    if (hide !== false) hideBar();
  }

  /* ---------------- 浏览器端逐句 ---------------- */

  function pickVoice() {
    var synth = window.speechSynthesis;
    if (!synth || !synth.getVoices) return null;
    var list = synth.getVoices() || [];
    // 首帧可能还没加载完，返回 null 让浏览器用默认音色，别在这里递归
    for (var i = 0; i < list.length; i++) {
      var lang = list[i].lang || '';
      var name = list[i].name || '';
      if (/zh[-_]?CN/i.test(lang) || /Chinese|普通话|中文/i.test(name)) return list[i];
    }
    return null;
  }

  function speakBrowser(i) {
    if (!playing || i >= queue.length) {
      stop(true);
      return;
    }
    idx = i;
    mark(i);

    var synth = window.speechSynthesis;
    if (!synth) {
      alert('这个浏览器不支持朗读');
      stop(true);
      return;
    }

    utter = new SpeechSynthesisUtterance(queue[i].text);
    utter.lang = 'zh-CN';
    utter.rate = rate;
    utter.pitch = 1;
    var v = pickVoice();
    if (v) utter.voice = v;
    if (window.Mixer) window.Mixer.duck(true);
    utter.onend = function () {
      if (window.Mixer) window.Mixer.duck(false);
      if (!playing) return;
      speakBrowser(i + 1);
    };
    utter.onerror = function () {
      if (!playing) return;
      speakBrowser(i + 1);
    };
    try { synth.speak(utter); } catch (e) { stop(true); }
  }

  /* ---------------- 云端音色（mp3 逐句） ---------------- */

  function startCloud(i) {
    if (!playing || i >= queue.length) { stop(true); return; }
    idx = i;
    mark(i);

    API.tts({ text: queue[i].text, speed: rate }).then(function (r) {
      if (!playing) return;
      if (!r || !r.ok || !r.path) {
        if (!cloudTried) {
          cloudTried = true;
          if (r && r.message) window.__ttsError = r.message;
          // 一次不成就整段退回系统音色，别让用户听着空白
          cloudMode = 'system';
          try { localStorage.setItem('ms_tts_mode', 'system'); } catch (e) {}
          if (bar) {
            var b = bar.querySelector('#ttsEngine');
            if (b) b.textContent = '系统';
          }
          speakBrowser(i);
        } else {
          speakBrowser(i);
        }
        return;
      }
      var url = (ML && ML.fsrc) ? ML.fsrc(r.path) : ('/files/' + r.path);
      var a = new Audio(url);
      audioEl = a;
      a.preload = 'auto';
      a.onplay = function () { if (window.Mixer) window.Mixer.duck(true); };
      a.onended = function () {
        if (window.Mixer) window.Mixer.duck(false);
        audioEl = null;
        if (playing) startCloud(i + 1);
      };
      a.onerror = function () {
        audioEl = null;
        if (window.Mixer) window.Mixer.duck(false);
        if (playing) speakBrowser(i);
      };
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { if (playing) speakBrowser(i); });
    }, function () {
      cloudMode = 'system';
      speakBrowser(i);
    });
  }

  /* ---------------- 对外 ---------------- */

  try {
    var m = localStorage.getItem('ms_tts_mode');
    if (m === 'cloud') cloudMode = 'cloud';
  } catch (e) {}

  window.TTS = {
    native: !!native,
    cloud: function () { return cloudMode === 'cloud' && !native; },

    /** 朗读某个容器里的全部内容 */
    speakFrom: function (root, opts) {
      opts = opts || {};
      stop(true);
      queue = collect(root);
      if (!queue.length) {
        alert('这里还没有可读的内容');
        return;
      }
      if (opts.rate) rate = opts.rate;
      try {
        var saved = localStorage.getItem('ms_tts_rate');
        if (!opts.rate && saved) rate = Number(saved) || rate;
      } catch (e) {}
      start(0);
    },

    stop: function () { stop(true); },

    isPlaying: function () { return playing; },

    setRate: function (v) { rate = Number(v) || rate; },

    /** 原生回调：读到第 i 句 */
    onSeg: function (i) {
      // 原生侧从头读，队列可能比 DOM 收集的多/少，做一下边界保护
      if (i < 0 || i >= queue.length) return;
      mark(i);
    },

    /** 原生回调：读完了 */
    onEnd: function () {
      playing = false;
      idx = -1;
      clearMark();
      hideBar();
    },

    /** 原生回调：状态变化（就绪/报错） */
    onState: function (s) {
      if (!s) return;
      if (s.error) {
        window.__ttsError = s.error;
      } else {
        window.__ttsError = '';
      }
    },

    /** 诊断用：显示引擎情况 */
    diagnose: function () {
      if (!native) {
        return '浏览器朗读（speechSynthesis）· 音色 ' +
          ((window.speechSynthesis && window.speechSynthesis.getVoices().length) || 0) + ' 个';
      }
      var st;
      try { st = JSON.parse(native.status()); } catch (e) { st = {}; }
      var out = '原生 TTS · ' + (st.ready ? '就绪' : '未就绪');
      if (st.engine) out += ' · ' + st.engine;
      if (st.error) out += '\n' + st.error;
      return out;
    }
  };
})();
