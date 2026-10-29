/**
 * v0.9.17 素材箱（随手记 / 随口说 / 随手拍）+ 数据安全承诺书。
 * 和 cover / timeline / chat 一样是拆出去的界面模块：
 * app.js 只管路由，业务 SQL 在 db.js，这里只管摆界面、接事件。
 * 刻意 ES5——安卓 5/6 的 WebView 内核老。
 */
(function () {
  'use strict';

  var esc = function (s) { return window.ML.esc(s); };
  var fsrc = function (p) { return window.ML.fsrc(p); };

  /* ================= 数据安全承诺书 ================= */

  var PROMISE_ITEMS = [
    ['你的数据，只存在这台设备里。',
     '档案、照片、录音全部保存在本机。没有注册、没有账号、没有云后台——我们想看也看不到。'],
    ['上传模型的那句话，是你自己授权的。',
     'AI 功能要用你自己申请的模型密钥。只有你点「生成」的那一段文字会发给你选的模型平台，密钥也只存在你本机。'],
    ['随时可以带走全部数据。',
     '一键导出整本档案（含照片与录音），格式公开的 JSON。任何一天想换软件、想自己收着，都不用问我们。'],
    ['不玩「两年不登录就删你数据」那一套。',
     '本机存储没有登录也就没有「不活跃」。哪天你想清掉，也是你自己动手，我们永远不会替你删。'],
    ['删除就是真删除。',
     '你删掉的档案、照片、录音，从磁盘上移除，不进回收站，不留备份。'],
    ['这套承诺写在产品里，不是写在营销页上。',
     '程序完全开源可查，代码即承诺。'],
  ];

  function renderPromise(appEl) {
    var items = '';
    for (var i = 0; i < PROMISE_ITEMS.length; i++) {
      items += '<div class="pm-item"><b>' + (i + 1) + '. ' + esc(PROMISE_ITEMS[i][0]) + '</b>' +
        '<p>' + esc(PROMISE_ITEMS[i][1]) + '</p></div>';
    }
    var full = '《数据安全承诺书》\n\n';
    for (i = 0; i < PROMISE_ITEMS.length; i++) {
      full += (i + 1) + '. ' + PROMISE_ITEMS[i][0] + '\n' + PROMISE_ITEMS[i][1] + '\n\n';
    }
    appEl.innerHTML = window.ML.topbar({ back: '#/', title: '数据安全承诺' }) +
      '<main class="wrap narrow promise-page">' +
      '<p class="pm-lead">一句话版本：<b>数据是你的，不是我们的。</b>下面每一条都对应产品里的真实做法：</p>' +
      items +
      '<div class="row"><button class="btn" id="pmCopy">复制全文</button></div>' +
      '<p class="muted small">本承诺适用本程序全部版本（电脑版 / 网页版 / 安卓版）。</p></main>';

    document.getElementById('pmCopy').onclick = function () {
      var done = function () { window.ML.toast('已复制，可以粘贴给家人看'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).then(done, function () { fallbackCopy(full, done); });
      } else fallbackCopy(full, done);
    };
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { window.ML.toast('复制失败，请手动选择文字'); }
    document.body.removeChild(ta);
  }

  /* ================= 素材箱 ================= */

  var R = { on: false, native: false, chunks: [], ctx: null, started: 0, peak: 0,
            stream: null, proc: null, src: null, mute: null, path: '' };

  function render(appEl, opts) {
    opts = opts || {};
    appEl.innerHTML = window.ML.topbar({
      back: '#/', title: '素材箱',
      right: [{ href: '#/promise', text: '承诺书' }]
    }) +
      '<main class="wrap narrow inbox-page">' +
      '<p class="muted inbox-lead">随手记，不着急整理。想到什么记什么、说什么、拍什么——' +
      '攒到一批点「AI 归纳」出一篇短文，或一条条「收进档案」。</p>' +
      '<div class="inbox-acts">' +
      '<button class="btn rec-btn" id="qRecBtn"><span class="dot"></span> <b>说一段</b></button>' +
      '<button class="btn" id="qPhotoBtn">拍一张 / 选照片</button>' +
      '<input type="file" id="qPhotoFile" accept="image/*" hidden>' +
      '<button class="btn ghost" id="qSumBtn">✨ AI 归纳这一批</button>' +
      '</div>' +
      '<div id="qRecState" class="muted small rec-state"></div>' +
      '<div id="qSumBox" hidden></div>' +
      '<div id="qList" class="q-list"><div class="boot">正在翻素材箱……</div></div>' +
      '<div id="qDone"></div>' +
      '</main>';

    document.getElementById('qRecBtn').onclick = toggleRec;
    document.getElementById('qPhotoBtn').onclick = function () {
      document.getElementById('qPhotoFile').click();
    };
    document.getElementById('qPhotoFile').onchange = onPickPhoto;
    document.getElementById('qSumBtn').onclick = aiSummarize;

    if (!canRec()) {
      var st = document.getElementById('qRecState');
      st.textContent = '这台设备不支持录音，可以打字（首页「记一句」）或拍照';
      document.getElementById('qRecBtn').disabled = true;
    }

    loadList();
    if (opts.autoRec && canRec()) toggleRec();
    if (opts.autoPhoto) document.getElementById('qPhotoFile').click();
  }

  /* ---- 列表 ---- */

  function loadList() {
    window.DB.listQuick().then(function (list) {
      var box = document.getElementById('qList');
      if (!box) return;
      if (!list.length) {
        box.innerHTML = '<div class="empty"><div class="empty-icon">🧺</div>' +
          '<div class="empty-title">素材箱是空的</div>' +
          '<p class="muted">记忆不用等「有空」，现在就说一句。</p></div>';
      } else {
        var html = '';
        for (var i = 0; i < list.length; i++) html += quickCard(list[i]);
        box.innerHTML = html;
        bindCards(box);
      }
      loadDone();
    }).catch(function (e) { window.ML.fail(e); });
  }

  function quickCard(q) {
    var body = '';
    if (q.kind === 'photo' && q.media_path) {
      body += '<img class="q-thumb" src="' + esc(fsrc(q.media_path)) + '" alt="">';
    }
    if (q.kind === 'audio' && q.media_path) {
      body += '<audio class="q-audio" controls preload="none" src="' + esc(fsrc(q.media_path)) + '"></audio>';
    }
    var txt = String(q.text || '').trim();
    if (q.kind === 'audio' && !txt) {
      body += '<div class="muted small">还没转成文字。' +
        '<button class="btn tiny" data-q-asr="' + q.id + '">转成文字</button></div>';
    } else if (txt) {
      body += '<div class="q-text">' + esc(txt) + '</div>';
    } else if (q.kind === 'photo') {
      body += '<div class="muted small">还没写说明。收录的时候补一句</div>';
    }
    var when = String(q.created_at || '').slice(0, 16);
    return '<div class="q-card" data-q="' + q.id + '">' +
      '<div class="q-kind">' + (q.kind === 'photo' ? '📷 照片' : q.kind === 'audio' ? '🎙️ 录音' : '✏️ 文字') +
      ' <span class="muted small">' + esc(when) + '</span></div>' +
      body +
      '<div class="q-acts">' +
      '<button class="btn tiny primary" data-q-adopt="' + q.id + '">收进档案</button>' +
      '<button class="btn tiny danger" data-q-del="' + q.id + '">删</button>' +
      '</div></div>';
  }

  function bindCards(box) {
    box.onclick = function (ev) {
      var b;
      if ((b = ev.target.closest('[data-q-asr]'))) return doAsr(Number(b.getAttribute('data-q-asr')));
      if ((b = ev.target.closest('[data-q-adopt]'))) return openAdopt(Number(b.getAttribute('data-q-adopt')));
      if ((b = ev.target.closest('[data-q-del]'))) {
        var id = Number(b.getAttribute('data-q-del'));
        if (!confirm('这条素材不要了？删了就找不回来')) return;
        window.DB.removeQuick(id).then(loadList).catch(window.ML.fail);
      }
    };
  }

  function loadDone() {
    window.DB.listQuickDone().then(function (list) {
      var box = document.getElementById('qDone');
      if (!box || !list.length) return;
      var html = '<h3 class="q-done-title">最近收进档案的</h3>';
      for (var i = 0; i < Math.min(list.length, 5); i++) {
        html += '<div class="q-done-item muted small">' +
          esc(String(list[i].text || '').slice(0, 40)) + '… → <b>' +
          esc(list[i].subject_name || '档案') + '</b></div>';
      }
      box.innerHTML = html;
    }).catch(function () {});
  }

  /* ---- 说一段：录音（原生壳优先，浏览器兜底），停了自动转写 ---- */

  function canRec() {
    return !!(window.NativeRec || (typeof MediaRecorder !== 'undefined' &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }

  function toggleRec() {
    if (R.on) return stopRec();
    var NATIVE = window.NativeRec;
    if (NATIVE) return startRecNative();
    startRecWeb('');
  }

  function setRecState(t) {
    var el = document.getElementById('qRecState');
    if (el) el.textContent = t;
  }

  function recBtnOn(on) {
    var b = document.getElementById('qRecBtn');
    if (!b) return;
    if (on) { b.className = 'btn rec-btn on'; b.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>'; }
    else { b.className = 'btn rec-btn'; b.innerHTML = '<span class="dot"></span> <b>说一段</b>'; }
  }

  function startRecNative() {
    var NATIVE = window.NativeRec;
    var st = '';
    try { st = String(NATIVE.state() || ''); } catch (e) { st = ''; }
    if (st.indexOf('granted') < 0) {
      setRecState('正在请求麦克风权限……');
      window.__micPerm = function (r) {
        window.__micPerm = null;
        if (String(r) === 'granted') doStartNative();
        else setRecState('系统没放行麦克风（' + r + '）。到「设置 → 应用 → 权限」打开麦克风再试');
      };
      try { NATIVE.ask(); } catch (e) { window.__micPerm = null; setRecState('要不了麦克风权限：' + e.message); }
      return;
    }
    doStartNative();
  }

  function doStartNative() {
    var NATIVE = window.NativeRec;
    var name = 'quick-' + Date.now() + '.wav';
    var r = '';
    try { r = String(NATIVE.start(window.API.auth.token(), name) || ''); } catch (e) { r = 'err:' + e.message; }
    if (r.indexOf('ok') !== 0) {
      setRecState('录音开不了（' + r.replace(/^err:/, '') + '），试试打字或拍照');
      return;
    }
    R.on = true; R.native = true; R.peak = 0; R.started = Date.now();
    recBtnOn(true);
    R.tick = setInterval(function () {
      if (!R.on) return;
      var sec = 0;
      try { sec = Number(NATIVE.seconds()) || 0; } catch (e) {}
      setRecState('正在听…… 已录 ' + sec + ' 秒');
    }, 500);
  }

  function startRecWeb(nativeErr) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { setRecState('这个浏览器内核太老，录不了音' + (nativeErr ? '（' + nativeErr + '）' : '') + '，可以打字或拍照'); return; }
    var ctx;
    try { ctx = new AC(); } catch (e) { setRecState('音频通道打不开（' + e.name + '）'); return; }
    var kick = (ctx.state === 'suspended') ? ctx.resume() : Promise.resolve();
    kick.then(function () {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }).then(function (stream) {
      R.chunks = []; R.native = false; R.started = Date.now(); R.peak = 0;
      var src = ctx.createMediaStreamSource(stream);
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = function (e) {
        if (!R.on) return;
        var d = e.inputBuffer.getChannelData(0);
        R.chunks.push(new Float32Array(d));
        var pk = 0;
        for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
        if (pk > R.peak) R.peak = pk;
        setRecState('正在听…' + (pk < 0.01 ? '（几乎没有声音，检查麦克风）' : ''));
        if (R.chunks.length * 4096 / ctx.sampleRate > 600) stopRec();
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      R.ctx = ctx; R.src = src; R.proc = proc; R.stream = stream; R.mute = mute;
      R.on = true;
      recBtnOn(true);
      setRecState('正在听……');
    }).catch(function (e) {
      setRecState('录音打不开（' + ((e && e.name) || '未知') + '）' +
        (nativeErr ? '；原生录音也失败：' + nativeErr : '') + '。可以打字或拍照');
    });
  }

  function stopRec() {
    if (!R.on) return;
    R.on = false;
    recBtnOn(false);
    if (R.native) return stopRecNative();
    try { if (R.proc) R.proc.disconnect(); } catch (e) {}
    try { if (R.src) R.src.disconnect(); } catch (e) {}
    try { if (R.mute) R.mute.disconnect(); } catch (e) {}
    try { if (R.stream) R.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (R.ctx) R.ctx.close(); } catch (e) {}

    if (R.peak < 0.01) { setRecState('这段全是静音，没存。再试一次'); return; }

    var rate = R.ctx ? R.ctx.sampleRate : 48000;
    var buf = window.ML.buildWav(R.chunks, rate, 16000);
    var bytes = new Uint8Array(buf);
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    var b64 = btoa(bin);
    var sec = Math.round((Date.now() - R.started) / 1000);
    saveAudio('quick-' + R.started + '.wav', b64, sec);
  }

  function stopRecNative() {
    var NATIVE = window.NativeRec;
    if (R.tick) { clearInterval(R.tick); R.tick = 0; }
    var out = null;
    try { out = JSON.parse(String(NATIVE.stop() || '{}')); } catch (e) { out = null; }
    if (!out || !out.ok) { setRecState('这段没存下来：' + ((out && out.err) || '一个字节都没录到')); return; }
    if (Number(out.peak) < 0.01) {
      try { NATIVE.cancel(); } catch (e) {}
      setRecState('这段全是静音。看看有没有挡到麦克风孔，再录一次');
      return;
    }
    window.DB.addQuick('audio', '', out.path, Number(out.seconds) || null)
      .then(function () {
        setRecState('录音存好了 ' + out.seconds + ' 秒，正在转成文字…');
        return doAsrLast();
      })
      .then(loadList)
      .catch(window.ML.fail);
  }

  function saveAudio(name, b64, sec) {
    setRecState('正在保存录音…');
    window.API.file({ op: 'save', kind: 'audio', name: name, base64: b64 }).then(function (r) {
      if (!r || !r.path) throw new Error('录音没存下来');
      return window.DB.addQuick('audio', '', r.path, sec).then(function () {
        setRecState('录音存好了 ' + sec + ' 秒，正在转成文字…');
        return doAsrLast();
      }).then(loadList);
    }).catch(function (e) { setRecState(''); window.ML.fail(e); });
  }

  /** 刚录的那条（id 最大的 open 素材）去转写 */
  function doAsrLast() {
    return window.DB.listQuick().then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].kind === 'audio' && list[i].media_path) return transcribe(list[i].id, false);
      }
      return null;
    });
  }

  function doAsr(id) { return transcribe(id, true); }

  function transcribe(id, reload) {
    setRecState('正在转成文字，说得多就多等一会儿……');
    return window.DB.getQuick(id).then(function (q) {
      return window.API.asr({ path: q.media_path });
    }).then(function (r) {
      setRecState('');
      if (!r || !r.ok || !r.text) throw new Error((r && r.message) || '没转出来，点「转成文字」再试');
      return window.DB.updateQuick(id, { text: r.text }).then(function () {
        window.ML.toast('转好了');
        if (reload) loadList();
      });
    }).catch(function (e) {
      setRecState('');
      window.ML.fail(e);
    });
  }

  /* ---- 拍一张 ---- */

  function onPickPhoto(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    window.ML.compress(f, function (dataUrl) {
      var raw = dataUrl;
      var comma = raw.indexOf(',');
      if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
      window.API.file({ op: 'save', kind: 'photo', name: 'quick-' + Date.now() + '.jpg', base64: raw })
        .then(function (r) {
          if (!r || !r.path) throw new Error((r && r.message) || '照片没存下来');
          return window.DB.addQuick('photo', '', r.path, null);
        })
        .then(loadList)
        .catch(window.ML.fail);
    });
  }

  /* ---- AI 归纳这一批 ---- */

  function aiSummarize() {
    window.DB.listQuick().then(function (list) {
      if (!list.length) { window.ML.toast('素材箱是空的'); return; }
      var lines = [];
      for (var i = 0; i < list.length; i++) {
        var t = String(list[i].text || '').trim();
        if (t) lines.push((i + 1) + '. ' + t.slice(0, 300));
      }
      if (!lines.length) {
        window.ML.toast('这批素材还没有文字（录音先转写），归纳不了');
        return;
      }
      var btn = document.getElementById('qSumBtn');
      btn.disabled = true;
      var box = document.getElementById('qSumBox');
      box.hidden = false;
      box.innerHTML = '<div class="q-sum"><div class="boot">正在把这几条串起来读一遍……</div></div>';
      var prompt =
        '下面是一位用户随手记录的家庭记忆碎片（有的来自口述转写，文字口语化）。' +
        '请把它们整理成一篇 300-500 字的短文《这几天的家庭记忆》：保留具体的人名、年份、地点，' +
        '把碎片串成通顺的叙述，不要添油加醋编造没有的细节。最后单独一行列出' +
        '「值得收进档案的条目：1、3」这样的编号建议。\n\n' + lines.join('\n');
      window.API.ai({ messages: [{ role: 'user', content: prompt }], maxTokens: 1200 })
        .then(function (r) {
          btn.disabled = false;
          if (!r || !r.ok) throw new Error((r && r.message) || '模型没回话');
          var text = r.text || '';
          box.innerHTML = '<div class="q-sum"><h3>✨ 这几天的家庭记忆（AI 草稿）</h3>' +
            '<div class="q-sum-text">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
            '<div class="row"><button class="btn tiny" id="qSumCopy">复制</button>' +
            '<button class="btn tiny" id="qSumHide">收起</button></div></div>';
          document.getElementById('qSumCopy').onclick = function () {
            fallbackCopy(text, function () { window.ML.toast('已复制'); });
          };
          document.getElementById('qSumHide').onclick = function () { box.hidden = true; };
        })
        .catch(function (e) {
          btn.disabled = false;
          box.hidden = true;
          window.ML.fail(e);
        });
    }).catch(window.ML.fail);
  }

  /* ---- 收进档案 ---- */

  function openAdopt(id) {
    var DB = window.DB;
    DB.getQuick(id).then(function (q) {
      return DB.listArchives().then(function (arcs) {
        if (!arcs.length) {
          window.ML.toast('先在首页建一本档案，再把素材收进去');
          return;
        }
        var opts = '';
        for (var i = 0; i < arcs.length; i++) {
          opts += '<option value="' + arcs[i].id + '">' + esc(arcs[i].subject_name) + '</option>';
        }
        var m = window.ML.modalBox('收进档案',
          '<label>收进哪本档案<select class="fi" id="adArc">' + opts + '</select></label>' +
          '<label>发生在哪一年<input class="fi" id="adYear" inputmode="numeric" ' +
          'placeholder="1975（可点右边的按钮让 AI 判断）"></label>' +
          '<button class="btn tiny" id="adYearAi">🤖 AI 帮我判断年份</button>' +
          (q.kind === 'photo'
            ? '<label>在哪儿<input class="fi" id="adPlace" placeholder="老家 / 北京……"></label>' +
              '<label>这张照片是什么事<input class="fi" id="adEvent" placeholder="全家福 / 搬新家……"></label>' +
              (q.media_path ? '<img class="q-thumb" src="' + esc(fsrc(q.media_path)) + '" alt="">':'')
            : '<label>以这段文字收进档案（可改）' +
              '<textarea class="fi" id="adText" rows="4">' + esc(q.text || '') + '</textarea></label>') +
          '<div class="ml-modal-acts"><button class="btn" id="adCancel">再放放</button>' +
          '<button class="btn primary" id="adOk">收进去</button></div>');

        document.getElementById('adCancel').onclick = m.close;
        document.getElementById('adYearAi').onclick = function () {
          var src = q.kind === 'photo'
            ? (q.text || '') + ' ' + (document.getElementById('adEvent').value || '')
            : document.getElementById('adText').value;
          if (!String(src).trim()) { m.msg('先写点内容，AI 才有得判断'); return; }
          document.getElementById('adYearAi').textContent = '正在想……';
          window.API.ai({
            messages: [{ role: 'user', content:
              '从下面这段家庭记忆里判断事件大概发生的公元年份。只回一个四位数字年份，不要别的。\n\n' +
              String(src).slice(0, 500) }],
            maxTokens: 16
          }).then(function (r) {
            var ym = r && r.ok ? String(r.text || '').match(/(1[89]\d{2}|20\d{2})/) : null;
            if (ym) document.getElementById('adYear').value = ym[1];
            else m.msg('没判断出来，手动填一个吧');
            document.getElementById('adYearAi').textContent = '🤖 AI 帮我判断年份';
          }).catch(function (e) {
            m.msg(e.message || '判断失败');
            document.getElementById('adYearAi').textContent = '🤖 AI 帮我判断年份';
          });
        };

        document.getElementById('adOk').onclick = function () {
          var arcId = Number(document.getElementById('adArc').value);
          var year = parseInt(document.getElementById('adYear').value, 10) || null;
          if (!arcId) { m.msg('选一本档案'); return; }
          if (q.kind === 'photo') {
            var place = document.getElementById('adPlace').value.trim();
            var event = document.getElementById('adEvent').value.trim();
            if (!place || !event) { m.msg('照片要标「在哪儿、什么事」才能进档案'); return; }
            // 读回原图，走正式照片入库（编年、进目录、上封面都和补内容页一样）
            window.API.file({ op: 'read', path: q.media_path }).then(function (f) {
              if (!f || !f.base64) throw new Error('照片文件读不回来了');
              return DB.addPhoto(arcId, f.base64, year, place, event,
                'quick-' + q.id + '.jpg');
            }).then(function () {
              return DB.markQuickAdopted(q.id, arcId, null);
            }).then(function () {
              m.close();
              window.ML.toast('照片收进档案了');
              loadList();
            }).catch(function (e) { m.msg(e.message || String(e)); });
          } else {
            var text = document.getElementById('adText').value.trim();
            DB.adoptQuick(q.id, arcId, year, text).then(function () {
              m.close();
              window.ML.toast('收进档案了');
              loadList();
            }).catch(function (e) { m.msg(e.message || String(e)); });
          }
        };
      });
    }).catch(window.ML.fail);
  }

  window.InboxUI = {
    render: render,
    renderPromise: renderPromise,
  };
})();
