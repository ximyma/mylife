/**
 * 插图：按条目画一张那个年代的画面。
 *
 * 两个经验写进提示词里，否则出来的图一定「不对」：
 *   ① **年代与地域**：不注入年代，模型默认画现代人（卫衣、牛仔裤、瓷砖墙）；
 *   ② **人物一致性**：给同一个人固定的「人物设定卡」——年龄、发型、衣着、面部特征，
 *      每次生成都带上。做不到 100% 一致，但至少不会每张图换个人。
 *
 * 生成的图右下角由服务商带「AI 生成」标识，这是合规要求，不额外遮挡。
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

  var STYLES = [
    { k: 'photo', n: '年代照片', pre: '纪实摄影，胶片颗粒，褪色老照片，柔和的自然光，', post: '，画质自然，不要出现文字' },
    { k: 'water', n: '水彩', pre: '水彩插画，淡雅晕染，纸纹，', post: '，留白多，不要出现文字' },
    { k: 'comic', n: '连环画', pre: '中国八十年代连环画风格，墨线勾勒，平涂上色，', post: '，不要出现文字' },
    { k: 'ink', n: '水墨', pre: '中国水墨画，宣纸，淡墨渲染，', post: '，不要出现文字' },
    { k: 'oil', n: '油画', pre: '写实油画，厚涂笔触，暖色调，', post: '，不要出现文字' },
    { k: 'paper', n: '剪纸', pre: '中国民间剪纸风格，红纸剪影，边缘利落，', post: '，不要出现文字' },
  ];

  function render(host, archiveId) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      API.query('SELECT * FROM entries WHERE archive_id=? AND kind=? ORDER BY sort_key, seq LIMIT 40', [archiveId, 'text']),
      API.query("SELECT v FROM settings WHERE k=?", ['art.persona.' + archiveId]),
      API.query("SELECT * FROM ai_assets WHERE archive_id IS NULL AND capability='image' ORDER BY id DESC LIMIT 12")
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], entries = r[2], personaRow = r[3][0], gallery = r[4];
      if (!a) throw new Error('找不到这本档案');

      var style = 'photo';
      var persona = (personaRow && personaRow.v) || '';

      var opts = '<option value="">全部</option>';
      for (var i = 0; i < chapters.length; i++) {
        opts += '<option value="' + chapters[i].id + '">' + esc(chapters[i].title || ('第 ' + (i + 1) + ' 章')) + '</option>';
      }

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '插图' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">给这一页画张图</h1>' +
        '<p class="muted">只用档案里真实的年代、地点、事。人物形象按下面的「设定卡」保持前后一致。</p></section>' +

        '<section class="art-set">' +
        '<label class="fi-l">人物设定卡<small>越具体越一致：年龄、发型、脸型、常穿的衣服。留空就按档案基本信息猜。</small>' +
        '<input class="fi" id="artPersona" placeholder="例如：四十岁上下的北方妇女，圆脸，齐耳短发，蓝色劳动布上衣" value="' +
        esc(persona) + '"></label>' +
        '<div class="cw-label">画风</div><div class="cw-chips" id="artStyles"></div>' +
        '<div class="art-row">' +
        '<select class="fi" id="artCh" style="max-width:220px">' + opts + '</select>' +
        '<span class="muted" id="artTip">每张约 4–8 秒</span>' +
        '</div></section>' +

        '<section id="artList"></section>' +
        (gallery.length ? '<section class="art-gal"><h2 class="sec-label">画 过 的</h2><div class="art-grid">' +
          gallery.map(function (g) {
            return '<a class="art-thumb" href="' + esc(fsrc(g.path)) + '" target="_blank">' +
              '<img src="' + esc(fsrc(g.path)) + '" alt="" loading="lazy"></a>';
          }).join('') + '</div></section>' : '') +
        '</main>';

      var list = host.querySelector('#artList');
      var tip = host.querySelector('#artTip');

      function renderStyles() {
        var o = '';
        for (var i = 0; i < STYLES.length; i++) {
          o += '<button class="chip' + (style === STYLES[i].k ? ' on' : '') + '" data-style="' + STYLES[i].k + '">' +
            STYLES[i].n + '</button>';
        }
        host.querySelector('#artStyles').innerHTML = o;
      }
      renderStyles();

      host.querySelector('#artStyles').addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-style]') : null;
        if (!t) return;
        style = t.getAttribute('data-style');
        renderStyles();
      });

      host.querySelector('#artPersona').addEventListener('change', function () {
        persona = this.value;
        DB.saveSetting('art.persona.' + archiveId, persona);
        toast('设定卡已保存，后面每张图都会带上');
      });

      function buildPrompt(entry) {
        var st = null;
        for (var i = 0; i < STYLES.length; i++) if (STYLES[i].k === style) st = STYLES[i];
        var when = entry.at_year ? entry.at_year + '年' : (a.birth_year ? a.birth_year + '年' : '');
        var who = a.subject_name + '，' + (a.hometown ? a.hometown + '人，' : '');
        var scene = String(entry.text || '').slice(0, 180);
        return st.pre + when + '，中国' + (a.hometown || '') + '，' + who +
          '画面：' + scene + '。' + (persona ? '人物形象：' + persona + '。' : '') + st.post;
      }

      function renderList(chId) {
        var mine = entries.filter(function (e) { return !chId || String(e.chapter_id) === String(chId); });
        if (!mine.length) {
          list.innerHTML = '<div class="empty-guide"><h2>这一章还没有文字</h2>' +
            '<p>先去补内容或生成卷宗，再来配图。</p></div>';
          return;
        }
        var html = '';
        for (var i = 0; i < mine.length; i++) {
          var e = mine[i];
          html += '<article class="art-item" data-entry="' + e.id + '">' +
            '<div class="art-txt">' +
            '<div class="art-when">' + (e.at_year ? e.at_year + ' 年' : '年份未填') + '</div>' +
            '<p>' + esc(String(e.text || '').slice(0, 120)) + '</p>' +
            '</div>' +
            '<div class="art-acts"><button class="btn tiny" data-draw="' + e.id + '">画一张</button></div>' +
            '<div class="art-out"></div>' +
            '</article>';
        }
        list.innerHTML = html;
      }
      renderList('');

      host.querySelector('#artCh').addEventListener('change', function () {
        renderList(this.value);
      });

      list.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t.closest) return;

        var db = t.closest('[data-draw]');
        if (db) {
          var eid = Number(db.getAttribute('data-draw'));
          var entry = null;
          for (var i = 0; i < entries.length; i++) if (String(entries[i].id) === String(eid)) entry = entries[i];
          if (!entry) return;
          var item = db.closest('.art-item');
          var out = item.querySelector('.art-out');

          db.disabled = true;
          tip.textContent = '正在画……大概 4–8 秒';
          out.innerHTML = '<div class="art-load">画布上正在落笔……</div>';

          API.image({ prompt: buildPrompt(entry), size: '1024x1024' }).then(function (r) {
            db.disabled = false;
            tip.textContent = '每张约 4–8 秒';
            if (!r || !r.ok) {
              out.innerHTML = '<div class="warn-text">' + esc((r && r.message) || '没画出来') + '</div>';
              return;
            }
            out.innerHTML = '<figure class="art-fig"><img src="' + esc(fsrc(r.path)) + '" alt="">' +
              '<figcaption>' +
              '<span>' + esc(r.model || '') + (r.cached ? ' · 缓存' : ' · ' + Math.round((r.ms || 0) / 1000) + 's') + '</span>' +
              '<button class="btn tiny primary" data-use="' + r.path + '" data-year="' + (entry.at_year || '') + '">存进档案</button>' +
              '</figcaption></figure>';
          }, function (e) {
            db.disabled = false;
            tip.textContent = '每张约 4–8 秒';
            out.innerHTML = '<div class="warn-text">' + esc(e.message || '请求失败') + '</div>';
          });
          return;
        }

        var use = t.closest('[data-use]');
        if (use) {
          var path = use.getAttribute('data-use');
          var year = Number(use.getAttribute('data-year')) || null;
          if (!year) {
            var y = window.prompt('这张图放在哪一年？（只填年份）', String(a.birth_year || ''));
            if (!y) return;
            year = Number(y);
          }
          use.disabled = true;
          DB.insertAt({
            archiveId: archiveId, year: year, kind: 'photo', photoPath: path,
            place: 'AI 插图', text: 'AI 生成的插图',
          }).then(function () {
            toast('已存进 ' + year + ' 年，去时间轴或卷宗看看');
            use.textContent = '已存';
          }).catch(function (e) {
            use.disabled = false;
            toast(e.message || '没存上');
          });
        }
      });
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '打不开') + '</div></main>';
    });
  }

  window.ArtUI = { render: render };
})();
