/* =====================================================================
 * BookFlip —— 翻书预览（v0.9.19）
 * 把成书排版变成一本能翻的书：双页摊开、3D 翻页、纸质纹理。
 * 纯 ES5、零依赖；窄屏（手机）自动切单页滑动模式。
 *
 * 用法：
 *   window.BookFlip.open(model, { theme: 'paper' })
 * model 是 Exporter.model() 的返回值（cover/chapters/meta），
 * 与成书预览、导出 Word/PDF 用的是同一份排版数据。
 * ===================================================================== */
(function () {
  'use strict';

  var ML = window.ML || {};
  var esc = ML.esc || function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fsrc = ML.fsrc || (window.Exporter && window.Exporter.fsrc) || function (p) { return p || ''; };

  var THEMES = {
    paper: { bg: '#F7F3EA', ink: '#2B2620', sub: '#6B6155', rule: '#D8CFBC', edge: '#E9E1CF' },
    ink:   { bg: '#F4F5F7', ink: '#1E2630', sub: '#5A6673', rule: '#C9D1DA', edge: '#DEE3E8' },
    warm:  { bg: '#FBF3EC', ink: '#3A2A22', sub: '#7A5C4A', rule: '#E2CBBB', edge: '#F0DECD' },
  };

  /* ---------------- 页面内容 ---------------- */

  function srcOf(map, path) { return (map && map[path]) || fsrc(path); }

  function blockHtml(b, map, imgH) {
    if (b.type === 'photo' || b.type === 'video') {
      var cap = [b.year ? String(b.year) : '', b.place || '', b.caption || ''].filter(Boolean).join(' · ');
      return '<figure class="bfig"><img src="' + esc(srcOf(map, b.path)) + '" style="max-height:' + imgH + 'px" alt="">' +
        (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') + '</figure>';
    }
    if (b.type === 'audio') return '<div class="bquo">〔录音〕' + esc(b.caption || '一段录音') + '</div>';
    if (b.type === 'quote') return '<div class="bquo">「' + esc(b.text) + '」</div>';
    var t = String(b.text || '');
    return '<p class="bp' + (t.length < 18 ? ' short' : '') + '">' + esc(t) + '</p>';
  }

  /* ---------------- 分页：按真实高度把章节切块装进页 ---------------- */

  /**
   * 把一章的内容按测量高度分进若干页。
   * meas 是隐藏的测量盒（宽度=页内宽、字号与正文一致）；
   * avail 是每页可用的内容高度（px）。
   * 返回每页的 innerHTML 数组（不含章题头）。
   */
  function paginateBlocks(blocks, map, meas, avail, imgH) {
    var pages = [];
    var cur = '';
    function flush() { if (cur) { pages.push(cur); cur = ''; } }
    for (var i = 0; i < blocks.length; i++) {
      var h = blockHtml(blocks[i], map, imgH);
      meas.innerHTML = cur + h;
      if (meas.scrollHeight <= avail || !cur) {
        cur += h;
      } else {
        flush();
        cur = h;
        meas.innerHTML = cur;
        // 单块就超一页（超长图/超长段）：也单独成页，允许页内滚动兜底
      }
    }
    flush();
    if (!pages.length) pages.push('<p class="bp dim">这一章还没有内容。</p>');
    return pages;
  }

  /**
   * 组全书页数组：封面 → 扉页 → 目录 → 各章（自动分页）→ 结尾页。
   * 返回 [{ html: '...', kind: 'cover|front|toc|body|end', no: 页码或0 }]
   */
  function buildPages(m, opts) {
    var map = opts.images || null;
    var th = THEMES[opts.theme || 'paper'] || THEMES.paper;
    var pages = [];

    /* 封面 */
    pages.push({
      kind: 'cover',
      html: (m.cover.path ? '<div class="bcov-ph" style="background-image:url(' +
          esc(srcOf(map, m.cover.path)) + ');background-position:' + esc(m.cover.pos || 'center') + '"></div>' : '') +
        '<div class="bcov-shade"></div><div class="bcov-txt">' +
        '<div class="bcov-no">' + esc(m.meta.archiveNo || '人生档案') + '</div>' +
        '<h1 class="bcov-name">' + esc(m.meta.title) + '</h1>' +
        '<div class="bcov-yrs">' + esc(m.meta.years) + (m.meta.hometown ? ' · ' + esc(m.meta.hometown) : '') + '</div>' +
        (m.meta.intro ? '<div class="bcov-intro">「' + esc(m.meta.intro) + '」</div>' : '') +
        '</div>' +
        (m.cover.portrait ? '<div class="bcov-pt"><img src="' + esc(srcOf(map, m.cover.portrait)) + '" alt=""></div>' : '')
    });

    /* 扉页 */
    pages.push({
      kind: 'front',
      html: '<div class="bfront"><h1>' + esc(m.meta.title) + '</h1>' +
        '<div class="bmeta">' + esc(m.meta.years) + (m.meta.hometown ? ' · ' + esc(m.meta.hometown) : '') + '</div>' +
        '<div class="bfacts">' +
        '<div><b>档案编号</b><span>' + esc(m.meta.archiveNo) + '</span></div>' +
        '<div><b>篇幅</b><span>' + m.meta.chapters + ' 章 · 约 ' + m.meta.words + ' 字 · ' + m.meta.photos + ' 幅照片</span></div>' +
        '<div><b>整理日期</b><span>' + esc(m.meta.generatedAt) + '</span></div>' +
        '</div><div class="bhint">点页面右半边往后翻，左半边往回翻</div></div>'
    });

    /* 目录 */
    var toc = '<div class="btoc"><h2>目 录</h2>';
    for (var i = 0; i < m.chapters.length; i++) {
      toc += '<div class="btocrow"><span class="i">' + (i + 1) + '</span>' +
        '<span class="t">' + esc(m.chapters[i].title) + '</span></div>';
    }
    toc += '</div>';
    pages.push({ kind: 'toc', html: toc });

    /* 正文：章题头单独算高度，正文块按测量分页 */
    var meas = document.createElement('div');
    meas.className = 'bk-measure';
    meas.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;';
    document.body.appendChild(meas);

    var innerW = 0, availH = 0, imgH = 0;
    try {
      meas.innerHTML = '<p class="bp">测</p>';
      // 测量盒尺寸在 sizeAndFit 里按页尺寸定；这里先给个临时宽度估算
      innerW = Math.min(420, Math.max(260, (window.innerWidth || 900) * 0.36)) - 76;
      availH = Math.min(window.innerHeight || 700, 720) * 0.80;
      imgH = Math.round(availH * 0.58);
      meas.style.width = innerW + 'px';
      meas.style.height = 'auto';
    } catch (e) {}

    for (var ci = 0; ci < m.chapters.length; ci++) {
      var ch = m.chapters[ci];
      var head = '<div class="bchhead"><div class="rh">第 ' + (ci + 1) + ' 章</div>' +
        '<h2>' + esc(ch.title) + '</h2>' +
        ((ch.years || ch.stage) ? '<div class="cy">' + esc([ch.years, ch.stage].filter(Boolean).join(' · ')) + '</div>' : '') +
        (ch.quote ? '<blockquote class="bq">「' + esc(ch.quote) + '」</blockquote>' : '') +
        '</div>';
      meas.innerHTML = head;
      var headH = meas.scrollHeight;
      var bodyAvail = availH - headH - 34;
      var chunks = paginateBlocks(ch.blocks, map, meas, bodyAvail, imgH);
      for (var pi = 0; pi < chunks.length; pi++) {
        pages.push({ kind: 'body', html: (pi === 0 ? head : '<div class="bchhead bchcont"><div class="rh">第 ' + (ci + 1) + ' 章（续）</div></div>') + chunks[pi] });
      }
    }
    document.body.removeChild(meas);

    /* 结尾页 */
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
    pages.push({
      kind: 'end',
      html: '<div class="bend">' +
        (lastText ? '<div class="bq">「' + esc(lastText) + '……」</div>' : '') +
        '<div class="bn">' + esc(m.meta.title) + ' · ' + esc(m.meta.years) + '<br>由家人整理 · ' + esc(m.meta.generatedAt) + '</div>' +
        '<div class="bfin">— 全书完 —</div></div>'
    });

    return pages;
  }

  /* ---------------- 渲染与翻页交互 ---------------- */

  function open(m, opts) {
    opts = opts || {};
    var th = THEMES[opts.theme || 'paper'] || THEMES.paper;

    var back = document.createElement('div');
    back.className = 'bk-wrap';
    back.innerHTML =
      '<div class="bk-top"><b>' + esc(m.meta.title) + '</b><span class="bk-ind" id="bkInd"></span>' +
      '<button class="bk-x" data-bk-close="1" title="合上书">✕</button></div>' +
      '<div class="bk-stage"><div class="bk-book" id="bkBook"></div></div>' +
      '<div class="bk-navs">' +
      '<button class="bk-nav" data-bk-prev="1" title="上一页">‹</button>' +
      '<span class="bk-tip">翻页：点书页两侧 / 方向键</span>' +
      '<button class="bk-nav" data-bk-next="1" title="下一页">›</button></div>';
    document.body.appendChild(back);

    var book = back.querySelector('#bkBook');
    var ind = back.querySelector('#bkInd');

    /* 尺寸：A5 比例；宽屏双页摊开，窄屏单页 */
    var vh = window.innerHeight || 700, vw = window.innerWidth || 900;
    var pageH = Math.min(vh * 0.78, 700);
    var pageW = pageH / 1.41;
    var spread = vw >= pageW * 2 + 56;
    if (!spread) { pageW = Math.min(vw * 0.92, 480); pageH = pageW * 1.41; if (pageH > vh * 0.78) { pageH = vh * 0.78; pageW = pageH / 1.41; } }

    var pages = buildPages(m, opts);
    /* 两两成叶（书的物理页）：奇数页补白 */
    if (pages.length % 2) pages.push({ kind: 'blank', html: '' });

    var N = pages.length;
    var leaves = N / 2;
    var flipped = 0;              // 已翻过去的叶数
    var curPage = 0;              // 单页模式的当前页
    var animating = false;

    function pageInner(p, no) {
      var foot = (no && p.kind !== 'cover') ? '<div class="bfoot">' + esc(m.meta.title) + ' · ' + no + '</div>' : '';
      return '<div class="bpage bpage-' + p.kind + '">' + p.html + foot + '</div>';
    }

    /* 建叶 */
    var leafEls = [];
    for (var k = 0; k < leaves; k++) {
      var leaf = document.createElement('div');
      leaf.className = 'bk-leaf';
      leaf.innerHTML =
        '<div class="bk-face front">' + pageInner(pages[2 * k], 2 * k + 1) + '</div>' +
        '<div class="bk-face back">' + pageInner(pages[2 * k + 1], 2 * k + 2) + '</div>';
      book.appendChild(leaf);
      leafEls.push(leaf);
    }

    function layout() {
      if (spread) {
        book.style.width = (pageW * 2) + 'px';
        book.style.height = pageH + 'px';
        for (var k2 = 0; k2 < leaves; k2++) {
          var el = leafEls[k2];
          el.style.width = pageW + 'px';
          el.style.height = pageH + 'px';
          el.style.left = pageW + 'px';
          el.style.top = '0';
          var z;
          if (k2 < flipped) z = 10 + k2;             // 左堆：后翻的在上
          else z = 10 + (leaves - k2);               // 右堆：先翻的在上
          el.style.zIndex = z;
          el.style.transform = k2 < flipped ? 'rotateY(-180deg)' : 'rotateY(0deg)';
        }
        // 摊开状态下书脊阴影由 CSS ::before 处理
        var leftNo = flipped > 0 ? flipped * 2 : 0;
        var rightNo = flipped < leaves ? flipped * 2 + 1 : 0;
        ind.textContent = (leftNo && rightNo ? (leftNo + ' - ' + rightNo) : (rightNo || leftNo) || '') +
          ' / ' + N;
      } else {
        book.style.width = pageW + 'px';
        book.style.height = pageH + 'px';
        for (var k3 = 0; k3 < leaves; k3++) {
          leafEls[k3].style.display = 'none';
        }
        drawSingle();
      }
    }

    /* 单页模式：直接显示某一面 */
    function drawSingle() {
      var old = book.querySelector('.bk-single');
      if (old) old.parentNode.removeChild(old);
      var el = document.createElement('div');
      el.className = 'bk-single';
      el.style.width = pageW + 'px';
      el.style.height = pageH + 'px';
      el.innerHTML = pageInner(pages[curPage], curPage + 1);
      book.appendChild(el);
      ind.textContent = (curPage + 1) + ' / ' + N;
    }

    function next() {
      if (animating) return;
      if (spread) {
        if (flipped >= leaves) return;
        var leaf = leafEls[flipped];
        animating = true;
        leaf.style.zIndex = 10 + leaves + 2;
        requestAnimationFrame(function () {
          leaf.style.transform = 'rotateY(-180deg)';
        });
        setTimeout(function () {
          flipped++;
          animating = false;
          layout();
        }, 640);
      } else {
        if (curPage >= N - 1) return;
        animating = true;
        var el = book.querySelector('.bk-single');
        if (el) el.className = 'bk-single bk-turn-l';
        setTimeout(function () {
          curPage++;
          animating = false;
          drawSingle();
        }, 220);
      }
    }

    function prev() {
      if (animating) return;
      if (spread) {
        if (flipped <= 0) return;
        var leaf = leafEls[flipped - 1];
        animating = true;
        leaf.style.zIndex = 10 + leaves + 2;
        requestAnimationFrame(function () {
          leaf.style.transform = 'rotateY(0deg)';
        });
        setTimeout(function () {
          flipped--;
          animating = false;
          layout();
        }, 640);
      } else {
        if (curPage <= 0) return;
        animating = true;
        var el = book.querySelector('.bk-single');
        if (el) el.className = 'bk-single bk-turn-r';
        setTimeout(function () {
          curPage--;
          animating = false;
          drawSingle();
        }, 220);
      }
    }

    /* 事件 */
    back.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      if (t.closest('[data-bk-close]')) { close(); return; }
      if (t.closest('[data-bk-next]')) { next(); return; }
      if (t.closest('[data-bk-prev]')) { prev(); return; }
      if (t.closest('.bk-leaf, .bk-single')) {
        // 点书页：右半边前进，左半边后退
        var rect = book.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        if (x > rect.width * (spread ? 0.5 : 0.62)) next(); else prev();
      }
    });
    function onKey(ev) {
      if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); next(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); prev(); }
      else if (ev.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);

    function close() {
      document.removeEventListener('keydown', onKey);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    back.__close = close;

    layout();
    return { close: close, next: next, prev: prev };
  }

  window.BookFlip = { open: open, buildPages: buildPages };
})();
