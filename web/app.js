/**
 * 界面与交互。一套代码，网页端与安卓 WebView 完全一致。
 * 刻意用 ES5：安卓 5/6 的 WebView 内核老，模板字符串/箭头函数/可选链都可能不支持。
 */
(function () {
  'use strict';

  /* ---- 老 WebView 补丁：安卓 5/6 的内核没有 closest / startsWith / find ---- */
  if (!Element.prototype.closest) {
    Element.prototype.closest = function (sel) {
      var el = this;
      while (el && el.nodeType === 1) {
        if ((el.matches || el.msMatchesSelector || el.webkitMatchesSelector).call(el, sel)) return el;
        el = el.parentElement;
      }
      return null;
    };
  }
  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (t, pos) {
      return this.substr(pos || 0, String(t).length) === String(t);
    };
  }
  if (!Array.prototype.find) {
    Array.prototype.find = function (fn) {
      for (var i = 0; i < this.length; i++) if (fn(this[i], i, this)) return this[i];
      return undefined;
    };
  }

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
        (d.chapters.length
          ? '<div class="cover-acts"><button class="btn tiny" data-read-all="1">从头朗读</button></div>'
          : '') +
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
          '<span class="ch-year">' + esc(c.year_from ? DB.yearLabel(c.year_from, c.year_to) : '') + '</span>' +
          '<button class="ch-read" data-read-ch="' + c.id + '" title="从这一章开头朗读">读</button>' +
          '<button class="ch-edit" data-ch-edit="' + c.id + '" title="改章名">改</button></h2>';
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
      bindArchive(id);
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message) + '</div></main>';
    });
  }

  /** 卷宗里的改与删：条目改字、改章名、删条目 */
  function bindArchive(id) {
    if (archiveClickHandler) app.removeEventListener('click', archiveClickHandler);
    archiveClickHandler = function (ev) {
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var b;

      if ((b = t.closest('[data-entry-edit]'))) {
        editState = { type: 'entry', id: Number(b.getAttribute('data-entry-edit')) };
        return route();
      }
      if ((b = t.closest('[data-edit-cancel]'))) {
        clearEdit();
        return route();
      }
      if ((b = t.closest('[data-entry-save]'))) {
        var eid = Number(b.getAttribute('data-entry-save'));
        var ta = document.querySelector('[data-entry-text="' + eid + '"]');
        DB.updateEntry(eid, ta ? ta.value : '').then(function () {
          clearEdit();
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-entry-del]'))) {
        var did = Number(b.getAttribute('data-entry-del'));
        if (!confirm('删掉这一段？删了就找不回来了。')) return;
        DB.deleteEntry(did).then(function () {
          toast('已删除');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ch-edit]'))) {
        var chid = Number(b.getAttribute('data-ch-edit'));
        var el = document.querySelector('[data-ch-title="' + chid + '"]');
        var cur = el ? el.textContent : '';
        var v = prompt('章名改成什么？（留空就不改）', cur);
        if (v === null) return;
        DB.updateChapter(chid, v, '').then(function () {
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
    };
    app.addEventListener('click', archiveClickHandler);
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
    // 文字条目：可就地改，可删
    if (isEdit('entry', e.id)) {
      return '<div class="en editing">' +
        '<textarea class="say mini" data-entry-text="' + e.id + '">' + esc(e.text) + '</textarea>' +
        '<div class="en-acts">' +
        '<button class="btn tiny primary" data-entry-save="' + e.id + '">保存</button>' +
        '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
    }
    return '<div class="en' + (e.kind === 'quote' ? ' quote' : '') + '"><p>' + esc(e.text) + '</p>' +
      '<div class="en-acts">' +
      '<button class="linkbtn" data-entry-edit="' + e.id + '">改</button>' +
      '<button class="linkbtn danger-t" data-entry-del="' + e.id + '">删</button>' +
      '</div></div>';
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

      /* --- 讲述：可改可删，有录音的还能转成文字 --- */
      for (var i = d.segments.length - 1; i >= 0; i--) {
        var s = d.segments[i];
        var txt = String(s.raw_text || '');
        // 录音存进来时留的是占位文本，这时按钮说"转成文字"；转过之后是"再转一次"
        var pending = !!s.audio_path &&
          (!txt || txt.indexOf('待转写') >= 0 || txt.indexOf('录音已保存') >= 0);

        if (isEdit('seg', s.id)) {
          mats += '<div class="mat editing">' +
            '<textarea class="say mini" data-seg-text="' + s.id + '">' + esc(txt) + '</textarea>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-seg-save="' + s.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
          continue;
        }

        mats += '<div class="mat" data-mat="' + s.id + '">' +
          '<div class="mat-text">' +
          esc(txt.slice(0, 110)) + (txt.length > 110 ? '…' : '') + '</div>' +
          '<div class="mat-side">' + (s.year_hint ? s.year_hint + ' 年' : '未编年') + '</div>' +
          '<div class="mat-acts">' +
          (s.audio_path
            ? '<button class="btn tiny" data-tr="' + s.id + '">' +
              (pending ? '转成文字' : '再转一次') + '</button>'
            : '') +
          '<button class="btn tiny" data-seg-edit="' + s.id + '">改</button>' +
          '<button class="btn tiny danger" data-seg-del="' + s.id + '">删</button>' +
          '</div></div>';
      }

      /* --- 照片：看得到、改得了、删得掉 --- */
      for (var pi = d.photos.length - 1; pi >= 0; pi--) {
        var ph = d.photos[pi];

        if (isEdit('photo', ph.id)) {
          mats += '<div class="mat editing">' +
            '<div class="ph-edit">' +
            '<img class="ph-thumb" src="/files/' + esc(ph.path) + '" alt="">' +
            '<div class="ph-fields">' +
            '<label>哪一年<input class="fi" type="number" data-ph-year="' + ph.id +
            '" value="' + esc(ph.taken_year) + '" placeholder="1958"></label>' +
            '<label>在哪儿<input class="fi" data-ph-place="' + ph.id +
            '" value="' + esc(ph.place) + '" placeholder="北京"></label>' +
            '<label>什么事<input class="fi" data-ph-event="' + ph.id +
            '" value="' + esc(ph.event) + '" placeholder="在天安门前"></label>' +
            '</div></div>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-ph-save="' + ph.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
          continue;
        }

        mats += '<div class="mat">' +
          '<img class="mat-thumb" src="/files/' + esc(ph.path) + '" alt="">' +
          '<div class="mat-text"><b>' + esc(ph.taken_year) + '</b> · ' +
          esc(ph.place) + ' · ' + esc(ph.event) + '</div>' +
          '<div class="mat-acts">' +
          '<button class="btn tiny" data-ph-edit="' + ph.id + '">改</button>' +
          '<button class="btn tiny danger" data-ph-del="' + ph.id + '">删</button>' +
          '</div></div>';
      }

      if (!mats) mats = '<p class="muted">还没有材料。上面说一段，或者加张照片。</p>';

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

    /* --- 语音转文字 + 改 / 删 --- */
    // 反复进出这页时，监听器不能一层层往上叠
    if (collectClickHandler) app.removeEventListener('click', collectClickHandler);
    collectClickHandler = function (ev) {
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var b, sid;

      /* 转成文字 */
      if ((b = t.closest('[data-tr]'))) {
        sid = Number(b.getAttribute('data-tr'));
        if (b.disabled) return;
        b.disabled = true;
        var label = b.textContent;
        b.textContent = '转写中…';
        DB.transcribe(sid).then(function (r) {
          if (!r.ok) {
            toast(r.message || '转不出来');
            b.disabled = false;
            b.textContent = label;
            return;
          }
          toast('转好了（' + (r.ms / 1000).toFixed(1) + 's）：' + String(r.text).slice(0, 20));
          route();   // 重画整页，把转出来的文字显示出来
        }).catch(function (e) {
          toast(e.message || '转不出来');
          b.disabled = false;
          b.textContent = label;
        });
        return;
      }

      /* 进入编辑 */
      if ((b = t.closest('[data-seg-edit]'))) {
        editState = { type: 'seg', id: Number(b.getAttribute('data-seg-edit')) };
        return route();
      }
      if ((b = t.closest('[data-ph-edit]'))) {
        editState = { type: 'photo', id: Number(b.getAttribute('data-ph-edit')) };
        return route();
      }
      if ((b = t.closest('[data-edit-cancel]'))) {
        clearEdit();
        return route();
      }

      /* 保存 */
      if ((b = t.closest('[data-seg-save]'))) {
        sid = Number(b.getAttribute('data-seg-save'));
        var ta = document.querySelector('[data-seg-text="' + sid + '"]');
        DB.updateSegment(sid, ta ? ta.value : '').then(function () {
          clearEdit();
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-save]'))) {
        var pid = Number(b.getAttribute('data-ph-save'));
        var g = function (sel) {
          var el = document.querySelector('[data-ph-' + sel + '="' + pid + '"]');
          return el ? el.value : '';
        };
        DB.updatePhoto(pid, { year: g('year'), place: g('place'), event: g('event') })
          .then(function () {
            clearEdit();
            toast('改好了');
            route();
          }).catch(fail);
        return;
      }

      /* 删除：都先问一句，删了就找不回来了 */
      if ((b = t.closest('[data-seg-del]'))) {
        var dseg = Number(b.getAttribute('data-seg-del'));
        if (!confirm('删掉这段讲述？删了就找不回来了。')) return;
        DB.deleteSegment(dseg).then(function () { toast('已删除'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-del]'))) {
        var dph = Number(b.getAttribute('data-ph-del'));
        if (!confirm('删掉这张照片？删了就找不回来了。')) return;
        DB.deletePhoto(dph).then(function () { toast('已删除'); route(); }).catch(fail);
        return;
      }
    };
    app.addEventListener('click', collectClickHandler);

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

  var KINDS = [
    { k: 'openai', label: 'OpenAI 兼容', base: 'https://api.openai.com/v1', key: true },
    { k: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', key: true },
    { k: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1', key: true },
    { k: 'ollama', label: '本机 Ollama', base: 'http://127.0.0.1:11434/v1', key: false },
    { k: 'custom', label: '自定义 / 内网', base: '', key: true }
  ];

  // 平台注册入口。前者是本项目作者的硅基流动邀请码，点了两边都有券；
  // 后面各家是实测能领到免费额度、且接口与本项目兼容的。
  var SIGNUP = [
    { name: '硅基流动', url: 'https://cloud.siliconflow.cn/i/oSZ7RcMc',
      note: '免费档常驻模型：DeepSeek-OCR（看图）、Qwen3-ASR-1.7B（转文字）、Hunyuan-MT-7B（写稿）、Qwen3-8B', star: true },
    { name: '腾讯云混元', url: 'https://curl.qcloud.com/ofeR1Flf',
      note: '首次开通送 100 万 tokens（含 hunyuan-turbos-vision 等多模态），有效期 1 年；hunyuan-lite 永久免费' },
    { name: '智谱 bigmodel', url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
      note: 'Flash 系列永久免费，GLM-4.6V-Flash 是免费的多模态（能看懂照片场景，比 OCR 更进一步）' }
  ];

  function kindLabel(k) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].k === k) return KINDS[i].label;
    return k;
  }

  var editing = null;          // 正在编辑的配置；null 表示新增
  var settingsClickHandler = null;   // 反复进出设置页时不能叠加监听器
  var collectClickHandler = null;    // 同上，采集页的「转成文字」
  var archiveClickHandler = null;    // 同上，卷宗页的改与删

  /* 就地编辑：哪一条正在被改。type 为 seg / photo / entry / chapter，null 表示没在改 */
  var editState = { type: null, id: null };

  function isEdit(type, id) {
    return editState.type === type && String(editState.id) === String(id);
  }

  function clearEdit() { editState.type = null; editState.id = null; }

  function renderSettings() {
    Promise.all([DB.listProfiles(), DB.getSlots(), DB.getSettings()]).then(function (r) {
      var profiles = r[0], slots = r[1], cfg = r[2];
      var slotMap = {};
      for (var i = 0; i < slots.length; i++) slotMap[slots[i].slot] = slots[i];

      var html = topbar({ back: '#/', title: '设置' }) + '<main class="wrap narrow">';

      /* ---- 模型来源 ---- */
      html += '<h2 class="set-h">模型来源</h2>' +
        '<p class="hint">随便加几条，用哪个都行。不配也能用——章节名会按年份和内容自动生成。</p>' +
        '<p class="hint dim">「拉模型」只读模型清单，几乎不占资源；「测试」会真发一句话。' +
        '标着<b>本机</b>的配置会把模型加载进这台机器，没有独立显卡时很慢也很吃内存，' +
        '平时建议用云端服务。</p>';

      /* ---- 该填什么模型：照抄就行，这些全都免费 ---- */
      html += '<h2 class="set-h">该填什么模型</h2>' +
        '<p class="hint">下面这几款都是实测过、不用花钱的，照着名字抄进「模型 ID」即可。</p>' +
        '<dl class="ai-kv pick">' +
        '<dt>起章名 / 写简介</dt><dd><code>tencent/Hunyuan-MT-7B</code> <span class="muted">0.5 秒</span></dd>' +
        '<dt>看照片</dt><dd><code>deepseek-ai/DeepSeek-OCR</code> <span class="muted">0.3 秒</span></dd>' +
        '<dt>语音转文字</dt><dd><code>Qwen/Qwen3-ASR-1.7B</code> <span class="muted">0.4 秒</span></dd>' +
        '<dt>要更好文笔</dt><dd><code>Qwen/Qwen3-8B</code> <span class="muted">免费但慢些（会先思考）</span></dd>' +
        '</dl>' +
        '<p class="hint dim">想让程序真正「看懂」照片场景而不只是认字，' +
        '可以去智谱开个号用 <code>GLM-4.6V-Flash</code>，那是免费的多模态模型。</p>';

      /* ---- 去哪拿 Key（常驻，不只在没配置时才出现） ---- */
      var links = '';
      for (var gi = 0; gi < SIGNUP.length; gi++) {
        var g = SIGNUP[gi];
        links += '<a class="signup" href="' + esc(g.url) + '" target="_blank" rel="noopener"' +
          (g.star ? ' data-star="1"' : '') + '>' +
          '<b>' + esc(g.name) + '</b>' +
          (g.star ? '<span class="tag">推荐</span>' : '') +
          '<span class="su-arrow">→</span>' +
          '<small>' + esc(g.note) + '</small></a>';
      }
      html += '<div class="signup-box">' +
        '<p class="hint">' + (profiles.length
          ? '要去别家拿免费额度？这几家都能直接用：'
          : '还没有 API Key？这几家都有免费额度，注册就能用，不用先充值：') + '</p>' +
        links + '</div>';

      if (!profiles.length) {
        html += '<div class="empty">还没有配置。点下面「添加」开始。</div>';
      }

      // 三个环节。卡片上要显示"这条配置负责哪一环"，所以放在卡片之前
      var SLOTS = [
        { k: 'title', label: '起章名 / 写简介', hint: '要一点文笔，建议用云端大模型' },
        { k: 'vision', label: '看照片', hint: '给老照片认场景（多模态模型）' },
        { k: 'asr', label: '语音转文字', hint: '需支持音频输入的服务' }
      ];

      for (var p = 0; p < profiles.length; p++) {
        var pf = profiles[p];
        var models = [];
        try { models = JSON.parse(pf.models_json || '[]'); } catch (e) { models = []; }
        // 本机部署（ollama / vLLM / LM Studio）：点测试会真的把模型加载进内存
        var local = /127\.0\.0\.1|localhost|0\.0\.0\.0|192\.168\.|:11434/.test(pf.base_url || '');
        // 这张卡上写全：接口地址、密钥、现在用着的模型、各自负责哪一环。
        // 不用去猜"填在哪"，一眼能核对。
        var keyMask = pf.api_key
          ? String(pf.api_key).slice(0, 6) + '…' + String(pf.api_key).slice(-4)
          : '<span class="warn-text">没填（本机模型不需要）</span>';

        var usedBy = [];
        for (var sl = 0; sl < SLOTS.length; sl++) {
          var bind = slotMap[SLOTS[sl].k] || {};
          if (String(bind.profile_id) === String(pf.id)) {
            usedBy.push(SLOTS[sl].label + ' → ' + (bind.model || pf.default_model || '?'));
          }
        }

        html += '<div class="ai-card' + (pf.enabled ? '' : ' off') + '">' +
          '<div class="ai-card-top">' +
          '<b>' + esc(pf.name) + '</b>' +
          '<span class="tag">' + esc(kindLabel(pf.kind)) + '</span>' +
          (local ? '<span class="tag warn" title="模型跑在这台机器上">本机</span>' : '') +
          '<button class="linkbtn" data-toggle="' + pf.id + '" data-to="' + (pf.enabled ? 0 : 1) + '">' +
          (pf.enabled ? '停用' : '启用') + '</button>' +
          '</div>' +

          '<dl class="ai-kv">' +
          '<dt>接口地址</dt><dd><code>' + esc(pf.base_url) + '</code></dd>' +
          '<dt>密钥</dt><dd><code>' + keyMask + '</code></dd>' +
          '<dt>默认模型</dt><dd><code>' +
            (pf.default_model ? esc(pf.default_model) : '还没选') + '</code></dd>' +
          '<dt>负责</dt><dd>' + (usedBy.length
            ? usedBy.join('；')
            : '<span class="muted">没绑到具体环节（会被自动挑用）</span>') + '</dd>' +
          '</dl>' +

          '<div class="ai-acts">' +
          '<button class="btn tiny" data-test="' + pf.id + '"' +
            (local ? ' data-local="1"' : '') + '>测试</button>' +
          '<button class="btn tiny" data-pull="' + pf.id + '">拉模型</button>' +
          '<button class="btn tiny" data-edit="' + pf.id + '">改</button>' +
          '<button class="btn tiny danger" data-del="' + pf.id + '">删</button>' +
          '</div></div>';
      }

      html += '<div id="profileForm"></div>' +
        (profiles.length ? '' : '') +
        '<div class="row end" style="margin-top:14px">' +
        '<button class="btn" id="addProfile">＋ 添加配置</button></div>';

      /* ---- 用途绑定 ---- */
      html += '<h2 class="set-h">各环节用哪个模型</h2>' +
        '<p class="hint">留空就用上面第一条可用的配置。这三个环节可以同时用不同家的服务。</p>';

      for (var si = 0; si < SLOTS.length; si++) {
        var sl = SLOTS[si];
        var bound = slotMap[sl.k] || {};
        var opts = '<option value="">不用（按规则）</option>';
        for (var q = 0; q < profiles.length; q++) {
          opts += '<option value="' + profiles[q].id + '"' +
            (String(bound.profile_id) === String(profiles[q].id) ? ' selected' : '') + '>' +
            esc(profiles[q].name) + '</option>';
        }
        html += '<div class="slot-row" data-slot="' + sl.k + '">' +
          '<div class="slot-label"><b>' + esc(sl.label) + '</b><small>' + esc(sl.hint) + '</small></div>' +
          '<select class="slot-pick">' + opts + '</select>' +
          '<button class="btn tiny" data-slot-test="' + sl.k + '">试一下</button>' +
          '</div>';
      }

      /* ---- 阅读 ---- */
      html += '<h2 class="set-h">阅读</h2>' +
        '<div class="pref-row"><span>字号</span>' +
        '<input type="range" id="prefFont" min="15" max="30" step="1" value="' +
        esc(cfg['pref.font'] || '18') + '">' +
        '<b id="prefFontVal">' + esc(cfg['pref.font'] || '18') + '</b></div>' +

        '<div class="pref-row"><span>夜间模式</span>' +
        '<input type="checkbox" id="prefNight" class="switch"' +
        (cfg['pref.night'] === '1' ? ' checked' : '') + '>' +
        '<span class="muted">黑底米字，晚上看不刺眼</span></div>' +

        '<div class="pref-row"><span>朗读语速</span>' +
        '<input type="range" id="prefRate" min="6" max="14" step="1" value="' +
        esc(Math.round((Number(cfg['pref.rate']) || 0.95) * 10)) + '">' +
        '<b id="prefRateVal">' + (Number(cfg['pref.rate']) || 0.95).toFixed(1) + '×</b></div>';

      /* ---- 关于 ---- */
      html += '<h2 class="set-h">关于</h2>' +
        '<p class="hint">我的人生档案 · The Story of My Life<br>' +
        '数据全部存在这台设备上，不会上传到任何地方。<br>' +
        '只有你自己配了模型，生成时才会把章节标题发出去；照片只有在你点「看照片」时才会发。</p>';

      html += '</main>';
      app.innerHTML = html;

      bindSettings(profiles, slotMap);
    }).catch(fail);
  }

  function bindSettings(profiles, slotMap) {
    /* --- 添加 / 编辑 --- */
    var addBtn = document.getElementById('addProfile');
    if (addBtn) addBtn.onclick = function () {
      editing = null;
      showProfileForm({ kind: 'openai', base_url: KINDS[0].base, enabled: 1 });
    };

    if (settingsClickHandler) document.removeEventListener('click', settingsClickHandler);
    settingsClickHandler = function (ev) {
      var t;

      if ((t = ev.target.closest('[data-edit]'))) {
        var id = Number(t.getAttribute('data-edit'));
        for (var i = 0; i < profiles.length; i++) {
          if (profiles[i].id === id) {
            editing = profiles[i];
            showProfileForm(profiles[i]);
            return;
          }
        }
      }

      if ((t = ev.target.closest('[data-del]'))) {
        var did = Number(t.getAttribute('data-del'));
        if (!confirm('删掉这条配置？绑定了它的环节会自动清空。')) return;
        DB.deleteProfile(did).then(function () {
          toast('已删除');
          renderSettings();
        }).catch(fail);
        return;
      }

      if ((t = ev.target.closest('[data-toggle]'))) {
        var tid = Number(t.getAttribute('data-toggle'));
        var to = Number(t.getAttribute('data-to')) === 1;
        DB.toggleProfile(tid, to).then(function () {
          renderSettings();
        }).catch(fail);
        return;
      }

      if ((t = ev.target.closest('[data-test]'))) {
        var pid = Number(t.getAttribute('data-test'));
        // 本机模型一点测试就真的进内存，没独显的机器会卡很久，先说清楚
        if (t.getAttribute('data-local') === '1') {
          if (!confirm('这条是跑在本机的模型。\n点「确定」会让它加载进内存（7B 约 5–6GB），\n没有独立显卡时单次要 20–60 秒，机器会明显变卡。\n\n继续测试吗？')) return;
        }
        t.disabled = true;
        t.textContent = '测试中';
        DB.testProfile(pid).then(function (r) {
          if (r.ok) {
            var sec = (r.ms / 1000).toFixed(1) + 's';
            if (r.thinking) toast(r.model + ' · ' + sec + ' · 已响应（推理型）');
            else toast(r.model + ' · ' + sec + ' · 「' + (r.reply || '') + '」');
          } else {
            toast(r.message || '不通');
          }
          t.disabled = false;
          t.textContent = '测试';
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '测试'; });
        return;
      }

      if ((t = ev.target.closest('[data-pull]'))) {
        var lid = Number(t.getAttribute('data-pull'));
        t.disabled = true;
        t.textContent = '拉取中';
        DB.pullModels(lid).then(function (r) {
          if (r.ok) {
            toast('拉到 ' + r.count + ' 个模型');
            renderSettings();
          } else {
            toast(r.message || '拉不到');
            t.disabled = false;
            t.textContent = '拉模型';
          }
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '拉模型'; });
        return;
      }

      if ((t = ev.target.closest('[data-slot-test]'))) {
        var sk = t.getAttribute('data-slot-test');
        t.disabled = true;
        t.textContent = '试跑中';
        DB.testSlot(sk).then(function (r) {
          if (r.ok) {
            var sec2 = (r.ms / 1000).toFixed(1) + 's';
            toast(r.model + ' · ' + sec2 + (r.thinking ? ' · 已响应（推理型）' : ' · 通了'));
          } else {
            toast(r.message || '没配好');
          }
          t.disabled = false;
          t.textContent = '试一下';
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '试一下'; });
        return;
      }
    };
    document.addEventListener('click', settingsClickHandler);

    /* --- 用途绑定 --- */
    var rows = document.querySelectorAll('.slot-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var sel = row.querySelector('.slot-pick');
        sel.onchange = function () {
          var slot = row.getAttribute('data-slot');
          var pid = sel.value ? Number(sel.value) : null;
          DB.setSlot(slot, pid, null).then(function () {
            toast(pid ? '已绑定' : '已改为按规则');
          }).catch(fail);
        };
      })(rows[i]);
    }

    /* --- 阅读偏好 --- */
    var font = document.getElementById('prefFont');
    var fontVal = document.getElementById('prefFontVal');
    if (font) {
      font.oninput = function () {
        fontVal.textContent = font.value;
      };
      font.onchange = function () {
        DB.setPref('font', font.value).then(function () { toast('字号已保存'); }).catch(fail);
      };
    }

    var night = document.getElementById('prefNight');
    if (night) night.onchange = function () {
      DB.setPref('night', night.checked ? 1 : 0).then(function () {
        applyPrefs();
      }).catch(fail);
    };

    var rate = document.getElementById('prefRate');
    var rateVal = document.getElementById('prefRateVal');
    if (rate) {
      rate.oninput = function () {
        rateVal.textContent = (Number(rate.value) / 10).toFixed(1) + '×';
      };
      rate.onchange = function () {
        DB.setPref('rate', Number(rate.value) / 10).then(function () { toast('语速已保存'); }).catch(fail);
      };
    }
  }

  function showProfileForm(pf) {
    var box = document.getElementById('profileForm');
    if (!box) return;

    var isEdit = !!pf.id;
    var kindOpts = '';
    for (var i = 0; i < KINDS.length; i++) {
      kindOpts += '<option value="' + KINDS[i].k + '"' +
        ((pf.kind || 'openai') === KINDS[i].k ? ' selected' : '') + '>' + KINDS[i].label + '</option>';
    }

    var models = [];
    try { models = JSON.parse(pf.models_json || '[]'); } catch (e) { models = []; }
    var modelOpts = '<option value="">— 手填或先拉取 —</option>';
    for (var m = 0; m < models.length; m++) {
      modelOpts += '<option value="' + esc(models[m]) + '"' +
        (pf.default_model === models[m] ? ' selected' : '') + '>' + esc(models[m]) + '</option>';
    }

    box.innerHTML = '<div class="ai-form">' +
      '<div class="ai-form-title">' + (isEdit ? '改这条配置' : '新增一条配置') + '</div>' +
      '<p class="hint">一共就填四样：叫什么、接口地址、密钥、用哪个模型。改完点保存。</p>' +

      '<div class="fld"><label>名称</label>' +
      '<input id="pfName" value="' + esc(pf.name || '') + '" placeholder="比如：硅基流动 / 家里电脑的 Ollama">' +
      '<small>随便起，自己认得就行。</small></div>' +

      '<div class="fld"><label>类型</label>' +
      '<select id="pfKind">' + kindOpts + '</select>' +
      '<small>选一个会自动填好下面的接口地址，也可以自己改。</small></div>' +

      '<div class="fld"><label>接口地址（base_url）</label>' +
      '<input id="pfBase" value="' + esc(pf.base_url || '') + '" placeholder="https://api.siliconflow.cn/v1">' +
      '<small>服务商给的网址，一般到 <code>/v1</code> 为止，别带后面的 <code>/chat/completions</code>。</small></div>' +

      '<div class="fld"><label>密钥（API Key）</label>' +
      '<input id="pfKey" type="password" value="" placeholder="' +
      (isEdit && pf.api_key ? '已保存，留空表示不改' : 'sk-...') + '">' +
      '<small>在服务商后台「API 密钥」页面生成。只存在这台设备上，不会传出去。' +
      '跑在自己电脑上的 Ollama 不需要，留空即可。</small></div>' +

      '<div class="fld"><label>用哪个模型（模型 ID）</label>' +
      '<select id="pfModelSel">' + modelOpts + '</select>' +
      '<small>点上面的「拉模型」会把这家能用的模型全拉回来，在这里挑。' +
      (models.length ? '现在是 ' + models.length + ' 个可选。' : '') + '</small></div>' +

      '<div class="fld"><label>或者手填模型名</label>' +
      '<input id="pfModel" value="' + esc(pf.default_model || '') + '" placeholder="deepseek-chat">' +
      '<small>要和服务商写的<b>一模一样</b>，多了少了都调不通。' +
      '免费档常用：<code>tencent/Hunyuan-MT-7B</code>、<code>deepseek-ai/DeepSeek-OCR</code>、' +
      '<code>Qwen/Qwen3-ASR-1.7B</code></small></div>' +

      '<div class="row end">' +
      '<button class="btn tiny ghost" id="pfCancel">取消</button>' +
      '<button class="btn primary" id="pfSave">保存</button></div>' +
      '</div>';

    var kindSel = document.getElementById('pfKind');
    kindSel.onchange = function () {
      for (var i = 0; i < KINDS.length; i++) {
        if (KINDS[i].k === kindSel.value && KINDS[i].base) {
          document.getElementById('pfBase').value = KINDS[i].base;
        }
      }
    };

    var modelSel = document.getElementById('pfModelSel');
    modelSel.onchange = function () {
      if (modelSel.value) document.getElementById('pfModel').value = modelSel.value;
    };

    document.getElementById('pfCancel').onclick = function () { box.innerHTML = ''; };

    document.getElementById('pfSave').onclick = function () {
      var btn = this;
      btn.disabled = true;
      var keyVal = document.getElementById('pfKey').value;
      var payload = {
        id: pf.id || null,
        name: document.getElementById('pfName').value,
        kind: kindSel.value,
        base_url: document.getElementById('pfBase').value,
        api_key: keyVal ? keyVal : (pf.api_key || null),
        default_model: document.getElementById('pfModel').value.trim() || null,
        enabled: 1
      };
      DB.saveProfile(payload).then(function () {
        toast('已保存');
        box.innerHTML = '';
        renderSettings();
      }).catch(function (e) { fail(e); btn.disabled = false; });
    };

    box.scrollIntoView({ block: 'center' });
  }

  /** 阅读偏好落到 body，档案页的字号和夜间都靠它 */
  function applyPrefs() {
    DB.getPref('font', '18').then(function (f) {
      document.documentElement.style.setProperty('--fs', f + 'px');
      return DB.getPref('night', '0');
    }).then(function (n) {
      if (n === '1') document.body.className = 'night';
      else document.body.className = '';
    }).catch(function () {});
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

  function bindTtsOnce() {
    document.addEventListener('click', function (ev) {
      var t;
      if ((t = ev.target.closest('[data-read-all]'))) {
        var paper = document.querySelector('.paper');
        if (paper) window.TTS.speakFrom(paper);
        return;
      }
      if ((t = ev.target.closest('[data-read-ch]'))) {
        var sec = document.getElementById('ch-' + t.getAttribute('data-read-ch'));
        if (sec) window.TTS.speakFrom(sec);
      }
    });
  }

  function boot() {
    applyPrefs();   // 先把字号/夜间落到页面，避免闪一下
    bindTtsOnce();
    route();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.APP = { route: route, toast: toast };
})();
