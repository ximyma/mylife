/**
 * 润色：并排看原文与润色稿，逐处对比，人点采纳才生效。
 *
 * 为什么不做"一键全文润色"：口述史的价值在"她原来说的那句话"。
 * AI 只能提建议，采纳权必须留在人手上——所以原文永远是只读的，
 * 润色结果只进 entry_versions，采纳时先把原文存一份 original 再覆盖。
 */
(function () {
  'use strict';

  var ML = window.ML || {};
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (ML.toast) ML.toast(m); }

  /* ---------- 字符级 diff ---------- */
  function diff(a, b) {
    a = String(a || ''); b = String(b || '');
    var n = a.length, m = b.length;
    if (n * m > 250000) {
      return [{ t: '-', v: a }, { t: '+', v: b }];
    }
    var dp = [], i, j;
    for (i = 0; i <= n; i++) { dp[i] = new Array(m + 1); for (j = 0; j <= m; j++) dp[i][j] = 0; }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a.charAt(i) === b.charAt(j)
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [], ii = 0, jj = 0;
    function put(t, ch) {
      var last = out[out.length - 1];
      if (last && last.t === t) last.v += ch;
      else out.push({ t: t, v: ch });
    }
    while (ii < n && jj < m) {
      if (a.charAt(ii) === b.charAt(jj)) { put('=', a.charAt(ii)); ii++; jj++; }
      else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) { put('-', a.charAt(ii)); ii++; }
      else { put('+', b.charAt(jj)); jj++; }
    }
    while (ii < n) { put('-', a.charAt(ii)); ii++; }
    while (jj < m) { put('+', b.charAt(jj)); jj++; }
    return out;
  }

  function renderSide(parts, keep) {
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.t === '=') out += esc(p.v);
      else if (p.t === keep) out += '<mark class="' + (keep === '-' ? 'd-del' : 'd-add') + '">' + esc(p.v) + '</mark>';
    }
    return out;
  }

  /* ---------- 抽屉 ---------- */

  function open(entryId, onDone) {
    Promise.all([
      API.query('SELECT * FROM entries WHERE id=?', [entryId]),
      DB.listVersions(entryId)
    ]).then(function (r) {
      var e = r[0][0];
      if (!e) throw new Error('找不到这段内容');
      var original = String(e.text || '');
      var versions = r[1] || [];

      var back = document.createElement('div');
      back.className = 'sheet-back';
      back.innerHTML = '<div class="sheet pw">' +
        '<div class="sheet-hd"><b>润色这段</b><button class="sheet-x" data-pw-close="1">✕</button></div>' +
        '<div class="sheet-bd">' +
        '<div class="pw-styles" id="pwStyles"></div>' +
        '<p class="hint dim" id="pwTip">原文只读，润色结果要你点「采纳」才会替换。</p>' +
        '<div class="pw-cols">' +
        '<div class="pw-col"><div class="pw-h">原文</div><div class="pw-body" id="pwA"></div></div>' +
        '<div class="pw-col"><div class="pw-h">润色稿<em id="pwModel"></em></div>' +
        '<div class="pw-body" id="pwB"><span class="muted">还没有，先点下面的「润色这一段」</span></div></div>' +
        '</div>' +
        (versions.length ? '<div class="pw-hist"><div class="pw-h">历史</div><div id="pwHist"></div></div>' : '') +
        '</div>' +
        '<div class="sheet-ft">' +
        '<button class="btn" data-pw-close="1">关闭</button>' +
        '<button class="btn" id="pwRun">润色这一段</button>' +
        '<button class="btn primary" id="pwUse" disabled>采纳</button>' +
        '</div></div>';
      document.body.appendChild(back);

      var style = 'keep';
      var cur = null;

      function renderStyles() {
        var o = '';
        for (var k in DB.POLISH_STYLES) {
          if (!Object.prototype.hasOwnProperty.call(DB.POLISH_STYLES, k)) continue;
          o += '<button class="chip' + (style === k ? ' on' : '') + '" data-style="' + k + '">' +
            esc(DB.POLISH_STYLES[k].n) + '</button>';
        }
        back.querySelector('#pwStyles').innerHTML = o;
        back.querySelector('#pwTip').textContent =
          DB.POLISH_STYLES[style].tip + ' · 原文只读，采纳后才替换。';
      }

      function renderOriginal(parts) {
        back.querySelector('#pwA').innerHTML = parts
          ? renderSide(parts, '-')
          : esc(original);
      }

      renderStyles();
      renderOriginal(null);

      function renderHist() {
        var box = back.querySelector('#pwHist');
        if (!box) return;
        var h = '';
        for (var i = 0; i < versions.length; i++) {
          var v = versions[i];
          h += '<div class="pw-v"><span class="pw-vk">' +
            (v.kind === 'original' ? '原文存档' : (v.style || v.kind)) + '</span>' +
            '<span class="pw-vs ' + esc(v.status) + '">' + esc(v.status) + '</span>' +
            '<span class="pw-vt">' + esc(String(v.text || '').slice(0, 40)) + '…</span>' +
            (v.kind === 'original'
              ? '<button class="linkbtn" data-restore="' + v.id + '">退回这一版</button>' : '') +
            '</div>';
        }
        box.innerHTML = h;
      }
      if (versions.length) renderHist();

      back.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t.closest) return;
        if (t.closest('[data-pw-close]')) { back.remove(); return; }
        var sb = t.closest('[data-style]');
        if (sb) { style = sb.getAttribute('data-style'); renderStyles(); return; }
        var rb = t.closest('[data-restore]');
        if (rb) {
          var vid = Number(rb.getAttribute('data-restore'));
          if (!window.confirm('把这段退回到那个版本？当前文字会先存一份原文档。')) return;
          DB.restoreVersion(vid).then(function () {
            toast('已退回');
            back.remove();
            if (onDone) onDone();
          }).catch(function (e) { toast(e.message || '退不回'); });
        }
      });

      back.querySelector('#pwRun').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = '正在润色…';
        DB.polishEntry(entryId, style).then(function (res) {
          cur = res;
          var parts = diff(original, res.text);
          renderOriginal(parts);
          back.querySelector('#pwB').innerHTML = renderSide(parts, '+');
          back.querySelector('#pwModel').textContent = res.profile ? (' · ' + res.profile) : '';
          back.querySelector('#pwUse').disabled = false;
          btn.disabled = false;
          btn.textContent = '再润一次';
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = '润色这一段';
          back.querySelector('#pwB').innerHTML = '<span class="warn-text">' + esc(err.message || '失败') + '</span>';
        });
      });

      back.querySelector('#pwUse').addEventListener('click', function () {
        if (!cur) return;
        this.disabled = true;
        DB.acceptVersion(cur.id).then(function () {
          toast('已采纳，原文已另存一份');
          back.remove();
          if (onDone) onDone();
        }).catch(function (e) {
          toast(e.message || '采纳失败');
        });
      });
    }).catch(function (e) { toast(e.message || '打不开'); });
  }

  window.PolishUI = { open: open, diff: diff };
})();
