/**
 * 主题曲：把一本档案写成一首歌。
 *
 * 诚实的边界：国内没有稳定可用的"文字直接生成带唱歌曲"的接口，
 * 所以这里做的是三级方案里能落地的那两级——
 *   ① 歌词（模型写，可改）＋ 朗读（TTS 念白）＋ 配乐（Web Audio 氛围）
 *   ② 只有歌词：导出成文本，自己拿去任何音乐工具里做
 * 真·带唱的音乐接口留了口子（ai_slots.music），一旦有可用供应商，这里换一个调用即可。
 *
 * v0.9.5：界面上把「用哪些内容写」和「写词要求」分成两块，写清楚各自是干什么的，
 * 并且能在生成前看见这次到底会把哪些字喂给模型——不然人不知道歌是从哪儿来的。
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

  var MATERIAL_LIMIT = 5000;   // 喂给模型的材料字数上限，超了按章顺序截断

  function render(host, archiveId) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq, id', [archiveId]),
      API.query("SELECT id, chapter_id, at_year, text FROM entries WHERE archive_id=? AND kind IN ('text','quote') " +
        'ORDER BY COALESCE(sort_key,seq,0), id', [archiveId]),
      API.query('SELECT v FROM settings WHERE k=?', ['song.' + archiveId]),
      API.query('SELECT v FROM settings WHERE k=?', ['song.material.' + archiveId])
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], entries = r[2];
      var saved = (r[3][0] && r[3][0].v) || '';
      var savedMat = (r[4][0] && r[4][0].v) || '';
      if (!a) throw new Error('找不到这本档案');

      var picked = {};   // 选了哪些章：空对象 = 全部
      var allOn = true;

      var chChips = '';
      for (var i = 0; i < chapters.length; i++) {
        var t = String(chapters[i].title || '').replace(/^[^·]*·\s*/, '') || ('第 ' + (i + 1) + ' 章');
        chChips += '<button class="chip on" data-song-ch="' + chapters[i].id + '">' + esc(t) + '</button>';
      }

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '主题曲' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">为 ' + esc(a.subject_name) + ' 写一首歌</h1>' +
        '<p class="muted">两件事分开填：先定「用哪些内容写」，再定「怎么写」。只用档案里真实的地名、物件和事。</p></section>' +

        '<section class="sc-step">' +
        '<h2 class="sec-label">一 · 用 什 么 内 容 写</h2>' +
        '<p class="hint dim">下面这些章就是写歌的素材来源。默认全选；只想写某一段人生，就点掉不要的章。</p>' +
        (chapters.length
          ? '<div class="cw-chips" id="songChs">' + chChips + '</div>'
          : '<p class="tip-warn">这本档案还没有目录。先去档案页把目录排出来，再来写歌。</p>') +
        '<div class="song-count" id="songCount"></div>' +
        '<label class="ap-l">自己再补一段材料<small>可选。想写进去的原话、小名、口头禅、某个细节，粘在这里</small>' +
        '<textarea id="songMaterial" placeholder="例如：她总说「吃饱了不想家」；院里那棵枣树是 1963 年栽的">' +
        esc(savedMat) + '</textarea></label>' +
        '<details class="sc-pv"><summary>看看这次会带哪些内容（点开预览）</summary>' +
        '<pre id="songPv">—</pre></details>' +
        '</section>' +

        '<section class="sc-step">' +
        '<h2 class="sec-label">二 · 怎 么 写</h2>' +
        '<label class="ap-l">写词要求<small>可选。风格、情绪、长短、要不要押韵；留空按默认（三段式、每句 7–11 字）</small>' +
        '<textarea id="songExtra" placeholder="例如：轻快一点；写童年在乡下的部分；提到稻田和石桥；不要出现「岁月」二字"></textarea></label>' +
        '</section>' +

        '<section class="song-card">' +
        '<h2 class="sec-label">三 · 歌 词</h2>' +
        '<div class="song-lyr" id="songLyr">' + (saved ? esc(saved) : '') + '</div>' +
        '<div class="song-acts">' +
        '<button class="btn primary" id="songGen">生成歌词</button>' +
        '<button class="btn" id="songRead">念给我听</button>' +
        '<button class="btn" id="songSave">存为主题曲</button>' +
        '</div>' +
        '<p class="hint dim" id="songTip">生成会用「设置 → 模型来源」里的文字模型，一次约几百字。' +
        '配乐在「设置 → 朗读音色与配乐」里选。</p>' +
        '</section></main>';

      var lyr = host.querySelector('#songLyr');
      var tip = host.querySelector('#songTip');
      var countEl = host.querySelector('#songCount');
      var pvEl = host.querySelector('#songPv');
      var matEl = host.querySelector('#songMaterial');

      /* --- 选章 / 统计 / 预览 --- */
      function chosenChapters() {
        var out = [];
        for (var k = 0; k < chapters.length; k++) {
          if (allOn || picked[chapters[k].id]) out.push(chapters[k].id);
        }
        return out;
      }

      function materials() {
        var ids = chosenChapters(), pick = {};
        for (var k = 0; k < ids.length; k++) pick[ids[k]] = 1;
        var rows = [];
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (!pick[e.chapter_id]) continue;
          var txt = String(e.text || '').trim();
          if (txt) rows.push({ year: e.at_year, text: txt });
        }
        return rows;
      }

      function refresh() {
        var rows = materials();
        var chars = 0;
        for (var i = 0; i < rows.length; i++) chars += rows[i].text.length;
        var nCh = chosenChapters().length;
        countEl.textContent = '已选 ' + nCh + ' 章 · ' + rows.length + ' 段 · 约 ' + chars + ' 字' +
          (chars > MATERIAL_LIMIT ? '（超出 ' + MATERIAL_LIMIT + ' 字的部分不会被带上）' : '');

        var head = rows.slice(0, 40).map(function (x) {
          return (x.year ? x.year + ' ' : '') + x.text.slice(0, 60);
        }).join('\n');
        pvEl.textContent = (rows.length ? head : '（还没选到内容）') +
          (matEl && matEl.value.trim() ? '\n\n+ 自己补的：' + matEl.value.trim().slice(0, 200) : '');
      }

      if (chapters.length) {
        host.querySelector('#songChs').addEventListener('click', function (ev) {
          var b = ev.target.closest ? ev.target.closest('[data-song-ch]') : null;
          if (!b) return;
          var cid = b.getAttribute('data-song-ch');
          if (allOn) { allOn = false; picked = {}; for (var k = 0; k < chapters.length; k++) picked[chapters[k].id] = 1; }
          if (picked[cid]) { delete picked[cid]; b.className = 'chip'; }
          else { picked[cid] = 1; b.className = 'chip on'; }
          var any = false;
          for (var kk in picked) if (picked.hasOwnProperty(kk)) any = true;
          if (!any) { allOn = true; var all = host.querySelectorAll('[data-song-ch]'); for (var q = 0; q < all.length; q++) all[q].className = 'chip on'; }
          refresh();
        });
      }
      if (matEl) matEl.addEventListener('input', refresh);
      refresh();

      /* --- 生成 --- */
      host.querySelector('#songGen').addEventListener('click', function () {
        var btn = this;
        var extraEl = host.querySelector('#songExtra');
        var extra = extraEl ? String(extraEl.value || '').trim() : '';
        if (!entries.length) { tip.textContent = '这本档案还没有文字内容，先写几段再来。'; return; }
        if (!chosenChapters().length) { tip.textContent = '至少要选一章。'; return; }

        btn.disabled = true;
        tip.textContent = '正在写……';

        var facts = '';
        try {
          var fj = JSON.parse(a.facts_json || '[]');
          facts = fj.map(function (x) { return x.k + '：' + x.v; }).join('；');
        } catch (e) {}

        var chosen = chosenChapters(), pick = {};
        for (var k = 0; k < chosen.length; k++) pick[chosen[k]] = 1;

        var chron = chapters.filter(function (c) { return pick[c.id]; }).map(function (c) {
          return (c.year_from ? c.year_from + ' ' : '') + String(c.title || '').replace(/^[^·]*·\s*/, '');
        }).join('；');

        var rows = materials();
        var buf = '', used = 0;
        for (var i = 0; i < rows.length; i++) {
          if (used + rows[i].text.length > MATERIAL_LIMIT) break;
          buf += rows[i].text + '\n';
          used += rows[i].text.length;
        }

        var self = matEl ? String(matEl.value || '').trim() : '';
        if (self) DB.saveSetting('song.material.' + archiveId, self).catch(function () {});

        var sys = '你是一位民谣词作者。只写歌词，不要解释、不要标题说明。' +
          '结构：主歌 1（四句）/ 副歌（四句）/ 主歌 2（四句）/ 副歌（重复）/ 尾声（两句）。' +
          '每句 7 到 11 个字。必须至少出现两个下面材料里的真实地名或物件。' +
          '禁止"岁月如歌""时光荏苒""人生如梦"这类套话；写具体的事，不写抽象的情。';

        var user = '档案：' + a.subject_name +
          (a.birth_year ? '，' + a.birth_year + ' 年生' : '') +
          (a.hometown ? '，' + a.hometown + '人' : '') + '。\n' +
          (facts ? '信息：' + facts + '\n' : '') +
          (chron ? '取材的章：' + chron + '\n' : '') +
          (buf ? '材料（原话，按人生顺序）：\n' + buf + '\n' : '') +
          (self ? '用户补充的材料：' + self + '\n' : '') +
          (extra ? '写词要求：' + extra + '\n' : '') +
          '\n请写这首歌的歌词。';

        API.ai({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.9 })
          .then(function (out) {
            btn.disabled = false;
            if (!out || !out.ok) { tip.textContent = '没写成：' + ((out && out.message) || '未知原因'); return; }
            lyr.setAttribute('contenteditable', 'true');
            lyr.textContent = out.text || '';
            tip.textContent = '写好了，可以直接改。改完点「念给我听」。';
          }, function (e) {
            btn.disabled = false;
            tip.textContent = '没写成：' + (e.message || e);
          });
      });

      host.querySelector('#songRead').addEventListener('click', function () {
        var text = String(lyr.textContent || '').trim();
        if (!text) { toast('先写词或者生成一段'); return; }
        if (!window.TTS) { toast('这个版本不能朗读'); return; }
        // 用一个临时容器喂给朗读器：它能逐句高亮，也能带配乐
        var tmp = document.createElement('div');
        tmp.className = 'song-read';
        var p = document.createElement('p');
        p.textContent = text;
        tmp.appendChild(p);
        document.body.appendChild(tmp);
        window.TTS.speakFrom(tmp);
        var clean = function () {
          document.removeEventListener('click', clean);
          setTimeout(function () { if (tmp.parentNode) tmp.parentNode.removeChild(tmp); }, 500);
        };
        document.addEventListener('click', clean);
      });

      host.querySelector('#songSave').addEventListener('click', function () {
        var text = String(lyr.textContent || '').trim();
        if (!text) { toast('还没有词'); return; }
        DB.saveSetting('song.' + archiveId, text).then(function () {
          return API.exec('INSERT INTO ai_assets (archive_id, capability, path, prompt, model) VALUES (?,?,?,?,?)',
            [archiveId, 'lyrics', '', text.slice(0, 120), 'llm']);
        }).then(function () { toast('已存为这本档案的主题曲'); })
          .catch(function (e) { toast(e.message || '没存上'); });
      });

      if (saved) lyr.setAttribute('contenteditable', 'true');
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '打不开') + '</div></main>';
    });
  }

  window.SongUI = { render: render };
})();
