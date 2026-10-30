/**
 * 导出 Word（.docx）：用构建期打进包里的 docx 库，纯前端生成，安卓端也能用。
 *
 * 排版原则：只用 Word 的内置样式（标题 1/2、正文），不写绝对定位——
 * 这样用户拿到文档后能自己改、自己生成目录，WPS 与 Word 也不会打架。
 */
(function () {
  'use strict';

  var E = window.Exporter;

  function b64ToBytes(dataUrl) {
    var s = String(dataUrl || '');
    var comma = s.indexOf(',');
    if (comma > 0) s = s.slice(comma + 1);
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sizeOf(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve({ w: img.width || 4, h: img.height || 3 }); };
      img.onerror = function () { resolve({ w: 4, h: 3 }); };
      img.src = dataUrl;
    });
  }

  function docxOf(dataUrl) {
    var ext = 'jpg';
    if (String(dataUrl).indexOf('data:image/png') === 0) ext = 'png';
    return { data: b64ToBytes(dataUrl), type: ext };
  }

  /** A5 版心约 328pt 宽；图片按比例缩到不超过 300pt 宽、320pt 高 */
  function fitBox(w, h) {
    var maxW = 300, maxH = 320;
    var scale = Math.min(maxW / w, maxH / h, 1);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }

  function build(m) {
    var d = window.docx;
    if (!d) return Promise.reject(new Error('Word 排版库没加载起来（web/vendor/docx.umd.js 缺失）'));
    var Paragraph = d.Paragraph, TextRun = d.TextRun, ImageRun = d.ImageRun;
    var AlignmentType = d.AlignmentType, HeadingLevel = d.HeadingLevel, PageBreak = d.PageBreak;

    var children = [];
    var fontRun = { font: '宋体', size: 21 };   // 10.5pt

    function para(text, opts) {
      opts = opts || {};
      // 不用 Object.assign（Chrome 45+ 才有，安卓老 WebView 没有），显式拼 ES5 对象
      var run = { font: fontRun.font, size: fontRun.size, text: String(text || '') };
      if (opts.bold) run.bold = true;
      return new Paragraph({
        alignment: opts.align || AlignmentType.JUSTIFIED,
        spacing: { line: 360, after: opts.after === undefined ? 120 : opts.after },
        indent: opts.indent === false ? undefined : { firstLine: 420 },
        children: [new TextRun(run)],
      });
    }

    /* 封面 */
    children.push(new Paragraph({ spacing: { before: 1600, after: 200 }, alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: m.meta.archiveNo || '人生档案', font: '宋体', size: 18, color: '777777' })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: m.meta.title, font: '黑体', size: 56, bold: false })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
      children: [new TextRun({ text: m.meta.years + (m.meta.hometown ? ' · ' + m.meta.hometown : ''), font: '宋体', size: 22, color: '555555' })] }));
    if (m.meta.intro) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
        children: [new TextRun({ text: '「' + m.meta.intro + '」', font: '楷体', size: 21, color: '444444' })] }));
    }
    children.push(new Paragraph({ children: [new PageBreak()] }));

    /* 信息页 */
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '档案信息', font: '黑体' })] }));
    children.push(para('档案编号：' + (m.meta.archiveNo || '—'), { indent: false }));
    children.push(para('篇幅：共 ' + m.meta.chapters + ' 章，约 ' + m.meta.words + ' 字，' + m.meta.photos + ' 幅照片', { indent: false }));
    children.push(para('整理日期：' + m.meta.generatedAt, { indent: false }));
    children.push(new Paragraph({ children: [new PageBreak()] }));

    /* 目录（不写页码：Word 里让用户自己更新域，写了也是死的） */
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '目录', font: '黑体' })] }));
    for (var t = 0; t < m.chapters.length; t++) {
      children.push(para((t + 1) + '　' + m.chapters[t].title +
        (m.chapters[t].years ? '（' + m.chapters[t].years + '）' : ''), { indent: false, after: 60 }));
    }
    children.push(new Paragraph({ children: [new PageBreak()] }));

    return Promise.resolve().then(function () {
      var chain = Promise.resolve();
      m.chapters.forEach(function (ch, idx) {
        chain = chain.then(function () {
          children.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            pageBreakBefore: idx > 0,
            spacing: { before: 240, after: 120 },
            children: [new TextRun({ text: '第 ' + (idx + 1) + ' 章　' + ch.title, font: '黑体', size: 32 })],
          }));
          if (ch.years || ch.stage) {
            children.push(new Paragraph({ spacing: { after: 200 }, alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: [ch.years, ch.stage].filter(Boolean).join(' · '), font: '宋体', size: 18, color: '666666' })] }));
          }
          if (ch.quote) {
            children.push(new Paragraph({ spacing: { after: 200 }, indent: { left: 420 },
              children: [new TextRun({ text: '「' + ch.quote + '」', font: '楷体', size: 20, color: '555555' })] }));
          }
          var inner = Promise.resolve();
          ch.blocks.forEach(function (b) {
            inner = inner.then(function () {
              if (b.type === 'text' || b.type === 'quote') {
                children.push(para(b.type === 'quote' ? '「' + b.text + '」' : b.text));
                return;
              }
              if (b.type === 'audio') { children.push(para('〔录音〕' + (b.caption || '一段录音'))); return; }
              if (!b.path) return;
              return E.imageData(b.path, 1400).then(function (dataUrl) {
                if (!dataUrl) return;
                return sizeOf(dataUrl).then(function (sz) {
                  var box = fitBox(sz.w, sz.h);
                  var img = docxOf(dataUrl);
                  children.push(new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 120, after: 60 },
                    children: [new ImageRun({ data: img.data, transformation: box, type: img.type })],
                  }));
                  var cap = [b.year ? String(b.year) : '', b.place || '', b.caption || ''].filter(Boolean).join(' · ');
                  if (cap) {
                    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
                      children: [new TextRun({ text: cap, font: '宋体', size: 16, color: '777777' })] }));
                  }
                });
              });
            });
          });
          return inner;
        });
      });
      return chain;
    }).then(function () {
      var doc = new d.Document({
        creator: '岁月记录助手',
        title: m.meta.title,
        description: '由家人整理',
        styles: { default: { document: { run: { font: '宋体', size: 21 } } } },
        sections: [{
          properties: {
            page: {
              size: { width: 8391, height: 11906 },        // A5，单位 twips
              margin: { top: 1134, right: 907, bottom: 907, left: 907 },
            },
          },
          children: children,
        }],
      });
      return d.Packer.toBlob(doc);
    });
  }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(new Error('读不出来')); };
      fr.readAsDataURL(blob);
    });
  }

  function exportDocx(m, opts) {
    return build(m).then(toBase64).then(function (b64) {
      return E.saveFile((m.meta.title || '人生档案') + '-' + E.today(), 'docx', b64,
        (opts || {}).archiveId || null, { kind: 'docx' });
    });
  }

  window.Exporter = window.Exporter || {};
  window.Exporter.docx = exportDocx;
})();
