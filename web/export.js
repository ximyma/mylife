/**
 * 导出：一条档案 → 一份「与格式无关的文档模型」→ 印刷版 HTML / PDF / Word / PPT。
 *
 * 为什么先做「文档模型」而不是直接拼 HTML：
 *   四种产物的分页规则完全不同（CSS 分页 / Chrome 打印 / Word 分页符 / 幻灯片整页），
 *   但「哪一章有哪些块、每块是什么」是同一件事。各写一套，改一处要改四处。
 *
 * 这一层刻意用 ES5：安卓 5/6 的 WebView 里也要能跑。
 */
(function () {
  'use strict';

  var ML = window.ML || {};

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fsrc(p) {
    if (ML.fsrc) return ML.fsrc(p);
    var t = (window.API && API.auth && API.auth.token) ? (API.auth.token() || '') : '';
    return '/files/' + String(p || '').replace(/^\/+/, '') + (t ? '?token=' + encodeURIComponent(t) : '');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function today() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function years(a) {
    if (!a.birth_year) return '';
    if (a.death_year && a.death_year !== a.birth_year) return a.birth_year + '—' + a.death_year;
    return a.birth_year + '—';
  }

  /* ================= 文档模型 ================= */

  function model(archiveId) {
    return Promise.all([
      DB.getArchive(archiveId),
      API.query('SELECT * FROM media WHERE archive_id=?', [archiveId]),
    ]).then(function (r) {
      var d = r[0], media = r[1];
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var photoById = {}, mediaById = {};
      var i;
      for (i = 0; i < d.photos.length; i++) photoById[d.photos[i].id] = d.photos[i];
      for (i = 0; i < media.length; i++) mediaById[media[i].id] = media[i];

      var cfg = DB.coverConfig(a);

      // 哪些照片已经被条目引用（照片条目 / 文字配图），用于最后补「没被引用的照片」
      var usedPhoto = {};

      function photoBlockOf(p, caption) {
        return { type: 'photo', path: p.path, year: p.taken_year, place: p.place || '',
          caption: caption || p.event || '' };
      }

      function blockOf(e) {
        if (e.kind === 'photo') {
          var p = photoById[e.photo_id];
          if (!p) return null;
          usedPhoto[p.id] = 1;
          return photoBlockOf(p, e.text);
        }
        if (e.kind === 'media') {
          var m = mediaById[e.media_id];
          if (!m) return null;
          return { type: m.kind === 'audio' ? 'audio' : (m.kind === 'video' ? 'video' : 'photo'),
            path: m.path, poster: m.poster || null, caption: e.text || m.caption || '' };
        }
        if (e.kind === 'quote') return { type: 'quote', text: e.text || '' };
        return { type: 'text', text: e.text || '' };
      }

      // 已经被「配到某段文字」的照片集合：这类照片在导出里跟着文字出现，
      // 就不再作为独立照片条目重复出现（同一张照片只出一次）。
      var pairedPhoto = {};
      for (i = 0; i < d.entries.length; i++) {
        var pe0 = d.entries[i];
        if ((pe0.kind === 'text' || pe0.kind === 'quote') && pe0.photo_id) pairedPhoto[pe0.photo_id] = 1;
      }

      var byChapter = {}, orphans = [];
      for (i = 0; i < d.entries.length; i++) {
        var e = d.entries[i];
        if (e.kind === 'photo' && e.photo_id && pairedPhoto[e.photo_id]) { usedPhoto[e.photo_id] = 1; continue; }
        var b = blockOf(e);
        if (!b) continue;
        if (e.chapter_id) {
          if (!byChapter[e.chapter_id]) byChapter[e.chapter_id] = [];
          byChapter[e.chapter_id].push({ block: b, e: e });
        } else {
          orphans.push({ block: b, e: e });
        }
        // 文字/引用配了图：图紧跟在文字后面（图文一体，排序跟着段落走）
        if ((e.kind === 'text' || e.kind === 'quote') && e.photo_id && photoById[e.photo_id]) {
          var pp = photoById[e.photo_id];
          usedPhoto[pp.id] = 1;
          var keyBase = Number(e.sort_key || e.seq || 0);
          var paired = { block: photoBlockOf(pp, ''), e: { sort_key: keyBase + 0.5, seq: e.seq, id: e.id } };
          if (e.chapter_id) byChapter[e.chapter_id].push(paired);
          else orphans.push(paired);
        }
      }

      function sortItems(list) {
        list.sort(function (x, y) {
          var kx = Number(x.e.sort_key || x.e.seq || 0), ky = Number(y.e.sort_key || y.e.seq || 0);
          if (kx !== ky) return kx - ky;
          return Number(x.e.id) - Number(y.e.id);
        });
        return list;
      }

      var chapters = [];
      for (i = 0; i < d.chapters.length; i++) {
        var c = d.chapters[i];
        var items = sortItems(byChapter[c.id] || []);
        chapters.push({
          id: c.id,
          seq: i + 1,
          title: String(c.title || '').replace(/^[^·]*·\s*/, ''),
          fullTitle: c.title || '',
          years: c.year_from ? (c.year_to && c.year_to !== c.year_from ? c.year_from + '—' + c.year_to : String(c.year_from)) : '',
          stage: c.stage || '',
          quote: c.quote || '',
          summary: c.summary || '',
          blocks: items.map(function (x) { return x.block; }),
        });
      }
      if (orphans.length) {
        chapters.push({
          id: 0, seq: chapters.length + 1, title: '待归档', fullTitle: '待归档',
          years: '', stage: '', quote: '', summary: '',
          blocks: sortItems(orphans).map(function (x) { return x.block; }),
        });
      }

      // 上传了但没被任何条目引用的照片，按各自的 chapter_id 归到对应章（年份排序）；
      // 归不进去的并成一本「影像」放最后。上传多少张就导出多少张，不再出现"7 张只进 2 张"。
      function unusedFor(chId) {
        var arr = [];
        for (var k = 0; k < d.photos.length; k++) {
          var p = d.photos[k];
          if (usedPhoto[p.id]) continue;
          if (String(p.chapter_id || '') !== String(chId || '')) continue;
          arr.push(p);
        }
        arr.sort(function (x, y) {
          return (Number(x.taken_year || 0) - Number(y.taken_year || 0)) || (Number(x.id) - Number(y.id));
        });
        for (var m = 0; m < arr.length; m++) usedPhoto[arr[m].id] = 1;
        return arr;
      }
      for (i = 0; i < chapters.length; i++) {
        var extra = unusedFor(chapters[i].id);
        for (var ei2 = 0; ei2 < extra.length; ei2++) chapters[i].blocks.push(photoBlockOf(extra[ei2], ''));
      }
      var restPhotos = [];
      for (var rp = 0; rp < d.photos.length; rp++) {
        if (!usedPhoto[d.photos[rp].id]) restPhotos.push(d.photos[rp]);
      }
      restPhotos.sort(function (x, y) {
        return (Number(x.taken_year || 0) - Number(y.taken_year || 0)) || (Number(x.id) - Number(y.id));
      });
      if (restPhotos.length) {
        var restBlocks = [];
        for (var rp2 = 0; rp2 < restPhotos.length; rp2++) {
          usedPhoto[restPhotos[rp2].id] = 1;
          restBlocks.push(photoBlockOf(restPhotos[rp2], ''));
        }
        chapters.push({
          id: 0, seq: chapters.length + 1, title: '影像', fullTitle: '影像',
          years: '', stage: '', quote: '', summary: '', blocks: restBlocks,
        });
      }

      var wordCount = 0, photoCount = 0;
      for (i = 0; i < chapters.length; i++) {
        for (var j = 0; j < chapters[i].blocks.length; j++) {
          var bb = chapters[i].blocks[j];
          if (bb.text) wordCount += String(bb.text).replace(/\s/g, '').length;
          if (bb.type === 'photo' || bb.type === 'video') photoCount++;
        }
      }

      return {
        meta: {
          title: a.subject_name,
          years: years(a),
          archiveNo: a.archive_no || '',
          hometown: a.hometown || '',
          intro: a.intro || '',
          birth: a.birth_year || null,
          death: a.death_year || null,
          generatedAt: new Date().toISOString().slice(0, 10),
          chapters: chapters.length,
          words: wordCount,
          photos: photoCount,
        },
        cover: {
          style: cfg.style, font: cfg.font, accent: cfg.accent, pos: cfg.pos, zoom: cfg.zoom,
          path: (photoById[a.cover_photo_id] || {}).path || (d.photos[0] || {}).path || null,
          portrait: (photoById[a.portrait_photo_id] || {}).path || null,
        },
        chapters: chapters,
      };
    });
  }

  /* ================= 图片取用 ================= */

  /** 读成 dataURL 并等比缩到 maxPx（打印 150dpi 够用，能省一半内存） */
  function imageData(path, maxPx) {
    return API.file({ op: 'read', path: path }).then(function (f) {
      if (!f || !f.base64) return null;
      // 按文件头判断真实类型，别一律当 jpeg（PNG 标错 MIME，某些环境会解不出来）
      var mime = 'image/jpeg';
      var head = String(f.base64).slice(0, 12);
      if (head.indexOf('iVBORw0KGgo') === 0) mime = 'image/png';
      else if (head.indexOf('R0lGOD') === 0) mime = 'image/gif';
      else if (head.indexOf('UklGR') === 0) mime = 'image/webp';
      var src = 'data:' + mime + ';base64,' + f.base64;
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var w = img.width || 1, h = img.height || 1;
          var limit = maxPx || 1200;
          var scale = Math.min(1, limit / Math.max(w, h));
          if (scale >= 1) return resolve(src);
          var cv = document.createElement('canvas');
          cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          try { resolve(cv.toDataURL('image/jpeg', 0.85)); } catch (e) { resolve(src); }
        };
        img.onerror = function () { resolve(null); };
        img.src = src;
      });
    }, function () { return null; });
  }

  /** 把所有图片内联成 dataURL：给「一键 PDF」（服务端无认证上下文）用 */
  function inlineImages(m, budget) {
    var paths = [];
    function add(p) { if (p && paths.indexOf(p) < 0) paths.push(p); }
    add(m.cover.path); add(m.cover.portrait);
    for (var i = 0; i < m.chapters.length; i++) {
      var bs = m.chapters[i].blocks;
      for (var j = 0; j < bs.length; j++) {
        if (bs[j].type === 'photo' || bs[j].type === 'video') add(bs[j].path);
        if (bs[j].poster) add(bs[j].poster);
      }
    }
    var limit = budget || 120;
    var use = paths.slice(0, limit);
    var map = {};
    var chain = Promise.resolve();
    use.forEach(function (p) {
      chain = chain.then(function () {
        return imageData(p, 1400).then(function (d) { if (d) map[p] = d; });
      });
    });
    return chain.then(function () {
      return { map: map, skipped: Math.max(0, paths.length - use.length), total: paths.length };
    });
  }

  function srcOf(map, path) {
    if (!path) return '';
    return (map && map[path]) || fsrc(path);
  }

  /* ================= 印刷版 HTML ================= */

  var THEMES = {
    paper: { bg: '#F7F3EA', ink: '#2B2620', sub: '#6B6155', rule: '#D8CFBC' },
    ink: { bg: '#F4F5F7', ink: '#1E2630', sub: '#5A6673', rule: '#C9D1DA' },
    warm: { bg: '#FBF3EC', ink: '#3A2A22', sub: '#7A5C4A', rule: '#E2CBBB' },
  };

  var SIZE = {
    a5: { w: '148mm', h: '210mm', margin: '18mm 16mm 16mm', font: '10.5pt' },
    a4: { w: '210mm', h: '297mm', margin: '22mm 20mm 20mm', font: '11.5pt' },
  };

  function html(m, opts) {
    opts = opts || {};
    var th = THEMES[opts.theme || 'paper'] || THEMES.paper;
    var sz = SIZE[opts.size || 'a5'] || SIZE.a5;
    var map = opts.images || null;
    var fontStack = '"Songti SC","SimSun","Noto Serif CJK SC",serif';
    var kaiStack = '"Kaiti SC","KaiTi","STKaiti","Noto Serif CJK SC",serif';
    var heiStack = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    var bodyFont = m.cover.font === 'kai' ? kaiStack : (m.cover.font === 'hei' ? heiStack : fontStack);

    var css = [
      '@page { size: ' + sz.w + ' ' + sz.h + '; margin: ' + sz.margin + '; }',
      '* { box-sizing: border-box; }',
      'html,body { margin:0; padding:0; background:' + th.bg + '; color:' + th.ink + '; }',
      'body { font-family:' + bodyFont + '; font-size:' + sz.font + '; line-height:1.85; }',
      '.page { page-break-after: always; }',
      '.page:last-child { page-break-after: auto; }',
      '.cover { height: ' + (opts.size === 'a4' ? '257mm' : '176mm') + '; position:relative; overflow:hidden;',
      '  background:#1c1a17; color:#F3ECDF; page-break-after: always; }',
      '.cover .ph { position:absolute; inset:0; background-size:cover; background-position:center;',
      '  opacity:.72; filter:sepia(.25) contrast(1.05); }',
      '.cover .shade { position:absolute; inset:0; background:linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.72)); }',
      '.cover .txt { position:absolute; left:14mm; right:14mm; bottom:18mm; }',
      '.cover .no { font-size:9pt; letter-spacing:.3em; opacity:.75; margin-bottom:6mm; }',
      '.cover .name { font-size:30pt; letter-spacing:.08em; margin:0 0 4mm; font-weight:500; }',
      '.cover .yrs { font-size:11pt; opacity:.9; }',
      '.cover .intro { font-size:9.5pt; opacity:.85; margin-top:6mm; line-height:1.9; }',
      '.cover .pt { position:absolute; right:14mm; bottom:18mm; width:26mm; height:26mm; border-radius:50%;',
      '  overflow:hidden; border:1px solid rgba(243,236,223,.45); }',
      '.cover .pt img { width:100%; height:100%; object-fit:cover; }',
      '.front { page-break-after: always; padding-top:6mm; }',
      '.front h1 { font-size:17pt; margin:0 0 3mm; }',
      '.front .meta { color:' + th.sub + '; font-size:9.5pt; }',
      '.front .facts { margin-top:8mm; border-top:1px solid ' + th.rule + '; padding-top:5mm; }',
      '.front .facts div { display:flex; gap:6mm; margin-bottom:2mm; font-size:9.5pt; }',
      '.front .facts b { width:22mm; color:' + th.sub + '; font-weight:400; }',
      '.toc { page-break-after: always; }',
      '.toc h2 { font-size:13pt; letter-spacing:.28em; border-bottom:1px solid ' + th.rule + '; padding-bottom:3mm; }',
      '.toc a { display:flex; text-decoration:none; color:' + th.ink + '; padding:2.4mm 0;',
      '  border-bottom:1px dotted ' + th.rule + '; font-size:10pt; }',
      '.toc .i { width:8mm; color:' + th.sub + '; }',
      '.toc .t { flex:1; }',
      '.toc .p::after { content: target-counter(attr(href), page); color:' + th.sub + '; }',
      '.ch { page-break-before: always; }',
      '.ch .rh { font-size:8.5pt; color:' + th.sub + '; letter-spacing:.2em; margin-bottom:5mm; }',
      '.ch h2 { font-size:16pt; margin:0 0 2mm; line-height:1.5; }',
      '.ch .cy { color:' + th.sub + '; font-size:9.5pt; margin-bottom:6mm; }',
      '.ch .q { margin:0 0 7mm; padding:3mm 0 3mm 5mm; border-left:2px solid ' + th.rule + ';',
      '  color:' + th.sub + '; font-size:10pt; font-style:normal; }',
      '.b { margin:0 0 4mm; text-indent:2em; }',
      '.b.short { text-indent:0; }',
      '.fig { margin:6mm 0 7mm; page-break-inside: avoid; }',
      '.fig img { width:100%; display:block; height:auto; filter:sepia(.12); }',
      '.fig .cap { font-size:8.5pt; color:' + th.sub + '; margin-top:2mm; text-align:center; }',
      '.quo { margin:6mm 0; padding:4mm 5mm; background:rgba(0,0,0,.03); font-size:10pt; }',
      '.end { page-break-before: always; text-align:center; padding-top:40mm; }',
      '.end .q { font-size:12pt; line-height:2; margin-bottom:12mm; }',
      '.end .n { color:' + th.sub + '; font-size:9pt; }',
      '.fn { position:fixed; bottom:0; left:0; right:0; font-size:8pt; color:' + th.sub + '; }',
      '.hint { padding:6mm; background:#FFF6D9; color:#6b5a1f; font-size:9pt; }'
    ].join('\n');

    var out = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>' + esc(m.meta.title) + ' · 人生档案</title>',
      '<style>' + css + '</style></head><body>'];

    /* 封面 */
    out.push('<section class="cover">');
    if (m.cover.path) {
      out.push('<div class="ph" style="background-image:url(' + esc(srcOf(map, m.cover.path)) + ');' +
        'background-position:' + esc(m.cover.pos) + ';"></div>');
    }
    out.push('<div class="shade"></div><div class="txt">');
    out.push('<div class="no">' + esc(m.meta.archiveNo || '人生档案') + '</div>');
    out.push('<h1 class="name">' + esc(m.meta.title) + '</h1>');
    out.push('<div class="yrs">' + esc(m.meta.years) + (m.meta.hometown ? ' · ' + esc(m.meta.hometown) : '') + '</div>');
    if (m.meta.intro) out.push('<div class="intro">「' + esc(m.meta.intro) + '」</div>');
    out.push('</div>');
    if (m.cover.portrait) {
      out.push('<div class="pt"><img src="' + esc(srcOf(map, m.cover.portrait)) + '" alt=""></div>');
    }
    out.push('</section>');

    /* 扉页 */
    out.push('<section class="front">');
    out.push('<h1>' + esc(m.meta.title) + '</h1>');
    out.push('<div class="meta">' + esc(m.meta.years) +
      (m.meta.hometown ? ' · ' + esc(m.meta.hometown) : '') + '</div>');
    out.push('<div class="facts">');
    out.push('<div><b>档案编号</b><span>' + esc(m.meta.archiveNo) + '</span></div>');
    out.push('<div><b>篇幅</b><span>' + m.meta.chapters + ' 章 · 约 ' + m.meta.words + ' 字 · ' +
      m.meta.photos + ' 幅照片</span></div>');
    out.push('<div><b>整理日期</b><span>' + esc(m.meta.generatedAt) + '</span></div>');
    out.push('</div></section>');

    /* 目录 */
    out.push('<section class="toc"><h2>目 录</h2>');
    for (var i = 0; i < m.chapters.length; i++) {
      var c = m.chapters[i];
      out.push('<a class="tocrow" href="#ch-' + (c.id || 'x' + i) + '">' +
        '<span class="i">' + (i + 1) + '</span>' +
        '<span class="t">' + esc(c.title) + '</span>' +
        '<span class="p"></span></a>');
    }
    out.push('</section>');

    /* 正文章节 */
    for (var ci = 0; ci < m.chapters.length; ci++) {
      var ch = m.chapters[ci];
      out.push('<section class="ch" id="ch-' + (ch.id || 'x' + ci) + '">');
      out.push('<div class="rh">第 ' + (ci + 1) + ' 章</div>');
      out.push('<h2>' + esc(ch.title) + '</h2>');
      if (ch.years || ch.stage) {
        out.push('<div class="cy">' + esc([ch.years, ch.stage].filter(Boolean).join(' · ')) + '</div>');
      }
      if (ch.quote) out.push('<blockquote class="q">「' + esc(ch.quote) + '」</blockquote>');
      for (var bi = 0; bi < ch.blocks.length; bi++) {
        out.push(blockHtml(ch.blocks[bi], map));
      }
      if (!ch.blocks.length) out.push('<p class="b">这一章还没有内容。</p>');
      out.push('</section>');
    }

    /* 结尾 */
    var lastText = '';
    outer:
    for (var x = m.chapters.length - 1; x >= 0; x--) {
      var bs = m.chapters[x].blocks;
      for (var y = bs.length - 1; y >= 0; y--) {
        if (bs[y].type === 'text' && String(bs[y].text || '').length > 12) {
          lastText = String(bs[y].text).slice(0, 80);
          break outer;
        }
      }
    }
    out.push('<section class="end">');
    if (lastText) out.push('<div class="q">「' + esc(lastText) + '……」</div>');
    out.push('<div class="n">' + esc(m.meta.title) + ' · ' + esc(m.meta.years) + '<br>' +
      '由家人整理 · ' + esc(m.meta.generatedAt) + '</div>');
    out.push('</section>');

    out.push('</body></html>');
    return out.join('\n');
  }

  function blockHtml(b, map) {
    if (b.type === 'photo' || b.type === 'video') {
      var cap = [b.year ? String(b.year) : '', b.place || '', b.caption || ''].filter(Boolean).join(' · ');
      return '<figure class="fig"><img src="' + esc(srcOf(map, b.path)) + '" alt="">' +
        (cap ? '<div class="cap">' + esc(cap) + '</div>' : '') + '</figure>';
    }
    if (b.type === 'audio') {
      return '<div class="quo">〔录音〕' + esc(b.caption || '一段录音') + '</div>';
    }
    if (b.type === 'quote') return '<div class="quo">「' + esc(b.text) + '」</div>';
    var t = String(b.text || '');
    return '<p class="b' + (t.length < 18 ? ' short' : '') + '">' + esc(t) + '</p>';
  }

  /* ================= 打开 / 打印 / PDF ================= */

  function printHtml(m, opts) {
    var doc = html(m, opts || {});
    var w = window.open('', '_blank');
    if (!w) {
      // 弹窗被拦：给个能点开的兜底
      var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return;
    }
    w.document.open();
    w.document.write(doc);
    w.document.close();
    setTimeout(function () {
      try { w.focus(); } catch (e) {}
    }, 300);
  }

  function pdf(m, opts) {
    opts = opts || {};
    var name = (m.meta.title || '人生档案') + '-' + today();
    return inlineImages(m, 120).then(function (inline) {
      var doc = html(m, { theme: opts.theme, size: opts.size, images: inline.map });
      return API.exportPdf({
        html: doc,
        name: safeName(name),
        archiveId: opts.archiveId || null,
        params: { size: opts.size || 'a5', theme: opts.theme || 'paper', chapters: m.meta.chapters },
      });
    });
  }

  function safeName(s) {
    return String(s || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  /**
   * 落盘：直接走 /api/file，两端（Node / 安卓 LocalServer）都支持。
   * 不用 /api/export/save 是因为安卓端还没这个接口——少一个端特有依赖，就少一处"手机上不行"。
   */
  function saveFile(name, ext, base64, archiveId, params) {
    var raw = String(base64 || '');
    var comma = raw.indexOf(',');
    if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
    var filename = safeName(name) + '.' + ext;
    return API.file({ op: 'save', dir: 'exports', name: filename, base64: raw }).then(function (f) {
      if (!f || !f.ok) throw new Error((f && f.message) || '文件没存下来');
      return API.exec(
        'INSERT INTO exports (archive_id, kind, path, bytes, params_json) VALUES (?,?,?,?,?)',
        [archiveId || null, ext, f.path, f.bytes, JSON.stringify(params || {})]
      ).then(function () {
        return { ok: true, path: f.path, bytes: f.bytes };
      }, function () {
        return { ok: true, path: f.path, bytes: f.bytes };
      });
    });
  }

  window.Exporter = {
    model: model,
    html: html,
    print: printHtml,
    pdf: pdf,
    saveFile: saveFile,
    inlineImages: inlineImages,
    imageData: imageData,
    safeName: safeName,
    today: today,
    esc: esc,
    fsrc: fsrc,
  };
})();
