/**
 * 时间轴：把四类内容（条目 / 讲述 / 照片 / 视频录音）按年份摆到一条线上。
 *
 * 为什么要它：原来只有「第几章第几条」，想补一件 1962 年的事，只能塞到某章末尾，
 * 位置就错了。这条线是「内容的时间坐标」，章节是「内容的叙事结构」，两回事。
 */
(function () {
  'use strict';

  var ML = window.ML || {};
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fsrc(p) { return ML.fsrc ? ML.fsrc(p) : ('/files/' + p); }
  function toast(m) { if (ML.toast) ML.toast(m); }
  function go(h) { if (ML.go) ML.go(h); }

  var KIND = {
    entry: { n: '文字', c: 'k-txt' },
    segment: { n: '讲述', c: 'k-say' },
    photo: { n: '照片', c: 'k-pho' },
    media: { n: '媒体', c: 'k-med' },
  };

  function dateLabel(it) {
    if (!it.at_year) return '年份待定';
    var s = String(it.at_year) + ' 年';
    if (it.at_month) s += String(it.at_month) + ' 月';
    if (it.at_day) s += String(it.at_day) + ' 日';
    if (!it.at_month && it.at_label) s += ' · ' + it.at_label;
    return s;
  }

  function render(host, archiveId) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      DB.timeline(archiveId),
      DB.listPhotos(archiveId)
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], items = r[2], photos = r[3];
      if (!a) throw new Error('找不到这本档案');
      var photoById = {};
      for (var pi = 0; pi < photos.length; pi++) photoById[photos[pi].id] = photos[pi];

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, right: [{ href: '#/a/' + archiveId + '/collect', text: '补内容' }] }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">时间轴</h1>' +
        '<p class="muted">' + esc(a.subject_name) + ' · 一共 ' + items.length + ' 条内容。想到哪年的事，就插到哪年。</p>' +
        '<div class="tl-acts"><button class="btn primary" id="tlAdd">＋ 插入内容</button>' +
        '<button class="btn" id="tlBook">看整本</button></div></section>' +
        '<section id="tlList"></section></main>';

      var list = host.querySelector('#tlList');
      if (!items.length) {
        list.innerHTML = '<div class="empty-guide">' +
          '<h2>还没有内容</h2><p>先去「补内容」说一段，或者直接插入一条。</p></div>';
      } else {
        var groups = [], cur = null;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var key = it.at_year ? String(it.at_year) : '';
          if (!cur || cur.key !== key) { cur = { key: key, year: it.at_year, items: [] }; groups.push(cur); }
          cur.items.push(it);
        }
        var html = '';
        for (var g = 0; g < groups.length; g++) {
          var grp = groups[g];
          html += '<div class="tl-year">' +
            '<div class="tl-y"><span>' + (grp.year || '待定') + '</span>' +
            (grp.year ? '<em>年</em>' : '') + '</div><div class="tl-items">';
          for (var k = 0; k < grp.items.length; k++) {
            html += itemHtml(grp.items[k], photoById);
          }
          html += '</div></div>';
        }
        list.innerHTML = html;
      }

      list.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t.closest) return;
        var del = t.closest('[data-tl-del]');
        if (del) {
          var kind = del.getAttribute('data-kind'), id = Number(del.getAttribute('data-tl-del'));
          if (!window.confirm('删掉这条内容？原文和附件都会清掉。')) return;
          var p = kind === 'photo' ? DB.deletePhotoSafe(id)
            : kind === 'media' ? DB.deleteMediaEntry(id)
              : kind === 'entry' ? DB.deleteEntry(id)
                : Promise.reject(new Error('讲述请到「补内容」页处理'));
          p.then(function () { toast('已删除'); render(host, archiveId); })
            .catch(function (e) { toast(e.message || '删除失败'); });
          return;
        }
        var mv = t.closest('[data-tl-move]');
        if (mv) {
          DB.moveEntry(Number(mv.getAttribute('data-tl-move')), Number(mv.getAttribute('data-dir')))
            .then(function (r) { if (!r || !r.moved) toast('已经到头了'); render(host, archiveId); })
            .catch(function (e) { toast(e.message || '移不动'); });
        }
      });

      host.querySelector('#tlAdd').addEventListener('click', function () {
        openInsert(archiveId, a, chapters, function () { render(host, archiveId); });
      });
      host.querySelector('#tlBook').addEventListener('click', function () {
        go('#/a/' + archiveId);
      });
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '打不开时间轴') + '</div></main>';
    });
  }

  function itemHtml(it, photoById) {
    var meta = KIND[it.kind] || KIND.entry;
    var body;
    if (it.kind === 'photo') {
      var p = photoById[it.id];
      body = (p ? '<img class="tl-thumb" src="' + esc(fsrc(p.path)) + '" alt="" loading="lazy">' : '') +
        '<div class="tl-cap">' + esc(it.preview || '照片') + '</div>';
    } else if (it.kind === 'media') {
      body = '<div class="tl-cap">▸ ' + esc(it.preview || '音视频') + '</div>';
    } else {
      body = esc(it.preview || '');
    }
    var ops = '';
    if (it.kind === 'entry') {
      ops += '<button class="linkbtn" data-tl-move="' + it.id + '" data-dir="-1" title="上移">↑</button>' +
        '<button class="linkbtn" data-tl-move="' + it.id + '" data-dir="1" title="下移">↓</button>';
    }
    ops += '<button class="linkbtn danger-t" data-tl-del="' + it.id + '" data-kind="' + it.kind + '">删</button>';
    return '<div class="tl-item">' +
      '<div class="tl-when"><span class="tl-badge ' + meta.c + '">' + meta.n + '</span>' +
      '<span class="tl-date">' + esc(dateLabel(it)) + '</span></div>' +
      '<div class="tl-body">' + body + '</div>' +
      '<div class="tl-ops">' + ops + '</div></div>';
  }

  /* ---------------- 插入抽屉 ---------------- */

  function openInsert(archiveId, a, chapters, done) {
    var back = document.createElement('div');
    back.className = 'sheet-back';
    var nowYear = new Date().getFullYear();
    var chips = '';
    for (var i = 0; i < chapters.length; i++) {
      if (chapters[i].year_from) {
        chips += '<button class="chip" data-year="' + chapters[i].year_from + '">' + chapters[i].year_from + '</button>';
      }
    }
    if (!chips) chips = '<button class="chip" data-year="' + (a.birth_year || nowYear) + '">' + (a.birth_year || nowYear) + '</button>';

    back.innerHTML = '<div class="sheet">' +
      '<div class="sheet-hd"><b>插入一条内容</b><button class="sheet-x" data-ins-close="1">✕</button></div>' +
      '<div class="sheet-bd">' +
      '<label class="fi-l">这是哪一年的事<small>记不清具体日子就只填年份，写「一九六二年开春」这种也行</small>' +
      '<input class="fi" id="insYear" type="number" inputmode="numeric" placeholder="1962" value="' +
      esc(a.birth_year || '') + '"></label>' +
      '<div class="cw-chips" id="insChips">' + chips + '</div>' +
      '<div class="ae-row"><label class="fi-l">月<input class="fi" id="insMonth" type="number" min="1" max="12" placeholder="可不填"></label>' +
      '<label class="fi-l">日<input class="fi" id="insDay" type="number" min="1" max="31" placeholder="可不填"></label></div>' +
      '<label class="fi-l">说不清的日子<small>原话照录，比如「麦收前后」</small>' +
      '<input class="fi" id="insLabel" placeholder="可不填"></label>' +
      '<div class="cw-label">类型</div>' +
      '<div class="cw-chips" id="insKinds">' +
      '<button class="chip on" data-kind="text">文字</button>' +
      '<button class="chip" data-kind="photo">图片</button>' +
      '<button class="chip" data-kind="audio">音频</button>' +
      '<button class="chip" data-kind="video">视频</button></div>' +
      '<label class="fi-l" id="insFileWrap" style="display:none">选文件<input type="file" id="insFile"></label>' +
      '<label class="fi-l">内容<small id="insHint">写一段话；带图的话这句会变成图注</small>' +
      '<textarea class="say mini" id="insText" rows="4" placeholder="那天……"></textarea></label>' +
      '</div>' +
      '<div class="sheet-ft"><button class="btn" data-ins-close="1">取消</button>' +
      '<button class="btn primary" id="insSave">存进去</button></div></div>';
    document.body.appendChild(back);

    var kind = 'text';
    var fileData = null, fileExt = null, fileMime = null;

    back.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      if (t.closest('[data-ins-close]')) { back.remove(); return; }
      var yb = t.closest('[data-year]');
      if (yb) { back.querySelector('#insYear').value = yb.getAttribute('data-year'); return; }
      var kb = t.closest('[data-kind]');
      if (kb) {
        kind = kb.getAttribute('data-kind');
        var all = back.querySelectorAll('[data-kind]');
        for (var i = 0; i < all.length; i++) all[i].className = 'chip' + (all[i] === kb ? ' on' : '');
        back.querySelector('#insFileWrap').style.display = kind === 'text' ? 'none' : 'block';
        back.querySelector('#insHint').textContent = kind === 'text' ? '写一段话' : '这句话会作为图注/说明';
        if (kind !== 'text') back.querySelector('#insFile').setAttribute('accept', kind === 'photo' ? 'image/*' : (kind === 'audio' ? 'audio/*' : 'video/*'));
      }
    });

    back.querySelector('#insFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      fileMime = f.type || null;
      var m = /\.([a-z0-9]+)$/i.exec(f.name || '');
      fileExt = m ? m[1].toLowerCase() : (kind === 'photo' ? 'jpg' : (kind === 'audio' ? 'wav' : 'mp4'));
      var fr = new FileReader();
      fr.onload = function () { fileData = String(fr.result || ''); };
      fr.readAsDataURL(f);
    });

    back.querySelector('#insSave').addEventListener('click', function () {
      var btn = this;
      var year = Number(back.querySelector('#insYear').value) || null;
      var month = Number(back.querySelector('#insMonth').value) || null;
      var day = Number(back.querySelector('#insDay').value) || null;
      var label = back.querySelector('#insLabel').value || null;
      var text = back.querySelector('#insText').value || '';

      if (!year) { toast('先填哪一年'); return; }
      if (kind === 'text' && !text.trim()) { toast('写点什么再存'); return; }
      if (kind !== 'text' && !fileData) { toast('还没选文件'); return; }

      btn.disabled = true;
      DB.insertAt({
        archiveId: archiveId, year: year, month: month, day: day, label: label,
        kind: kind, text: text, dataUrl: fileData, ext: fileExt, mime: fileMime,
      }).then(function () {
        back.remove();
        toast('已插到 ' + year + ' 年');
        if (done) done();
      }).catch(function (e) {
        btn.disabled = false;
        toast(e.message || '没存上');
      });
    });
  }

  window.TimelineUI = { render: render };
})();
