/**
 * 界面与交互。一套代码，网页端与安卓 WebView 完全一致。
 * 刻意用 ES5：安卓 5/6 的 WebView 内核老，模板字符串/箭头函数/可选链都可能不支持。
 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search + location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  function fail(e) {
    toast((e && e.message) ? e.message : String(e));
    if (window.console) console.error(e);
  }

  function go(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  function topbar(opts) {
    opts = opts || {};
    var right = '';
    if (opts.right) {
      for (var i = 0; i < opts.right.length; i++) {
        right += '<a href="' + opts.right[i].href + '">' + esc(opts.right[i].text) + '</a>';
      }
    }
    return '<header class="top"><div class="top-in">' +
      (opts.back ? '<a class="top-back" href="' + opts.back + '">‹</a>' : '') +
      '<span class="logo">' + esc(opts.title || '我的人生档案') + '</span>' +
      '<div class="top-right">' + right + '</div>' +
      '</div></header>';
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  /* ---------------- 首页 ---------------- */

  function renderHome() {
    app.innerHTML = topbar({ right: [{ href: '#/settings', text: '设置' }] }) +
      '<main class="wrap"><div class="boot">正在读档案……</div></main>';

    DB.listArchives().then(function (list) {
      var cards = '';
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        cards += '<a class="arc-card" href="#/a/' + a.id + '">' +
          '<div class="arc-cover">' +
          (a.cover_path ? '<img src="/files/' + esc(a.cover_path) + '" alt="">' :
            '<span class="arc-empty">档案</span>') +
          '</div>' +
          '<div class="arc-meta">' +
          '<div class="arc-no">第 ' + esc(a.archive_no || '—') + ' 号</div>' +
          '<div class="arc-name">' + esc(a.subject_name) + '</div>' +
          '<div class="arc-years">' + esc(DB.yearLabel(a.birth_year, a.death_year)) +
          (a.hometown ? ' · ' + esc(a.hometown) : '') + '</div>' +
          '<div class="arc-stat">' + a.chapter_count + ' 章 · ' + a.entry_count + ' 条 · ' +
          a.photo_count + ' 张照片</div>' +
          '</div></a>';
      }

      var guide = list.length ? '' :
        '<section class="empty-guide">' +
        '<h2>从第一段讲述开始</h2>' +
        '<p class="muted">先把人的名字写下来，其余边讲边补。</p>' +
        '<ol class="steps">' +
        '<li><b>说一段</b><span>想到哪说到哪，不用按顺序。可以打字，也可以录音。</span></li>' +
        '<li><b>加几张照片</b><span>每张标上「哪一年、在哪儿、什么事」，才能被排进目录。</span></li>' +
        '<li><b>点一下生成</b><span>自动按年份分章、排目录、把照片放回原位。</span></li>' +
        '</ol></section>';

      app.innerHTML = topbar({ right: [{ href: '#/settings', text: '设置' }] }) +
        '<main class="wrap">' +
        '<section class="hello"><h1 class="h1">我的档案</h1>' +
        '<p class="muted">一个人，一本档案。</p></section>' +
        '<section class="arc-grid">' + cards +
        '<button class="arc-new" id="newBtn"><span>＋</span><b>新建档案</b>' +
        '<small>写下他的名字就能开始</small></button>' +
        '</section>' + guide + '</main>';

      var nb = document.getElementById('newBtn');
      if (nb) nb.onclick = askNew;
    }).catch(function (e) {
      app.innerHTML = topbar() + '<main class="wrap"><div class="empty">读不出来：' +
        esc(e.message) + '</div></main>';
    });
  }

  function askNew() {
    var name = prompt('这部档案是谁的？（写名字就行）');
    if (!name || !name.trim()) return;
    var birth = prompt('出生年份？（可以留空）');
    DB.createArchive(name, parseInt(birth, 10) || null, '').then(function (id) {
      toast('建好了');
      go('#/a/' + id + '/collect');
    }).catch(fail);
  }

  /* ---------------- 档案页 ---------------- */

  function renderArchive(id) {
    app.innerHTML = topbar({ back: '#/', right: [{ href: '#/a/' + id + '/collect', text: '补内容' }] }) +
      '<main class="wrap"><div class="boot">正在装订……</div></main>';

    DB.getArchive(id).then(function (d) {
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var byChapter = {}, orphans = [];
      for (var i = 0; i < d.entries.length; i++) {
        var e = d.entries[i];
        if (e.chapter_id) {
          if (!byChapter[e.chapter_id]) byChapter[e.chapter_id] = [];
          byChapter[e.chapter_id].push(e);
        } else {
          orphans.push(e);
        }
      }

      var photoById = {};
      for (var p = 0; p < d.photos.length; p++) photoById[d.photos[p].id] = d.photos[p];

      /* 封面 */
      var coverPhoto = null;
      for (var c0 = 0; c0 < d.photos.length; c0++) {
        if (String(d.photos[c0].id) === String(a.cover_photo_id)) coverPhoto = d.photos[c0];
      }
      if (!coverPhoto && d.photos.length) coverPhoto = d.photos[0];

      var html = topbar({
        back: '#/',
        right: [{ href: '#/a/' + id + '/collect', text: '补内容' }]
      });

      html += '<main class="paper">';

      html += '<section class="cover">' +
        (coverPhoto
          ? '<img class="cover-photo" src="/files/' + esc(coverPhoto.path) + '" alt="">'
          : '<div class="cover-photo"></div>') +
        '<div class="cover-no">档案第 ' + esc(a.archive_no || '—') + ' 号</div>' +
        '<h1 class="cover-name">' + esc(a.subject_name) + '</h1>' +
        '<div class="cover-years">' + esc(DB.yearLabel(a.birth_year, a.death_year)) +
        (a.hometown ? ' · ' + esc(a.hometown) : '') + '</div>' +
        (a.intro ? '<p class="cover-intro">「' + esc(a.intro) + '」</p>' : '') +
        '<div class="cover-foot">共 ' + d.chapters.length + ' 章' +
        (a.status === 'ready' ? '' : ' · 还没生成') + '</div>' +
        '</section>';

      /* 档案信息 */
      var facts = [];
      try { facts = JSON.parse(a.facts_json || '[]'); } catch (e) { facts = []; }
      if (facts && facts.length) {
        html += '<section class="facts"><h2 class="sec-label">档 案 信 息</h2><dl class="fact-list">';
        for (var f = 0; f < facts.length; f++) {
          html += '<div class="fact"><dt>' + esc(facts[f].k) + '</dt><dd>' + esc(facts[f].v) + '</dd></div>';
        }
        html += '</dl></section>';
      }

      if (!d.chapters.length) {
        html += '<section class="wrap"><div class="empty-guide">' +
          '<h2>这本档案还是空的</h2>' +
          '<ol class="steps">' +
          '<li><b>说一段</b><span>想到哪说到哪，不用按顺序。</span></li>' +
          '<li><b>加几张照片</b><span>标上哪一年、在哪儿、什么事。</span></li>' +
          '<li><b>点一下生成</b><span>自动分章、排目录、照片归位。</span></li>' +
          '</ol>' +
          '<a class="btn primary" href="#/a/' + id + '/collect">去说第一段 →</a>' +
          '</div></section>';
        html += '</main>';
        app.innerHTML = html;
        return;
      }

      /* 目录 */
      html += '<section class="toc"><h2 class="sec-label">目 录</h2>';
      for (var t = 0; t < d.chapters.length; t++) {
        var ch = d.chapters[t];
        var title = String(ch.title || '').replace(/^[^·]*·\s*/, '');
        html += '<a class="toc-row" href="#ch-' + ch.id + '">' +
          '<span class="toc-idx">' + (t + 1) + '</span>' +
          '<span class="toc-title">' + esc(title) +
          (ch.stage ? '<em class="toc-stage">' + esc(ch.stage) + '</em>' : '') + '</span>' +
          '<span class="toc-year">' + esc(ch.year_from ? DB.yearLabel(ch.year_from, ch.year_to) : '') + '</span>' +
          '</a>';
      }
      html += '</section>';

      /* 章节 */
      for (var ci = 0; ci < d.chapters.length; ci++) {
        var c = d.chapters[ci];
        var entries = byChapter[c.id] || [];
        html += '<section class="chapter" id="ch-' + c.id + '">';
        html += '<h2 class="ch-title"><span class="ch-idx">' + (ci + 1) + '</span>' +
          '<span class="ch-name">' + esc(String(c.title || '').replace(/^[^·]*·\s*/, '')) + '</span>' +
          '<span class="ch-year">' + esc(c.year_from ? DB.yearLabel(c.year_from, c.year_to) : '') + '</span></h2>';
        if (c.stage) html += '<div class="ch-kicker">' + esc(c.stage) +
          (a.birth_year && c.year_from ? ' · ' + (c.year_from - a.birth_year) + ' 岁' : '') + '</div>';
        if (c.quote) html += '<blockquote class="ch-quote">“' + esc(c.quote) + '”</blockquote>';

        if (!entries.length) html += '<p class="muted">这一章还是空的。</p>';
        for (var ei = 0; ei < entries.length; ei++) {
          html += renderEntry(entries[ei]);
        }
        html += '</section>';
      }

      /* 手写补充 */
      if (orphans.length) {
        html += '<section class="chapter"><h2 class="ch-title"><span class="ch-name">待归档</span></h2>';
        for (var oi = 0; oi < orphans.length; oi++) html += renderEntry(orphans[oi]);
        html += '</section>';
      }

      /* 待归档照片 */
      var pending = [];
      for (var pp = 0; pp < d.photos.length; pp++) {
        if (!d.photos[pp].chapter_id) pending.push(d.photos[pp]);
      }
      if (pending.length) {
        html += '<section class="pending"><h2>还有 ' + pending.length +
          ' 张照片没找到位置 <small>不是丢了，是不硬塞</small></h2><div class="pending-grid">';
        for (var pg = 0; pg < pending.length; pg++) {
          var ph = pending[pg];
          html += '<figure class="ph small"><img src="/files/' + esc(ph.path) + '" alt="" loading="lazy">' +
            '<figcaption><span class="ph-meta">' + esc(ph.taken_year) + ' · ' + esc(ph.place) + '</span>' +
            '<span class="ph-event">' + esc(ph.event) + '</span>' +
            '<span class="ph-why">' + esc(ph.match_reason || '时间地点对不上') + '</span>' +
            '</figcaption></figure>';
        }
        html += '</div></section>';
      }

      html += '<footer class="doc-foot"><span>' + esc(a.archive_no || '') + ' · ' +
        esc(a.subject_name) + '</span><span>由 AI 协助整理 · 可随时修改</span></footer>';
      html += '</main>';
      app.innerHTML = html;
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message) + '</div></main>';
    });
  }

  function renderEntry(e) {
    if (e.kind === 'photo') {
      return '<figure class="ph">' +
        '<img src="/files/' + esc(e.photo_path || '') + '" alt="" loading="lazy">' +
        '<figcaption><span class="ph-meta">' + esc(e.taken_year || '') +
        (e.place ? ' · ' + esc(e.place) : '') + '</span>' +
        '<span class="ph-event">' + esc(e.text || '') + '</span>' +
        (e.match_reason ? '<span class="ph-why">归位理由：' + esc(e.match_reason) + '</span>' : '') +
        '</figcaption></figure>';
    }
    if (e.kind === 'media') {
      var url = '/files/' + esc(e.media_path || '');
      var inner = '';
      if (e.media_kind === 'video') {
        inner = '<video controls playsinline preload="metadata" src="' + url + '"' +
          (e.media_poster ? ' poster="/files/' + esc(e.media_poster) + '"' : '') + '></video>';
      } else if (e.media_kind === 'audio') {
        inner = '<audio controls preload="metadata" src="' + url + '"></audio>';
      } else {
        inner = '<img src="' + url + '" alt="" loading="lazy">';
      }
      return '<div class="md">' + inner +
        (e.text ? '<div class="md-cap">' + esc(e.text) + '</div>' : '') + '</div>';
    }
    return '<div class="en' + (e.kind === 'quote' ? ' quote' : '') + '"><p>' + esc(e.text) + '</p></div>';
  }

  /* ---------------- 补内容 ---------------- */

  var rec = { mr: null, chunks: [], path: '', started: 0 };

  function renderCollect(id) {
    app.innerHTML = topbar({
      back: '#/a/' + id, title: '补内容',
      right: [{ href: '#/a/' + id, text: '看档案' }]
    }) + '<main class="wrap narrow"><div class="boot">正在打开……</div></main>';

    DB.getArchive(id).then(function (d) {
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var mats = '';
      for (var i = d.segments.length - 1; i >= 0; i--) {
        var s = d.segments[i];
        var txt = String(s.raw_text || '');
        mats += '<div class="mat"><div class="mat-text">' +
          esc(txt.slice(0, 110)) + (txt.length > 110 ? '…' : '') + '</div>' +
          '<div class="mat-side">' + (s.year_hint ? s.year_hint + ' 年' : '未编年') + '</div></div>';
      }

      app.innerHTML = topbar({
        back: '#/a/' + id, title: '补内容',
        right: [{ href: '#/a/' + id, text: '看档案' }]
      }) + '<main class="wrap narrow">' +

        '<section class="blk">' +
        '<h1 class="blk-title">说一段</h1>' +
        '<p class="muted">想到哪说到哪。系统会按年份把内容排进档案，不用管顺序。</p>' +
        '<div class="ask"><span class="ask-label">可以这样开头</span>' +
        '<p id="askText">您是哪一年出生的？在什么地方？家里有几口人？</p>' +
        '<button class="btn tiny ghost" id="askNext">换一个问题</button></div>' +
        '<textarea id="sayText" class="say" rows="6" placeholder="也可以直接打字……"></textarea>' +
        '<div class="rec">' +
        '<button class="btn rec-btn" id="recBtn"><span class="dot"></span> <b>点一下，开始说</b></button>' +
        '<span class="rec-state" id="recState"></span></div>' +
        '<div class="row end"><button class="btn primary" id="saveSeg">存为一条讲述</button></div>' +
        '</section>' +

        '<section class="blk">' +
        '<h1 class="blk-title">加照片</h1>' +
        '<p class="muted">每张都要填三样：<b>哪一年、在哪儿、什么事</b>。这是照片能被排进档案的唯一依据。</p>' +
        '<label class="drop" id="drop">点这里选照片<input type="file" id="photoInput" accept="image/*" hidden></label>' +
        '<div id="phQueue"></div>' +
        '</section>' +

        '<section class="blk">' +
        '<h1 class="blk-title">已有的材料</h1>' +
        '<p class="muted">' + d.segments.length + ' 条讲述 · ' + d.photos.length + ' 张照片</p>' +
        '<div>' + (mats || '<p class="muted">还没有讲述。</p>') + '</div>' +
        '<div class="row"><button class="btn primary block" id="genBtn">生成档案</button></div>' +
        '<p class="hint" id="genHint">生成会把讲述按年份排好、分成章、把照片放回原位。你手改过的内容不会被覆盖。</p>' +
        '</section>' +

        '</main>';

      bindCollect(id, d);
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message) + '</div></main>';
    });
  }

  function bindCollect(id, d) {
    var QUESTIONS = [
      '您是哪一年出生的？在什么地方？家里有几口人？',
      '小时候住的房子是什么样的？院子里有什么？',
      '父亲母亲是做什么的？他们说话是什么样子？',
      '上学上到几年级？印象最深的老师是谁？',
      '第一次离开家是哪一年？去做什么？',
      '第一份工作是什么？第一个月挣了多少钱？',
      '成家那一年，是怎么操办的？',
      '这辈子最难的一年是哪一年？发生了什么？',
      '您最得意的一件事是什么？',
      '如果让您给孙子讲一件事，您会讲哪件？'
    ];
    var qi = 0;
    document.getElementById('askNext').onclick = function () {
      qi = (qi + 1) % QUESTIONS.length;
      document.getElementById('askText').textContent = QUESTIONS[qi];
    };

    var sayText = document.getElementById('sayText');
    var recBtn = document.getElementById('recBtn');
    var recState = document.getElementById('recState');

    /* --- 录音：边录边写盘，别攒在内存里 --- */
    var canRec = typeof MediaRecorder !== 'undefined' &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (!canRec) {
      recState.textContent = '这台设备不支持录音，可以直接打字';
      recBtn.disabled = true;
    } else {
      recState.textContent = '录音会同时留着原声';
    }

    var recording = false;
    recBtn.onclick = function () {
      if (!canRec) return;
      if (recording) return stopRec();
      startRec();
    };

    function startRec() {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        rec.chunks = [];
        rec.path = '';
        rec.started = Date.now();
        var mr = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
        rec.mr = mr;
        var idx = 0;
        mr.ondataavailable = function (ev) {
          if (!ev.data || !ev.data.size) return;
          var reader = new FileReader();
          reader.onload = function () {
            var b64 = String(reader.result).split(',')[1];
            var name = 'seg-' + id + '-' + Date.now() + '.webm';
            API.file({ op: 'save', kind: 'audio', name: name, base64: b64, append: idx > 0 ? 1 : 0 })
              .then(function (r) { if (r && r.path) rec.path = r.path; })
              .catch(function () {});
            idx++;
          };
          reader.readAsDataURL(ev.data);
        };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          recording = false;
          recBtn.className = 'btn rec-btn';
          recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
          var sec = Math.round((Date.now() - rec.started) / 1000);
          recState.textContent = '录好了 ' + sec + ' 秒 · 记得点「存为一条讲述」';
        };
        mr.start(4000);   // 每 4 秒切一片，已经落盘
        recording = true;
        recBtn.className = 'btn rec-btn on';
        recBtn.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>';
        recState.textContent = '正在听……';
      }).catch(function () {
        recState.textContent = '没有拿到麦克风权限，可以直接打字';
      });
    }

    function stopRec() {
      try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); } catch (e) {}
    }

    /* --- 存一条讲述 --- */
    document.getElementById('saveSeg').onclick = function () {
      var btn = this;
      btn.disabled = true;
      DB.addSegment(id, sayText.value, rec.path || null).then(function () {
        toast('存好了');
        rec.path = '';
        setTimeout(function () { renderCollect(id); }, 300);
      }).catch(function (e) { fail(e); btn.disabled = false; });
    };

    /* --- 加照片 --- */
    var input = document.getElementById('photoInput');
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) return toast('这张超过 20MB，换一张小点的');
      compress(file, function (dataUrl) {
        showPhotoForm(id, dataUrl);
      });
    };

    /* --- 生成 --- */
    document.getElementById('genBtn').onclick = function () {
      var btn = this, hint = document.getElementById('genHint');
      btn.disabled = true;
      hint.textContent = '正在读你的讲述……';
      DB.generate(id).then(function () {
        hint.textContent = '装订完成，正在打开';
        setTimeout(function () { go('#/a/' + id); }, 400);
      }).catch(function (e) {
        hint.textContent = '';
        btn.disabled = false;
        fail(e);
      });
    };
  }

  /** 用 canvas 压到 1600px，避免原图太大 */
  function compress(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height, max = 1600;
        if (w > max || h > max) {
          var r = Math.min(max / w, max / h);
          w = Math.round(w * r);
          h = Math.round(h * r);
        }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        try {
          done(cv.toDataURL('image/jpeg', 0.86));
        } catch (e) {
          done(reader.result);
        }
      };
      img.onerror = function () { toast('这张图读不了'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function showPhotoForm(id, dataUrl) {
    var box = document.getElementById('phQueue');
    box.innerHTML = '<div class="ph-item" id="phForm">' +
      '<div class="idx">给这张照片标三样</div>' +
      '<img src="' + dataUrl + '" alt="">' +
      '<div class="row"><div class="col"><label>哪一年（必填）</label>' +
      '<input id="fYear" inputmode="numeric" placeholder="1975"></div>' +
      '<div class="col"><label>在哪儿（必填）</label>' +
      '<input id="fPlace" placeholder="沈阳，纺织厂门口"></div></div>' +
      '<div class="fld"><label>什么事（必填）</label>' +
      '<input id="fEvent" placeholder="进厂第一年，穿新工装"></div>' +
      '<div class="row end">' +
      '<button class="btn ghost tiny" id="phCancel">取消</button>' +
      '<button class="btn primary" id="phSave">保存</button></div></div>';

    document.getElementById('phCancel').onclick = function () { box.innerHTML = ''; };
    document.getElementById('phSave').onclick = function () {
      var y = document.getElementById('fYear').value.trim();
      var p = document.getElementById('fPlace').value.trim();
      var ev = document.getElementById('fEvent').value.trim();
      if (!y) return toast('这张是哪一年的？');
      if (!p) return toast('这张照片是在哪儿拍的？');
      if (!ev) return toast('这张照片是什么事？');
      this.disabled = true;
      DB.addPhoto(id, dataUrl, parseInt(y, 10), p, ev).then(function () {
        toast('照片存好了');
        box.innerHTML = '';
        renderCollect(id);
      }).catch(function (e) { fail(e); });
    };
  }

  /* ---------------- 设置 ---------------- */

  function renderSettings() {
    DB.getSettings().then(function (s) {
      app.innerHTML = topbar({ back: '#/', title: '设置' }) +
        '<main class="wrap narrow">' +
        '<h2 class="set-h">模型</h2>' +
        '<p class="muted">用来给章节起名、写一句话简介。不填也能用——章节名会自动按年份加内容摘要。</p>' +

        '<div class="fld"><label>接口地址</label>' +
        '<input id="aiBase" placeholder="https://api.siliconflow.cn/v1" value="' +
        esc(s['ai.base'] || '') + '"></div>' +

        '<div class="fld"><label>API Key</label>' +
        '<input id="aiKey" type="password" placeholder="sk-..." value="' +
        esc(s['ai.key'] || '') + '"></div>' +

        '<div class="fld"><label>模型名</label>' +
        '<input id="aiModel" placeholder="deepseek-ai/DeepSeek-V4-Flash" value="' +
        esc(s['ai.model'] || '') + '"></div>' +

        '<div class="row"><div class="col"><label>温度</label>' +
        '<input id="aiTemp" inputmode="decimal" value="' + esc(s['ai.temp'] || '0.7') + '"></div></div>' +

        '<div class="row end">' +
        '<button class="btn" id="aiTest">测试连通性</button>' +
        '<button class="btn primary" id="aiSave">保存</button></div>' +

        '<h2 class="set-h">关于</h2>' +
        '<p class="hint">我的人生档案 · The Story of My Life<br>' +
        '数据全部存在这台设备上，不上传任何地方。<br>' +
        '只有你自己配了模型，生成时才会把章节标题发出去。</p>' +
        '</main>';

      document.getElementById('aiSave').onclick = function () {
        var btn = this;
        btn.disabled = true;
        Promise.all([
          DB.saveSetting('ai.base', document.getElementById('aiBase').value.trim()),
          DB.saveSetting('ai.key', document.getElementById('aiKey').value.trim()),
          DB.saveSetting('ai.model', document.getElementById('aiModel').value.trim()),
          DB.saveSetting('ai.temp', document.getElementById('aiTemp').value.trim() || '0.7')
        ]).then(function () {
          toast('已保存');
          btn.disabled = false;
        }).catch(function (e) { fail(e); btn.disabled = false; });
      };

      document.getElementById('aiTest').onclick = function () {
        var btn = this;
        btn.disabled = true;
        toast('正在问模型……');
        API.ai([{ role: 'user', content: '只回两个字：可用' }]).then(function (r) {
          if (r.ok) toast('通了：' + String(r.text).slice(0, 20));
          else toast(r.message || '不通');
          btn.disabled = false;
        }).catch(function (e) { fail(e); btn.disabled = false; });
      };
    }).catch(fail);
  }

  /* ---------------- 路由 ---------------- */

  function route() {
    var h = location.hash || '#/';
    var m;

    if ((m = /^#\/a\/(\d+)\/collect/.exec(h))) return renderCollect(m[1]);
    if ((m = /^#\/a\/(\d+)/.exec(h))) return renderArchive(m[1]);
    if (h.indexOf('#/settings') === 0) return renderSettings();
    return renderHome();
  }

  window.addEventListener('hashchange', function () {
    window.scrollTo(0, 0);
    route();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', route);
  } else {
    route();
  }

  window.APP = { route: route, toast: toast };
})();
