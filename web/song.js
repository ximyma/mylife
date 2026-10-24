/**
 * 主题曲：把一本档案写成一首歌。
 *
 * 诚实的边界：国内没有稳定可用的"文字直接生成带唱歌曲"的接口，
 * 所以这里做的是三级方案里能落地的那两级——
 *   ① 歌词（模型写，可改）＋ 朗读（TTS 念白）＋ 配乐（Web Audio 氛围）
 *   ② 只有歌词：导出成文本，自己拿去任何音乐工具里做
 * 真·带唱的音乐接口留了口子（ai_slots.music），一旦有可用供应商，这里换一个调用即可。
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

  function render(host, archiveId) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      API.query('SELECT text FROM entries WHERE archive_id=? ORDER BY sort_key LIMIT 40', [archiveId]),
      API.query("SELECT v FROM settings WHERE k=?", ['song.' + archiveId])
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], entries = r[2];
      var saved = (r[3][0] && r[3][0].v) || '';
      if (!a) throw new Error('找不到这本档案');

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '主题曲' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">为 ' + esc(a.subject_name) + ' 写一首歌</h1>' +
        '<p class="muted">只用档案里真实的地名、物件和事。写完可以改，改完能念给你听。</p></section>' +
        '<section class="song-card">' +
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

      host.querySelector('#songGen').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        tip.textContent = '正在写……';

        var facts = '';
        try {
          var fj = JSON.parse(a.facts_json || '[]');
          facts = fj.map(function (x) { return x.k + '：' + x.v; }).join('；');
        } catch (e) {}

        var chron = chapters.map(function (c) {
          return (c.year_from ? c.year_from + ' ' : '') + String(c.title || '').replace(/^[^·]*·\s*/, '');
        }).join('；');
        var lines = entries.map(function (e) { return String(e.text || '').slice(0, 40); }).slice(0, 12).join(' / ');

        var sys = '你是一位民谣词作者。只写歌词，不要解释、不要标题说明。' +
          '结构：主歌 1（四句）/ 副歌（四句）/ 主歌 2（四句）/ 副歌（重复）/ 尾声（两句）。' +
          '每句 7 到 11 个字。必须至少出现两个下面材料里的真实地名或物件。' +
          '禁止"岁月如歌""时光荏苒""人生如梦"这类套话；写具体的事，不写抽象的情。';

        var user = '档案：' + a.subject_name +
          (a.birth_year ? '，' + a.birth_year + ' 年生' : '') +
          (a.hometown ? '，' + a.hometown + '人' : '') + '。\n' +
          (facts ? '信息：' + facts + '\n' : '') +
          (chron ? '章节：' + chron + '\n' : '') +
          (lines ? '原话片段：' + lines + '\n' : '') +
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
