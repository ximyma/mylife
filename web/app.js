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

        // 编辑态：整张卡变成表单
        if (isEdit('archive', a.id)) {
          cards += '<div class="arc-wrap"><div class="arc-card editing">' +
            '<div class="arc-edit-form">' +
            '<label>名字<input class="fi" id="ae-name" value="' + esc(a.subject_name) + '"></label>' +
            '<div class="ae-row">' +
            '<label>出生<input class="fi" id="ae-birth" type="number" value="' + esc(a.birth_year || '') + '"></label>' +
            '<label>离世<input class="fi" id="ae-death" type="number" value="' + esc(a.death_year || '') + '"></label>' +
            '</div>' +
            '<label>籍贯<input class="fi" id="ae-home" value="' + esc(a.hometown || '') + '"></label>' +
            '<label>封面一句话<input class="fi" id="ae-intro" value="' + esc(a.intro || '') + '"></label>' +
            (a.photo_list && a.photo_list.length
              ? '<label>封面照片<select class="fi" id="ae-cover">' +
                '<option value="">自动（第一张）</option>' +
                (function () {
                  var o = '';
                  for (var q = 0; q < a.photo_list.length; q++) {
                    o += '<option value="' + a.photo_list[q].id + '"' +
                      (String(a.cover_photo_id) === String(a.photo_list[q].id) ? ' selected' : '') + '>' +
                      esc(a.photo_list[q].taken_year + ' · ' + a.photo_list[q].event) + '</option>';
                  }
                  return o;
                })() + '</select></label>'
              : '') +
            '</div>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-arc-save="' + a.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button>' +
            '</div></div></div>';
          continue;
        }

        cards += '<div class="arc-wrap">' +
          '<a class="arc-card" href="#/a/' + a.id + '">' +
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
          '</div></a>' +
          '<div class="arc-tools">' +
          '<button class="arc-export" data-export="' + a.id + '" title="把这本档案连照片带录音存成一个文件">导出</button>' +
          '<button class="arc-export" data-arc-edit="' + a.id + '" title="改名字、生卒、封面">改</button>' +
          '<button class="arc-export danger-t" data-arc-del="' + a.id + '" title="整本删除，含照片和录音">删</button>' +
          '</div></div>';
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
        '</section>' +
        (list.length
          ? '<div class="row end"><label class="btn tiny ghost" id="importBtn">导入档案' +
            '<input type="file" id="importFile" accept=".json,application/json" hidden></label></div>'
          : '') +
        guide + '</main>';

      var nb = document.getElementById('newBtn');
      if (nb) nb.onclick = askNew;

      /* --- 导出 / 改 / 删 --- */
      var expHandler = function (ev) {
        var t = ev.target.closest ? ev.target : null;
        if (!t) return;
        var b;

        /* 导出 */
        if ((b = t.closest('[data-export]'))) {
          var aid = Number(b.getAttribute('data-export'));
          b.disabled = true;
          var old = b.textContent;
          b.textContent = '打包中…';
          DB.exportArchive(aid).then(function (pack) {
            var fname = '档案-' + (pack.archive.subject_name || aid) + '-' +
              new Date().toISOString().slice(0, 10) + '.mylife.json';
            b.disabled = false;
            b.textContent = old;
            if (window.NativeIO && window.NativeIO.saveExport) {
              var ok = window.NativeIO.saveExport(JSON.stringify(pack), fname);
              toast(ok ? '已存到手机 Download 目录' : '保存失败');
            } else {
              var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
              var a2 = document.createElement('a');
              a2.href = URL.createObjectURL(blob);
              a2.download = fname;
              document.body.appendChild(a2);
              a2.click();
              document.body.removeChild(a2);
              setTimeout(function () { URL.revokeObjectURL(a2.href); }, 2000);
              toast('已导出 ' + fname);
            }
          }).catch(function (e) {
            b.disabled = false;
            b.textContent = old;
            fail(e);
          });
          return;
        }

        /* 进入编辑 */
        if ((b = t.closest('[data-arc-edit]'))) {
          editState = { type: 'archive', id: Number(b.getAttribute('data-arc-edit')) };
          return route();
        }
        if ((b = t.closest('[data-edit-cancel]'))) {
          clearEdit();
          return route();
        }

        /* 保存编辑 */
        if ((b = t.closest('[data-arc-save]'))) {
          var sid = Number(b.getAttribute('data-arc-save'));
          var g = function (sel) {
            var el = document.getElementById(sel);
            return el ? el.value : '';
          };
          DB.updateArchive(sid, {
            name: g('ae-name'), birth: g('ae-birth') || null, death: g('ae-death') || null,
            hometown: g('ae-home'), intro: g('ae-intro'),
            cover_photo_id: g('ae-cover') || null,
          }).then(function () {
            clearEdit();
            toast('改好了');
            route();
          }).catch(fail);
          return;
        }

        /* 删除整本：话要说得足够重 */
        if ((b = t.closest('[data-arc-del]'))) {
          var did = Number(b.getAttribute('data-arc-del'));
          var card = null;
          for (var li = 0; li < list.length; li++) if (list[li].id === did) card = list[li];
          if (!card) return;
          var warn = '整本删除「' + card.subject_name + '」？\n\n' +
            '包含 ' + card.chapter_count + ' 章、' + card.entry_count + ' 条内容、' +
            card.photo_count + ' 张照片，照片和录音的文件也一起删掉。\n删了就找不回来了。';
          if (!confirm(warn)) return;
          DB.deleteArchive(did).then(function () {
            toast('已删除整本档案');
            route();
          }).catch(fail);
          return;
        }
      };
      if (homeClickHandler) app.removeEventListener('click', homeClickHandler);
      homeClickHandler = expHandler;
      app.addEventListener('click', homeClickHandler);

      /* --- 导入：选文件 → 解析 → 入库 → 跳过去看 --- */
      var fin = document.getElementById('importFile');
      if (fin) fin.onchange = function () {
        var f = fin.files && fin.files[0];
        if (!f) return;
        if (f.size > 200 * 1024 * 1024) return toast('这个文件超过 200MB，先删掉一些再导');
        var reader = new FileReader();
        reader.onload = function () {
          var pack;
          try { pack = JSON.parse(String(reader.result)); }
          catch (e) { return toast('文件读不出来，不是完整的导出文件'); }
          toast('正在导入……');
          DB.importArchive(pack).then(function (r) {
            toast('导入完成，去验收');
            go('#/a/' + r.archiveId);
          }).catch(fail);
        };
        reader.readAsText(f);
      };
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
      if ((b = t.closest('[data-entry-upload]'))) {
        var ch = b.getAttribute('data-ch');
        uploadToEntry(id, ch ? Number(ch) : null, route);
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

  /**
   * 「传」的公共流程：选图片/视频/录音 → 存盘 → 记 media → 插一条媒体条目。
   * 图片压到 1600px 再存，视频录音原样收（上限 80MB）。
   */
  function uploadToEntry(aid, chapterId, done) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*,video/*,audio/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var kind = /^image/.test(f.type) ? 'photo'
        : /^video/.test(f.type) ? 'video'
        : /^audio/.test(f.type) ? 'audio' : null;
      if (!kind) return toast('只能传图片、视频或录音');

      if (kind === 'photo') {
        compress(f, function (dataUrl) {
          DB.addMediaEntry(aid, chapterId, 'photo', dataUrl, 'image/jpeg', f.name, 'jpg')
            .then(function () { toast('传好了'); done(); }).catch(fail);
        });
        return;
      }
      if (f.size > 80 * 1024 * 1024) return toast('超过 80MB，传不动，换小一点的');
      var reader = new FileReader();
      reader.onload = function () {
        var ext = (f.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
        DB.addMediaEntry(aid, chapterId, kind, String(reader.result), f.type, f.name, ext)
          .then(function () { toast('传好了，正在排进档案'); done(); }).catch(fail);
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function renderEntry(e) {    if (e.kind === 'photo') {
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
    // 文字条目：可就地改，可删，还能往后面传图片/视频/录音
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
      '<button class="linkbtn" data-entry-upload="' + e.id + '" data-ch="' +
        (e.chapter_id || '') + '">传</button>' +
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
          '<button class="btn tiny" data-seg-upload="' + s.id + '">传</button>' +
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
      // AudioContext 必须在点击手势里创建并确认运行——
      // 在 getUserMedia 回调里才创建的话，Chrome 会把它挂起：
      // 回调照常触发、文件照常生成，但里面全是接近全零的低频噪声，
      // 转写服务返回空，界面上就成了"录音是空的"。
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      var kick = (ctx.state === 'suspended') ? ctx.resume() : Promise.resolve();
      kick.then(function () {
        return navigator.mediaDevices.getUserMedia({ audio: true });
      }).then(function (stream) {
        rec.chunks = [];
        rec.path = '';
        rec.started = Date.now();
        rec.peak = 0;                 // 全程最大瞬时音量，停的时候用来判断"到底录没录上"
        var src = ctx.createMediaStreamSource(stream);
        var proc = ctx.createScriptProcessor(4096, 1, 1);
        var mute = ctx.createGain();  // 采到的声音不能外放出去（会啸叫），接个零增益
        mute.gain.value = 0;
        proc.onaudioprocess = function (e) {
          if (!recording) return;
          var d = e.inputBuffer.getChannelData(0);
          rec.chunks.push(new Float32Array(d));
          // 实时算峰值，让用户看得见"有没有录上"
          var pk = 0;
          for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
          if (pk > rec.peak) rec.peak = pk;
          var db = pk > 0 ? Math.round(20 * Math.log(pk) / Math.LN10 * 10) / 10 : -99;
          recState.textContent = '正在听… 音量 ' + db + ' dB' +
            (pk < 0.01 ? '（几乎没有声音，检查麦克风）' : '');
          // 12 分钟上限：WAV 到 25MB 附近，转写服务就不收了
          if (rec.chunks.length * 4096 / ctx.sampleRate > 720) stopRec();
        };
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);   // ScriptProcessor 必须接到输出才会跑
        rec.ctx = ctx; rec.src = src; rec.proc = proc; rec.stream = stream; rec.mute = mute;

        recording = true;
        recBtn.className = 'btn rec-btn on';
        recBtn.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>';
        recState.textContent = ctx.state === 'running'
          ? '正在听……'
          : '音频通道没就绪（' + ctx.state + '），重试一次';
      }).catch(function (e) {
        recState.textContent = '没有拿到麦克风权限，可以直接打字';
      });
    }

    /** 采到的浮点 PCM 合并、降采样到 16k、打成 16bit 单声道 WAV */
    function buildWav(chunks, srcRate, targetRate) {
      var total = 0, i;
      for (i = 0; i < chunks.length; i++) total += chunks[i].length;
      var merged = new Float32Array(total);
      var off = 0;
      for (i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }

      var ratio = srcRate / targetRate;
      var n = Math.floor(total / ratio);
      var pcm = new Int16Array(n);
      for (i = 0; i < n; i++) {
        var v = merged[Math.floor(i * ratio)];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }

      var buf = new ArrayBuffer(44 + n * 2);
      var dv = new DataView(buf);
      function wstr(o, s) { for (var k = 0; k < s.length; k++) dv.setUint8(o + k, s.charCodeAt(k)); }
      wstr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true);
      wstr(8, 'WAVE'); wstr(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, targetRate, true); dv.setUint32(28, targetRate * 2, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wstr(36, 'data'); dv.setUint32(40, n * 2, true);
      new Int16Array(buf, 44).set(pcm);
      return buf;
    }

    function stopRec() {
      if (!recording) return;
      recording = false;
      try { if (rec.proc) rec.proc.disconnect(); } catch (e) {}
      try { if (rec.src) rec.src.disconnect(); } catch (e) {}
      try { if (rec.mute) rec.mute.disconnect(); } catch (e) {}
      try { if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (rec.ctx) rec.ctx.close(); } catch (e) {}

      // 全程峰值都接近零＝根本没录上声音，别浪费一次转写
      if (rec.peak < 0.01) {
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
        recState.textContent = '这段全是静音。到系统设置里确认麦克风设备可用、音量没被拉到 0，再录一次';
        return;
      }

      var rate = rec.ctx ? rec.ctx.sampleRate : 48000;
      var buf = buildWav(rec.chunks, rate, 16000);
      var bytes = new Uint8Array(buf);
      // 一段段拼 base64，直接 apply 几 MB 会爆栈
      var bin = '', CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      var b64 = btoa(bin);
      var name = 'seg-' + id + '-' + rec.started + '.wav';
      var sec = Math.round((Date.now() - rec.started) / 1000);

      recState.textContent = '正在保存录音…';
      API.file({ op: 'save', kind: 'audio', name: name, base64: b64 }).then(function (r) {
        if (r && r.path) rec.path = r.path;
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
        recState.textContent = '录好了 ' + sec + ' 秒 · 记得点「存为一条讲述」';
      }).catch(function () {
        recState.textContent = '录音保存失败，重录一次试试';
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
      });
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
      /* 采集页的「传」：媒体先进待归档，生成档案时归位 */
      if ((b = t.closest('[data-seg-upload]'))) {
        uploadToEntry(id, null, function () {
          toast('传好了，生成档案时会排进卷宗');
          route();
        });
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
  var homeClickHandler = null;       // 同上，首页的导出

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
        '<dt>图片生成</dt><dd><code>Kwai-Kolors/Kolors</code> <span class="muted">免费，功能接入前可先配好</span></dd>' +
        '<dt>视频生成</dt><dd><code>Wan-AI/Wan2.2-T2V-A14B</code> 等 <span class="warn-text">很贵，一条几块钱起，慎重</span></dd>' +
        '</dl>' +
        '<p class="hint dim">想让程序真正「看懂」照片场景而不只是认字，' +
        '可以去智谱开个号用 <code>GLM-4.6V-Flash</code>，那是免费的多模态模型。' +
        '视频生成模型普遍较贵，等功能接入再配不迟。</p>';

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

      // 五个环节。kind 决定模型下拉只列哪一类；rec 是一个 Key 就自动配好的推荐款。
      // img/vid 是给接下来的图片生成、视频生成功能预留的，功能上线前先配好不耽误事
      var SLOTS = [
        { k: 'title', label: '起章名 / 写简介', kind: 'text',
          rec: ['tencent/Hunyuan-MT-7B', 'Qwen/Qwen3-8B'],
          hint: '要一点文笔。填好 Key 会自动配好，不用动' },
        { k: 'vision', label: '看照片', kind: 'vision',
          rec: ['deepseek-ai/DeepSeek-OCR'],
          hint: '认老照片上的字和场景，必须用看图的模型' },
        { k: 'asr', label: '语音转文字', kind: 'asr',
          rec: ['Qwen/Qwen3-ASR-1.7B', 'FunAudioLLM/SenseVoiceSmall'],
          hint: '录音转文字，必须用语音模型' },
        { k: 'img', label: '图片生成（预留）', kind: 't2i',
          rec: ['Kwai-Kolors/Kolors'],
          hint: '文生图，功能快来了，先配好备用。Kolors 免费' },
        { k: 'vid', label: '视频生成（预留）', kind: 't2v',
          rec: ['Wan-AI/Wan2.2-T2V-A14B'],
          hint: '文生视频，普遍很贵（一条几块钱起）。功能接入前配好备用即可，不配不影响其它功能' }
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

        // 模型下拉只列这一环节用得上的：给"看照片"选模型时，
        // 纯文本模型压根不该出现在列表里——选了也调不通。
        var slotModels = [];
        var seen = {};
        function pushModel(id) {
          if (!id || seen[id]) return;
          seen[id] = 1;
          slotModels.push(id);
        }
        // 绑定的那条配置里拉到过的模型优先
        if (bound.profile_id) {
          for (var q2 = 0; q2 < profiles.length; q2++) {
            if (String(profiles[q2].id) === String(bound.profile_id)) {
              var ml = [];
              try { ml = JSON.parse(profiles[q2].models_json || '[]'); } catch (e) {}
              for (var m1 = 0; m1 < ml.length; m1++) {
                if (DB.modelKind(ml[m1]) === sl.kind) pushModel(ml[m1]);
              }
            }
          }
        }
        // 兜底：把所有配置里同类的模型也列上，跨家换着用不用来回改
        for (var q3 = 0; q3 < profiles.length; q3++) {
          var ml2 = [];
          try { ml2 = JSON.parse(profiles[q3].models_json || '[]'); } catch (e2) {}
          for (var m2 = 0; m2 < ml2.length; m2++) {
            if (DB.modelKind(ml2[m2]) === sl.kind) pushModel(ml2[m2]);
          }
        }
        // 连拉都没拉过：把写死的推荐款摆出来，照抄也能用
        if (!slotModels.length && sl.rec) {
          for (var r = 0; r < sl.rec.length; r++) pushModel(sl.rec[r]);
        }

        var mopts = '<option value="">' +
          (bound.model ? '当前：' + esc(bound.model) : '自动（用默认）') + '</option>';
        for (var m3 = 0; m3 < slotModels.length; m3++) {
          var mid = slotModels[m3];
          mopts += '<option value="' + esc(mid) + '"' +
            (bound.model === mid ? ' selected' : '') + '>' +
            esc(mid) + (DB.isFreeModel(mid) ? ' · 免费' : ' · 付费') + '</option>';
        }

        html += '<div class="slot-row" data-slot="' + sl.k + '">' +
          '<div class="slot-label"><b>' + esc(sl.label) + '</b>' +
          // 正在用什么模型，直接摆在明面上，不用去下拉里翻
          (bound.model
            ? '<small class="slot-now">当前：<code>' + esc(bound.model) + '</code>' +
              (DB.isFreeModel(bound.model) ? '（免费）' : '（<b>付费</b>）') + '</small>'
            : '') +
          '<small>' + esc(sl.hint) + '</small></div>' +
          '<select class="slot-pick">' + opts + '</select>' +
          '<select class="slot-model">' + mopts + '</select>' +
          (sl.k === 'title' || sl.k === 'vision' || sl.k === 'asr'
            ? '<button class="btn tiny" data-slot-test="' + sl.k + '">试一下</button>'
            : '') +
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
            // 拉完顺手把空着的环节配好——有了 Key 就不用再选
            DB.autoSetupSlots(lid).then(function (done) {
              if (done.length) {
                toast('拉到 ' + r.count + ' 个模型，并已自动配好 ' + done.length + ' 个环节');
              } else {
                toast('拉到 ' + r.count + ' 个模型');
              }
              renderSettings();
            });
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

    /* --- 用途绑定：换配置、换模型都会立即落库 --- */
    var rows = document.querySelectorAll('.slot-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var sel = row.querySelector('.slot-pick');
        var msel = row.querySelector('.slot-model');
        function slot() { return row.getAttribute('data-slot'); }

        sel.onchange = function () {
          var pid = sel.value ? Number(sel.value) : null;
          DB.setSlot(slot(), pid, null).then(function () {
            toast(pid ? '已绑定' : '已改为按规则');
            renderSettings();   // 重画：模型下拉要跟着换一家重列
          }).catch(fail);
        };
        msel.onchange = function () {
          var pid = sel.value ? Number(sel.value) : null;
          DB.setSlot(slot(), pid, msel.value || null).then(function () {
            toast(msel.value ? '已改用 ' + msel.value : '已恢复自动');
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
      DB.saveProfile(payload).then(function (r) {
        box.innerHTML = '';
        var newId = payload.id || (r && r.lastId);
        // 保存完顺手拉一次模型清单、把空着的环节配好——
        // 用户填一个 Key 点保存，就什么都不用再弄了
        if (newId) {
          toast('已保存，正在读模型清单…');
          DB.pullModels(newId).then(function (pr) {
            if (!pr.ok) { toast('已保存，但拉不到模型：' + (pr.message || '')); return renderSettings(); }
            return DB.autoSetupSlots(newId).then(function (done) {
              toast(done.length ? '已保存，并自动配好 ' + done.length + ' 个环节' : '已保存');
              renderSettings();
            });
          }).catch(function () { renderSettings(); });
        } else {
          toast('已保存');
          renderSettings();
        }
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
