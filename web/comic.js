/**
 * 漫画：把一章讲述排成竖版分页。
 *
 * 两条设计原则：
 *   ① **分镜是结构活，不交给模型**。格子顺序就是讲述顺序，年份就是年份，
 *      规则能保证「可预期、可重排、零成本」。让模型编画面只会编出不存在的细节。
 *   ② **缺图就留白，并明确告诉用户**。留白格画成虚线框加一句「这格还缺图」，
 *      点它就跳到插图页。宁可看着空，也不要拿一张不相关的图凑数。
 *
 * 排版用 SVG 而不是 canvas：文字是文本节点，选得中、改得动、打印清晰，
 * 导出时再整体栅格化。
 */
(function () {
  'use strict';

  var ML = window.ML || {};
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    });
  }
  function fsrc(p) { return ML.fsrc ? ML.fsrc(p) : ('/files/' + p); }
  function toast(m) { if (ML.toast) ML.toast(m); }

  /* ---------------- 排版计算 ---------------- */

  var W = 720, H = 1080, PAD = 24, HEAD = 78, GAP = 14;

  /**
   * 中文换行。按「全角 1、半角 0.55」估算宽度，够用且不依赖 canvas 测量。
   * 每行末尾不放过标点（。，」等），否则会出现「行首标点」这种低级排版错误。
   */
  function wrapCJK(text, perLine, maxLines) {
    var src = String(text || '').replace(/\s+/g, ' ').trim();
    var lines = [], cur = '', w = 0;
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      var cw = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
      if (w + cw > perLine + 0.001) {
        lines.push(cur);
        cur = ''; w = 0;
      }
      cur += ch; w += cw;
    }
    if (cur) lines.push(cur);

    // 行首是标点：把上一行最后一个字挪下来，视觉上才不刺眼
    for (var k = 1; k < lines.length; k++) {
      if (/^[，。、；：？！）」』】…—]/.test(lines[k]) && lines[k - 1].length > 1) {
        var prev = lines[k - 1];
        lines[k] = prev.slice(-1) + lines[k];
        lines[k - 1] = prev.slice(0, -1);
      }
    }

    var lim = maxLines || 6;
    if (lines.length > lim) {
      lines = lines.slice(0, lim);
      lines[lim - 1] = lines[lim - 1].slice(0, -1) + '…';
    }
    return lines;
  }

  function grid(perPage) {
    if (perPage <= 1) return { cols: 1, rows: 1 };
    if (perPage === 2) return { cols: 1, rows: 2 };
    if (perPage === 3) return { cols: 1, rows: 3 };
    if (perPage === 6) return { cols: 2, rows: 3 };
    return { cols: 2, rows: 2 };
  }

  /**
   * 生成一页 SVG。
   * images 是 { 图片路径: dataURL } —— 导出时传内联图；预览时传空，直接用带 token 的地址。
   */
  function pageSvg(json, pageNo, images) {
    var page = (json.pages || [])[pageNo - 1];
    if (!page) return '';
    var g = grid(json.perPage || 4);
    var bodyH = H - HEAD - PAD;
    var cw = (W - PAD * 2 - GAP * (g.cols - 1)) / g.cols;
    var chh = (bodyH - GAP * (g.rows - 1)) / g.rows;

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" class="comic-svg">');
    out.push('<defs><style>' +
      '.cb-t{font-family:"Songti SC","SimSun","Noto Serif CJK SC",serif;font-size:19px;fill:#2B2620}' +
      '.cb-who{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;fill:#8A7F70;letter-spacing:1px}' +
      '.cb-pg{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:11px;fill:#9A9082}' +
      '.cb-yr{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:11.5px;fill:#7A5B33}' +
      '.cb-ttl{font-family:"Songti SC","SimSun",serif;font-size:22px;fill:#2B2620;letter-spacing:2px}' +
      '.cb-hint{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;fill:#A89C8B}' +
      '</style>' +
      '<clipPath id="pclip' + pageNo + '"><rect x="0" y="0" width="' + W + '" height="' + H + '" rx="0"/></clipPath>' +
      '</defs>');

    // 纸底
    out.push('<rect width="' + W + '" height="' + H + '" fill="#FBF7EE"/>');
    out.push('<rect x="10" y="10" width="' + (W - 20) + '" height="' + (H - 20) + '" fill="none" stroke="#E3D9C6" stroke-width="1"/>');

    // 页头
    out.push('<text class="cb-ttl" x="' + PAD + '" y="46">' + esc(json.title || '') + '</text>');
    if (json.years) out.push('<text class="cb-yr" x="' + PAD + '" y="64">' + esc(json.years) + '</text>');
    out.push('<text class="cb-pg" x="' + (W - PAD) + '" y="46" text-anchor="end">第 ' +
      pageNo + ' / ' + (json.pages || []).length + ' 页</text>');
    out.push('<line x1="' + PAD + '" y1="70" x2="' + (W - PAD) + '" y2="70" stroke="#E3D9C6" stroke-width="1"/>');

    // 格子
    for (var i = 0; i < g.cols * g.rows; i++) {
      var col = i % g.cols, row = Math.floor(i / g.cols);
      var x = PAD + col * (cw + GAP);
      var y = HEAD + row * (chh + GAP);
      var p = page.panels[i];

      if (!p) {
        out.push('<rect x="' + x + '" y="' + y + '" width="' + cw + '" height="' + chh +
          '" fill="#F7F2E7" stroke="#D3C6AE" stroke-dasharray="5 5"/>');
        continue;
      }

      out.push('<g class="panel" data-page="' + pageNo + '" data-idx="' + i + '">');

      if (p.photo) {
        var src = (images && images[p.photo]) || fsrc(p.photo);
        out.push('<rect x="' + x + '" y="' + y + '" width="' + cw + '" height="' + chh + '" fill="#EDE5D6"/>');
        out.push('<image x="' + x + '" y="' + y + '" width="' + cw + '" height="' + chh +
          '" preserveAspectRatio="xMidYMid slice" xlink:href="' + esc(src) + '" href="' + esc(src) + '"/>');
      } else {
        out.push('<rect x="' + x + '" y="' + y + '" width="' + cw + '" height="' + chh +
          '" fill="#F4EDE0" stroke="#D9CDB8" stroke-dasharray="5 5"/>');
        out.push('<text class="cb-hint" x="' + (x + cw / 2) + '" y="' + (y + chh / 2 - 4) +
          '" text-anchor="middle">这一格还缺一张图</text>');
        out.push('<text class="cb-hint" x="' + (x + cw / 2) + '" y="' + (y + chh / 2 + 16) +
          '" text-anchor="middle" style="font-size:11px">去「插图」画一张</text>');
      }

      // 气泡：放格子下方，高度按行数倒推
      var bw = cw - 28;
      var perLine = Math.max(8, Math.floor((bw - 26) / 19));
      var lines = wrapCJK(p.short || '', perLine, 5);
      var lh = 28;
      var bh = lines.length * lh + 22;
      var bx = x + 14;
      var by = y + chh - bh - 12;

      if (p.photo) {
        // 图上的气泡要压一层半透明白，不然字看不清
        out.push('<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
          '" rx="13" fill="#FFFDF8" fill-opacity="0.94" stroke="#3A342C" stroke-opacity="0.55"/>');
      } else {
        out.push('<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
          '" rx="13" fill="#FFFDF8" stroke="#3A342C" stroke-opacity="0.45"/>');
      }
      out.push('<path d="M' + (bx + 26) + ' ' + by + ' l 9 -11 l 3 11 z" fill="#FFFDF8" stroke="#3A342C" stroke-opacity="0.45"/>');

      for (var L = 0; L < lines.length; L++) {
        out.push('<text class="cb-t" x="' + (bx + 13) + '" y="' + (by + 26 + L * lh) + '">' +
          esc(lines[L]) + '</text>');
      }

      if (p.year) {
        out.push('<text class="cb-who" x="' + (x + cw - 8) + '" y="' + (y + 18) +
          '" text-anchor="end">' + esc(p.year) + '</text>');
      }
      out.push('</g>');
    }

    // 页脚
    out.push('<text class="cb-pg" x="' + PAD + '" y="' + (H - 8) + '">' +
      esc(json.name || '') + (json.archiveNo ? ' · 档案第 ' + esc(json.archiveNo) + ' 号' : '') + '</text>');
    out.push('<text class="cb-pg" x="' + (W - PAD) + '" y="' + (H - 8) + '" text-anchor="end">' +
      '第 ' + pageNo + ' 页</text>');
    out.push('</svg>');
    return out.join('');
  }

  /* ---------------- 页面 ---------------- */

  var state = { archiveId: 0, comic: null };

  function render(host, archiveId) {
    state.archiveId = archiveId;

    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      DB.listComics(archiveId),
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], comics = r[2];
      if (!a) throw new Error('找不到这本档案');

      var chOpts = chapters.map(function (c, i) {
        return '<option value="' + c.id + '">' + esc(c.title || ('第 ' + (i + 1) + ' 章')) + '</option>';
      }).join('');

      var hist = comics.map(function (c) {
        var j = {};
        try { j = JSON.parse(c.json || '{}'); } catch (e) {}
        return '<button class="chip" data-comic="' + c.id + '">' + esc(j.title || '未命名') +
          ' · ' + ((j.pages || []).length) + ' 页</button>';
      }).join('');

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '漫画' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">把这一章排成漫画</h1>' +
        '<p class="muted">格子按讲述顺序走，气泡就是原话，图来自档案里的照片和插图。缺图的格子会留着虚线框。</p></section>' +

        '<section class="art-set">' +
        '<div class="art-row">' +
        '<select class="fi" id="cmCh" style="max-width:230px">' + chOpts + '</select>' +
        '<select class="fi" id="cmPer" style="max-width:130px">' +
        '<option value="4">一页 4 格</option><option value="6">一页 6 格</option><option value="2">一页 2 格</option>' +
        '</select>' +
        '<button class="btn" id="cmBuild">排成漫画</button>' +
        '</div>' +
        (hist ? '<div class="cw-label" style="margin-top:12px">排过的</div><div class="sc-list">' + hist + '</div>' : '') +
        '</section>' +

        '<section id="cmBook"></section>' +
        '</main>';

      bind(host, a);
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '漫画' }) +
        '<main class="wrap"><p class="muted">' + esc(e.message || e) + '</p></main>';
    });
  }

  function bind(host, a) {
    var book = host.querySelector('#cmBook');

    host.querySelector('#cmBuild').onclick = function () {
      var chId = Number(host.querySelector('#cmCh').value);
      var per = Number(host.querySelector('#cmPer').value);
      if (!chId) { toast('先选一章'); return; }
      book.innerHTML = '<div class="boot">正在分格……</div>';
      DB.buildComic(a.id, chId, per).then(function (json) {
        state.comic = json;
        paint(book, json);
        toast('排好了 ' + json.pages.length + ' 页');
      }).catch(function (e) {
        book.innerHTML = '<p class="muted">' + esc(e.message || e) + '</p>';
      });
    };

    var chips = host.querySelectorAll('[data-comic]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].onclick = function () {
        var id = Number(this.getAttribute('data-comic'));
        book.innerHTML = '<div class="boot">正在打开……</div>';
        DB.getComic(id).then(function (row) {
          state.comic = row.parsed;
          state.comic.id = row.id;
          paint(book, state.comic);
        });
      };
    }
  }

  function paint(book, json) {
    if (!json || !json.pages || !json.pages.length) {
      book.innerHTML = '<p class="muted">这本漫画还是空的。</p>';
      return;
    }

    var html = '<div class="cm-bar">' +
      '<span class="muted">共 ' + json.pages.length + ' 页 · 点气泡可以改词</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn tiny" id="cmHtml">导出网页版</button>' +
      '<button class="btn tiny" id="cmPng">存成图片</button>' +
      '<button class="btn tiny" id="cmPrint">打印</button>' +
      '</div><div class="cm-book">';

    for (var p = 1; p <= json.pages.length; p++) {
      html += '<div class="cm-page" data-page="' + p + '">' + pageSvg(json, p, null) + '</div>';
    }
    html += '</div>';
    book.innerHTML = html;

    // 点气泡改词
    var svgs = book.querySelectorAll('.comic-svg');
    for (var s = 0; s < svgs.length; s++) {
      svgs[s].addEventListener('click', function (ev) {
        var g = ev.target.closest ? ev.target.closest('.panel') : null;
        if (!g) return;
        var pg = Number(g.getAttribute('data-page'));
        var idx = Number(g.getAttribute('data-idx'));
        var panel = json.pages[pg - 1].panels[idx];
        var cur = panel.short || '';
        var v = window.prompt('这一格的气泡写什么？（原文不会被改动）', cur);
        if (v === null) return;
        DB.updateComicPanel(json.id, pg, idx, v).then(function (j) {
          json.pages = j.pages;
          paint(book, json);
        }).catch(function (e) { toast(e.message || String(e)); });
      });
    }

    book.querySelector('#cmPrint').onclick = function () { window.print(); };
    book.querySelector('#cmHtml').onclick = function () { exportHtml(json); };
    book.querySelector('#cmPng').onclick = function () { exportPng(json); };
  }

  /* ---------------- 导出 ---------------- */

  /** 把用到的图先转成 data URL：SVG 一旦离开当前页，外部链接就断了 */
  function collectImages(json) {
    var paths = [], seen = {};
    for (var p = 0; p < json.pages.length; p++) {
      var panels = json.pages[p].panels || [];
      for (var i = 0; i < panels.length; i++) {
        var ph = panels[i].photo;
        if (ph && !seen[ph]) { seen[ph] = 1; paths.push(ph); }
      }
    }
    var map = {};
    var chain = Promise.resolve();
    var limit = Math.min(paths.length, 60);
    for (var k = 0; k < limit; k++) {
      (function (pth) {
        chain = chain.then(function () {
          return window.Exporter.imageData(pth, 1000).then(function (d) {
            if (d) map[pth] = d;
          }).catch(function () {});
        });
      })(paths[k]);
    }
    return chain.then(function () { return map; });
  }

  function exportHtml(json) {
    toast('正在打包图片……');
    collectImages(json).then(function (imgs) {
      var body = '';
      for (var p = 1; p <= json.pages.length; p++) {
        body += '<div class="pg">' + pageSvg(json, p, imgs) + '</div>';
      }
      var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<title>' + esc(json.name + ' · ' + json.title) + '</title><style>' +
        '@page{size:720px 1080px;margin:0}' +
        'body{margin:0;background:#EDE6D8;display:flex;flex-direction:column;align-items:center}' +
        '.pg{width:720px;height:1080px;margin:0 auto;page-break-after:always;break-after:page}' +
        '.pg svg{display:block;width:100%;height:100%}' +
        '@media print{body{background:none}.pg{margin:0}}' +
        '</style></head><body>' + body + '</body></html>';

      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = (ML.safeName ? ML.safeName(json.name + '-' + json.title) : 'comic') + '-漫画.html';
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已导出网页版，打开后可直接打印成 PDF');
    });
  }

  /** 逐页栅格化。一次导出所有页，浏览器会连下 N 个文件——这不礼貌，改成串行加间隔 */
  function exportPng(json) {
    toast('正在出图，页数多要等一会儿……');
    collectImages(json).then(function (imgs) {
      var p = 1;
      var go = function () {
        if (p > json.pages.length) { toast('全部导出完成'); return; }
        var svg = pageSvg(json, p, imgs);
        var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#FBF7EE';
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(img, 0, 0, W, H);
          URL.revokeObjectURL(url);
          cv.toBlob(function (b) {
            var u2 = URL.createObjectURL(b);
            var el = document.createElement('a');
            el.href = u2;
            el.download = (ML.safeName ? ML.safeName(json.name + '-' + json.title) : 'comic') + '-' + p + '.png';
            document.body.appendChild(el); el.click(); el.remove();
            setTimeout(function () { URL.revokeObjectURL(u2); }, 3000);
            p++;
            setTimeout(go, 700);
          }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); p++; setTimeout(go, 200); };
        img.src = url;
      };
      go();
    });
  }

  window.ComicUI = {
    render: render,
    pageSvg: pageSvg,
    wrapCJK: wrapCJK,
    grid: grid,
    W: W, H: H,
  };
})();
