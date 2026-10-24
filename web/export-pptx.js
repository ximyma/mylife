/**
 * 导出 PPT（.pptx）：用于家族聚会放映，不是把文字搬上幻灯片。
 *
 * 六种页型：封面 / 时间轴 / 章节扉页 / 图文对页 / 照片墙 / 结语。
 * 一页一章，条目超过 4 条自动拆页；照片墙按可用张数自动选宫格。
 */
(function () {
  'use strict';

  var E = window.Exporter;

  var INK = '2B2620', SUB = '6B6155', PAPER = 'F7F3EA', DARK = '1C1A17', CREAM = 'F3ECDF';
  var FONT = 'Microsoft YaHei';

  function need() {
    var P = window.PptxGenJS;
    if (!P) throw new Error('PPT 库没加载起来（web/vendor/pptxgen.bundle.js 缺失）');
    return P;
  }

  function textOf(blocks, max) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type === 'text' || b.type === 'quote') {
        var t = String(b.text || '').trim();
        if (t) out.push(t);
      }
    }
    return out.slice(0, max || 4);
  }

  function photoPaths(blocks) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].type === 'photo' && blocks[i].path) out.push(blocks[i].path);
    }
    return out;
  }

  function build(m) {
    var P = need();
    var pptx = new P();
    pptx.layout = 'LAYOUT_16x9';           // 10 × 5.625 英寸
    pptx.author = '我的人生档案';
    pptx.title = m.meta.title;

    var chain = Promise.resolve();

    /* ---- 封面 ---- */
    chain = chain.then(function () {
      var s = pptx.addSlide();
      s.background = { color: DARK };
      return Promise.resolve(m.cover.path ? E.imageData(m.cover.path, 1600) : null)
        .then(function (img) {
          if (img) {
            s.addImage({ data: img, x: 0, y: 0, w: 10, h: 5.63, sizing: { type: 'cover', w: 10, h: 5.63 } });
            s.addShape('rect', { x: 0, y: 0, w: 10, h: 5.63, fill: { color: '000000', transparency: 45 } });
          }
          s.addText(m.meta.archiveNo || '人生档案', {
            x: 0.7, y: 2.5, w: 8.6, h: 0.3, fontSize: 12, color: 'D8CFBC', fontFace: FONT, charSpacing: 4,
          });
          s.addText(m.meta.title, {
            x: 0.7, y: 2.85, w: 8.6, h: 1.1, fontSize: 54, color: CREAM, fontFace: FONT, bold: true,
          });
          s.addText(m.meta.years + (m.meta.hometown ? ' · ' + m.meta.hometown : ''), {
            x: 0.7, y: 3.95, w: 8.6, h: 0.4, fontSize: 18, color: 'D8CFBC', fontFace: FONT,
          });
          if (m.cover.portrait) {
            return E.imageData(m.cover.portrait, 500).then(function (pt) {
              if (pt) s.addImage({ data: pt, x: 8.6, y: 4.3, w: 0.9, h: 0.9 });
            });
          }
        });
    });

    /* ---- 时间轴 ---- */
    var yrs = [];
    for (var i = 0; i < m.chapters.length; i++) {
      var y = String(m.chapters[i].years || '').split('—')[0];
      if (/^\d{4}$/.test(y)) yrs.push({ y: Number(y), t: m.chapters[i].title });
    }
    if (yrs.length) {
      chain = chain.then(function () {
        var s = pptx.addSlide();
        s.background = { color: PAPER };
        s.addText('一生的几个路口', { x: 0.7, y: 0.5, w: 8.6, h: 0.5, fontSize: 26, color: INK, fontFace: FONT, bold: true });
        s.addShape('line', { x: 0.8, y: 3.1, w: 8.4, h: 0, line: { color: 'C9BFA8', width: 2 } });
        var step = yrs.length > 1 ? 8.4 / (yrs.length - 1) : 0;
        yrs.slice(0, 6).forEach(function (it, k) {
          var cx = 0.8 + step * k;
          s.addShape('ellipse', { x: cx - 0.07, y: 3.03, w: 0.14, h: 0.14, fill: { color: '8B5E3C' } });
          s.addText(String(it.y), { x: cx - 0.55, y: 2.55, w: 1.1, h: 0.35, fontSize: 13, color: SUB, fontFace: FONT, align: 'center' });
          s.addText(it.t, { x: cx - 0.8, y: 3.3, w: 1.6, h: 0.8, fontSize: 11, color: INK, fontFace: FONT, align: 'center' });
        });
      });
    }

    /* ---- 章节 ---- */
    m.chapters.forEach(function (ch, idx) {
      chain = chain.then(function () {
        /* 扉页 */
        var s = pptx.addSlide();
        s.background = { color: PAPER };
        s.addText('第 ' + (idx + 1) + ' 章', { x: 0.9, y: 1.5, w: 8, h: 0.4, fontSize: 13, color: SUB, fontFace: FONT, charSpacing: 3 });
        s.addText(ch.title || '（未命名）', { x: 0.9, y: 1.9, w: 8.2, h: 1.0, fontSize: 40, color: INK, fontFace: FONT, bold: true });
        if (ch.years) s.addText(ch.years, { x: 0.9, y: 2.95, w: 8, h: 0.35, fontSize: 15, color: SUB, fontFace: FONT });
        if (ch.quote) {
          s.addText('「' + ch.quote + '」', { x: 0.9, y: 3.5, w: 8.2, h: 1.0, fontSize: 16, color: '5A4A3A', fontFace: FONT, italic: true });
        }
        return Promise.resolve();
      }).then(function () {
        /* 照片墙（有图才做） */
        var ph = photoPaths(ch.blocks);
        if (!ph.length) return null;
        var s2 = pptx.addSlide();
        s2.background = { color: PAPER };
        s2.addText(ch.title || '', { x: 0.6, y: 0.35, w: 8.8, h: 0.45, fontSize: 20, color: INK, fontFace: FONT, bold: true });
        var use = ph.slice(0, 6);
        var cols = use.length >= 5 ? 3 : 2;
        var rows = Math.ceil(use.length / cols);
        var cw = (8.8 - (cols - 1) * 0.12) / cols;
        var chh = (4.3 - (rows - 1) * 0.12) / Math.max(1, rows);
        var ci = Promise.resolve();
        use.forEach(function (p, k) {
          ci = ci.then(function () {
            return E.imageData(p, 1000).then(function (img) {
              if (!img) return;
              var cx = 0.6 + (k % cols) * (cw + 0.12);
              var cy = 0.95 + Math.floor(k / cols) * (chh + 0.12);
              s2.addImage({ data: img, x: cx, y: cy, w: cw, h: chh, sizing: { type: 'cover', w: cw, h: chh } });
            });
          });
        });
        return ci;
      }).then(function () {
        /* 文字页：每条一页，最多 2 条一页避免挤 */
        var texts = textOf(ch.blocks, 6);
        var page = 0;
        var tc = Promise.resolve();
        for (var i = 0; i < texts.length; i += 2) {
          (function (group, pageNo) {
            tc = tc.then(function () {
              var s3 = pptx.addSlide();
              s3.background = { color: PAPER };
              s3.addText(ch.title || '', { x: 0.7, y: 0.4, w: 8.6, h: 0.4, fontSize: 15, color: SUB, fontFace: FONT });
              var box = group.map(function (t) { return { text: t, options: { fontSize: 16, color: INK, fontFace: FONT, breakLine: true, paraSpaceAfter: 12 } }; });
              s3.addText(box, { x: 0.7, y: 1.0, w: 8.6, h: 3.9, lineSpacing: 30, valign: 'top' });
              if (pageNo === 0) {
                s3.addText(String(idx + 1), { x: 9.1, y: 4.7, w: 0.4, h: 0.3, fontSize: 11, color: 'B4B2A9', fontFace: FONT });
              }
            });
          })(texts.slice(i, i + 2), page++);
        }
        return tc;
      });
    });

    /* ---- 结语 ---- */
    chain = chain.then(function () {
      var s = pptx.addSlide();
      s.background = { color: DARK };
      var last = '';
      outer:
      for (var i = m.chapters.length - 1; i >= 0; i--) {
        var ts = textOf(m.chapters[i].blocks, 6);
        for (var j = ts.length - 1; j >= 0; j--) {
          if (ts[j].length > 10) { last = ts[j].slice(0, 60); break outer; }
        }
      }
      if (last) {
        s.addText('「' + last + '……」', { x: 0.9, y: 1.8, w: 8.2, h: 1.6, fontSize: 22, color: CREAM, fontFace: FONT, align: 'center', lineSpacing: 40 });
      }
      s.addText(m.meta.title + ' · ' + m.meta.years, { x: 0.9, y: 3.8, w: 8.2, h: 0.35, fontSize: 13, color: 'A99E8B', fontFace: FONT, align: 'center' });
      s.addText('由家人整理 · ' + m.meta.generatedAt, { x: 0.9, y: 4.2, w: 8.2, h: 0.3, fontSize: 11, color: '8A8072', fontFace: FONT, align: 'center' });
    });

    return chain.then(function () {
      var p = pptx.write({ outputType: 'base64' });
      return (p && p.then) ? p : pptx.write('base64');
    });
  }

  function exportPptx(m, opts) {
    return Promise.resolve().then(function () { return build(m); }).then(function (b64) {
      var s = String(b64 || '');
      if (s.indexOf(',') > 0) s = s.slice(s.indexOf(',') + 1);
      return E.saveFile((m.meta.title || '人生档案') + '-' + E.today(), 'pptx', s,
        (opts || {}).archiveId || null, { kind: 'pptx' });
    });
  }

  window.Exporter = window.Exporter || {};
  window.Exporter.pptx = exportPptx;
})();
