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
      var preCh = (window.ML && ML.qs) ? ML.qs('ch') : '';
      for (var i = 0; i < chapters.length; i++) {
        opts += '<option value="' + chapters[i].id + '"' +
          (String(chapters[i].id) === String(preCh) ? ' selected' : '') + '>' +
          esc(chapters[i].title || ('第 ' + (i + 1) + ' 章')) + '</option>';
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

      /** 把参考图缩到 1024 以内再上传，原图动辄几 MB，服务商收不了 */
      function readRef(file, cb) {
        var fr = new FileReader();
        fr.onload = function () {
          var src = String(fr.result || '');
          var img = new Image();
          img.onload = function () {
            var w = img.width || 1, h = img.height || 1, m = Math.max(w, h), lim = 1024;
            if (m <= lim) return cb(src);
            var s = lim / m;
            var cv = document.createElement('canvas');
            cv.width = Math.round(w * s); cv.height = Math.round(h * s);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            try { cb(cv.toDataURL('image/jpeg', 0.9)); } catch (e) { cb(src); }
          };
          img.onerror = function () { cb(src); };
          img.src = src;
        };
        fr.readAsDataURL(file);
      }

      /**
       * 生成面板：提示词可以改、可以带参考图、出图先看，满意了再决定插到哪。
       * 不再一点就按段落文字直出。
       */
      function openArtPanel(entry) {
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML =
          '<div class="ml-modal art-panel">' +
          '<h3>给这一段配一张图</h3>' +
          '<div class="ap-src"><span class="ap-k">这一段</span><p>' + esc(String(entry.text || '').slice(0, 150)) + '</p></div>' +
          '<label class="ap-l">提示词<small>已按这段和画风填好，可以随便改</small>' +
          '<textarea id="apPrompt">' + esc(buildPrompt(entry)) + '</textarea></label>' +
          '<div class="ap-ref"><span class="ap-k">参考图（可选）</span>' +
          '<div class="ap-refrow">' +
          '<button class="btn tiny" id="apRefPick">选一张图做参考</button>' +
          '<img id="apRefImg" class="ap-refimg" alt="">' +
          '<button class="btn tiny" id="apRefClear">去掉</button>' +
          '</div><small class="ap-note">部分模型支持参考图；不支持时服务商会明确报错，去掉参考图或换个模型即可。</small></div>' +
          '<div class="ml-modal-acts">' +
          '<button class="btn primary" id="apGo">生成</button>' +
          '<button class="btn" id="apClose">关闭</button></div>' +
          '<div class="ml-modal-msg" id="apMsg"></div>' +
          '<div id="apOut"></div>' +
          '</div>';
        document.body.appendChild(ov);

        var promptEl = ov.querySelector('#apPrompt');
        var refImg = ov.querySelector('#apRefImg');
        var refClear = ov.querySelector('#apRefClear');
        var refB64 = '';
        refClear.style.display = 'none';

        ov.querySelector('#apRefPick').addEventListener('click', function () {
          var inp = document.createElement('input');
          inp.type = 'file'; inp.accept = 'image/*';
          inp.onchange = function () {
            var f = inp.files && inp.files[0];
            if (!f) return;
            readRef(f, function (dataUrl) {
              refB64 = dataUrl;
              refImg.src = dataUrl; refImg.style.display = 'block'; refClear.style.display = 'inline-block';
            });
          };
          inp.click();
        });
        refClear.addEventListener('click', function () {
          refB64 = ''; refImg.removeAttribute('src'); refImg.style.display = 'none'; refClear.style.display = 'none';
        });
        ov.querySelector('#apClose').addEventListener('click', function () { document.body.removeChild(ov); });
        ov.addEventListener('click', function (ev) { if (ev.target === ov) document.body.removeChild(ov); });

        var go = ov.querySelector('#apGo');
        var out = ov.querySelector('#apOut');
        var msg = ov.querySelector('#apMsg');

        go.addEventListener('click', function () {
          var p = String(promptEl.value || '').trim();
          if (!p) { msg.textContent = '提示词不能为空'; return; }
          go.disabled = true;
          msg.textContent = '正在画……大概 4–8 秒';
          out.innerHTML = '<div class="art-load">画布上正在落笔……</div>';
          var req = { prompt: p, size: '1024x1024' };
          if (refB64) req.refImage = refB64;

          API.image(req).then(function (r) {
            go.disabled = false;
            msg.textContent = '每张约 4–8 秒';
            if (!r || !r.ok) {
              out.innerHTML = '<div class="warn-text">' + esc((r && r.message) || '没画出来') + '</div>';
              return;
            }
            var lastPath = r.path;
            out.innerHTML =
              '<figure class="ap-fig"><img src="' + esc(fsrc(lastPath)) + '" alt="">' +
              '<figcaption>' + esc(r.model || '') + (r.cached ? ' · 缓存' : ' · ' + Math.round((r.ms || 0) / 1000) + 's') + '</figcaption></figure>' +
              '<div class="ap-result">' +
              '<button class="btn tiny primary" data-ap-insert="1">插到这一段后面</button>' +
              '<button class="btn tiny" data-ap-again="1">再画一张</button>' +
              '<button class="btn tiny" data-ap-time="1">存进时间轴</button>' +
              '</div>';

            out.querySelector('[data-ap-again]').addEventListener('click', function () { go.click(); });
            out.querySelector('[data-ap-insert]').addEventListener('click', function () {
              var year = entry.at_year || a.birth_year || 0;
              API.exec('INSERT INTO photos (archive_id,path,taken_year,place,event,chapter_id,role) VALUES (?,?,?,?,?,?,?)',
                [archiveId, lastPath, year, 'AI 插图', 'AI 生成的插图', entry.chapter_id || null, 'inline'])
                .then(function (res) {
                  return DB.insertAfter(archiveId, { afterId: entry.id, kind: 'photo', photoId: res.lastId });
                })
                .then(function () { toast('已插到这一段后面'); document.body.removeChild(ov); })
                .catch(function (e) { toast(e.message || '没插上'); });
            });
            out.querySelector('[data-ap-time]').addEventListener('click', function () {
              var y = window.prompt('这张图放在哪一年？（只填年份）', String(entry.at_year || a.birth_year || ''));
              if (!y) return;
              DB.insertAt({ archiveId: archiveId, year: Number(y), kind: 'photo', photoPath: lastPath, place: 'AI 插图', text: 'AI 生成的插图' })
                .then(function () { toast('已存进 ' + y + ' 年'); document.body.removeChild(ov); })
                .catch(function (e) { toast(e.message || '没存上'); });
            });
          }, function (e) {
            go.disabled = false; msg.textContent = '';
            out.innerHTML = '<div class="warn-text">' + esc(e.message || '请求失败') + '</div>';
          });
        });
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
            '<div class="art-acts"><button class="btn tiny" data-art-panel="' + e.id + '">配一张图</button></div>' +
            '</article>';
        }
        list.innerHTML = html;
      }
      renderList(preCh || '');

      host.querySelector('#artCh').addEventListener('change', function () {
        renderList(this.value);
      });

      list.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t.closest) return;
        var b = t.closest('[data-art-panel]');
        if (!b) return;
        var eid = Number(b.getAttribute('data-art-panel'));
        var entry = null;
        for (var i = 0; i < entries.length; i++) if (String(entries[i].id) === String(eid)) entry = entries[i];
        if (entry) openArtPanel(entry);
      });
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '打不开') + '</div></main>';
    });
  }

  window.ArtUI = { render: render };
})();
