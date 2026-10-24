/**
 * 封面工坊：换封面、设头像、选版式。
 *
 * 封面与头像是两个东西：封面是「一本书的构图」，头像是「这个人的脸」。
 * 可以指向同一张照片，但分开存——换封面不该顺手把头像一起换掉。
 *
 * 版式全部用 CSS + SVG 画，不引入任何图片素材，所以不增加安装包体积。
 */
(function () {
  'use strict';

  var ML = window.ML || {};
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fsrc(p) { return ML.fsrc ? ML.fsrc(p) : ('/files/' + p); }
  function toast(m) { if (ML.toast) ML.toast(m); }

  var STYLES = [
    { k: 'paper', n: '素纸' }, { k: 'vignette', n: '暗角' },
    { k: 'ink', n: '靛蓝' }, { k: 'film', n: '胶片' }
  ];
  var FONTS = [{ k: 'song', n: '宋体' }, { k: 'kai', n: '楷体' }, { k: 'hei', n: '黑体' }];
  var ACCENTS = ['#8B5E3C', '#3A4A5A', '#7B2E2E', '#2F4F3F', '#4A3B57', '#1F1F1F'];
  var POS = [
    ['0% 0%', '0% 50%', '0% 100%'],
    ['50% 0%', '50% 50%', '50% 100%'],
    ['100% 0%', '100% 50%', '100% 100%']
  ];

  /** 供档案页/首页/导出共用的封面渲染 */
  function coverHtml(a, photos, opts) {
    opts = opts || {};
    var cfg = DB.coverConfig(a);
    var cover = null, portrait = null;
    for (var i = 0; i < photos.length; i++) {
      if (String(photos[i].id) === String(a.cover_photo_id)) cover = photos[i];
      if (String(photos[i].id) === String(a.portrait_photo_id)) portrait = photos[i];
    }
    if (!cover && photos.length) cover = photos[0];

    var zoom = Number(cfg.zoom) || 1;
    return '<div class="cv style-' + esc(cfg.style) + '" style="--accent:' + esc(cfg.accent) + '">' +
      (cover
        ? '<div class="cv-photo" style="background-image:url(' + esc(fsrc(cover.path)) + ');' +
          'background-position:' + esc(cfg.pos) + ';background-size:' + Math.round(zoom * 100) + '%"></div>'
        : '<div class="cv-photo cv-blank"></div>') +
      '<div class="cv-shade"></div>' +
      '<div class="cv-txt">' +
      '<div class="cv-no">' + esc(a.archive_no ? '档案第 ' + a.archive_no + ' 号' : '人生档案') + '</div>' +
      '<h1 class="cv-name font-' + esc(cfg.font) + '">' + esc(a.subject_name || '') + '</h1>' +
      '<div class="cv-years">' + esc(DB.yearLabel(a.birth_year, a.death_year)) +
      (a.hometown ? ' · ' + esc(a.hometown) : '') + '</div>' +
      (a.intro ? '<p class="cv-intro">「' + esc(a.intro) + '」</p>' : '') +
      '</div>' +
      (portrait ? '<div class="cv-pt"><img src="' + esc(fsrc(portrait.path)) + '" alt=""></div>' : '') +
      (opts.foot ? '<div class="cv-foot">' + opts.foot + '</div>' : '') +
      '</div>';
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('这个文件读不出来')); };
      fr.readAsDataURL(file);
    });
  }

  /** 压到长边 1600 再存：原图动辄 8MB，封面用不着 */
  function shrink(dataUrl, maxPx) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.width || 1, h = img.height || 1;
        var scale = Math.min(1, (maxPx || 1600) / Math.max(w, h));
        if (scale >= 1) return resolve(dataUrl);
        var cv = document.createElement('canvas');
        cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  function addPhoto(archiveId, dataUrl, eventName, birthYear) {
    var name = 'c' + Date.now() + '.jpg';
    return API.file({ op: 'save', dir: 'photo', name: name, base64: dataUrl }).then(function (f) {
      if (!f.ok) throw new Error(f.message || '照片没存下来');
      return API.exec(
        'INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)',
        [archiveId, f.path, birthYear || new Date().getFullYear(), '未标地点', eventName || '封面照']);
    }).then(function (r) { return r.lastId; });
  }

  /** 头像三档缩略：存到 derived/thumbs，同一张只做一次 */
  function ensureThumbs(path) {
    var sizes = [400, 160, 96];
    return API.query('SELECT params_hash FROM derivations WHERE source_path=?', [path]).then(function (rows) {
      var have = {};
      for (var i = 0; i < rows.length; i++) have[rows[i].params_hash] = 1;
      if (have.thumb400 && have.thumb160 && have.thumb96) return true;
      return API.file({ op: 'read', path: path }).then(function (f) {
        if (!f || !f.base64) return false;
        var src = 'data:image/jpeg;base64,' + f.base64;
        var chain = Promise.resolve();
        sizes.forEach(function (sz) {
          if (have['thumb' + sz]) return;
          chain = chain.then(function () {
            return new Promise(function (resolve) {
              var img = new Image();
              img.onload = function () {
                var w = img.width || 1, h = img.height || 1;
                var side = Math.min(w, h);
                var cv = document.createElement('canvas');
                cv.width = sz; cv.height = sz;
                cv.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, sz, sz);
                var d = cv.toDataURL('image/jpeg', 0.85);
                DB.saveThumb(path, d, sz).then(resolve, resolve);
              };
              img.onerror = function () { resolve(); };
              img.src = src;
            });
          });
        });
        return chain.then(function () { return true; });
      });
    }).then(function (ok) { return ok; }, function () { return false; });
  }

  function open(archiveId, onDone) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      DB.listPhotos(archiveId)
    ]).then(function (r) {
      var a = r[0][0];
      if (!a) throw new Error('找不到这本档案');
      var photos = r[1];
      var cfg = DB.coverConfig(a);
      var state = {
        coverId: a.cover_photo_id || (photos[0] && photos[0].id) || null,
        portraitId: a.portrait_photo_id || null,
        cfg: cfg,
        photos: photos,
      };

      var back = document.createElement('div');
      back.className = 'sheet-back';
      back.innerHTML =
        '<div class="sheet cw">' +
        '<div class="sheet-hd"><b>封面与头像</b><button class="sheet-x" data-cw-close="1">✕</button></div>' +
        '<div class="sheet-bd">' +
        '<div class="cw-stage" id="cwStage"></div>' +
        '<div class="cw-group"><div class="cw-label">封面照片</div>' +
        '<div class="cw-photos" id="cwPhotos"></div>' +
        '<label class="cw-upload"><input type="file" accept="image/*" id="cwFile" hidden>＋ 上传一张</label>' +
        '</div>' +
        '<div class="cw-group"><div class="cw-label">版式</div><div class="cw-chips" id="cwStyles"></div></div>' +
        '<div class="cw-group"><div class="cw-label">标题字体</div><div class="cw-chips" id="cwFonts"></div></div>' +
        '<div class="cw-group"><div class="cw-label">主色</div><div class="cw-dots" id="cwAccents"></div></div>' +
        '<div class="cw-group"><div class="cw-label">取景</div>' +
        '<div class="cw-grid" id="cwPos"></div>' +
        '<label class="cw-zoom">缩放 <input type="range" min="100" max="180" step="5" id="cwZoom"></label>' +
        '</div>' +
        '<div class="cw-group"><div class="cw-label">头像 <small>方图裁成圆，用在首页卡片、封面角标和导出扉页</small></div>' +
        '<div class="cw-photos" id="cwPortrait"></div>' +
        '</div>' +
        '</div>' +
        '<div class="sheet-ft">' +
        '<button class="btn" data-cw-close="1">取消</button>' +
        '<button class="btn primary" id="cwSave">保存</button>' +
        '</div></div>';
      document.body.appendChild(back);

      var stage = back.querySelector('#cwStage');
      var photosBox = back.querySelector('#cwPhotos');
      var portraitBox = back.querySelector('#cwPortrait');

      function renderStage() {
        var fake = {
          archive_no: a.archive_no, subject_name: a.subject_name,
          birth_year: a.birth_year, death_year: a.death_year, hometown: a.hometown, intro: a.intro,
          cover_photo_id: state.coverId, portrait_photo_id: state.portraitId,
          cover_config_json: JSON.stringify(state.cfg),
        };
        stage.innerHTML = coverHtml(fake, state.photos, { foot: '<span>共 ' + (a.status === 'ready' ? '已生成' : '待生成') + '</span>' });
      }

      function renderPhotos() {
        var out = '<button class="cw-thumb' + (state.coverId ? '' : ' on') + '" data-cover="">无</button>';
        for (var i = 0; i < state.photos.length; i++) {
          var p = state.photos[i];
          out += '<button class="cw-thumb' + (String(state.coverId) === String(p.id) ? ' on' : '') +
            '" data-cover="' + p.id + '"><img src="' + esc(fsrc(p.path)) + '" alt=""></button>';
        }
        photosBox.innerHTML = out;

        var po = '<button class="cw-thumb' + (state.portraitId ? '' : ' on') + '" data-pt="">无</button>';
        for (var j = 0; j < state.photos.length; j++) {
          var q = state.photos[j];
          po += '<button class="cw-thumb round' + (String(state.portraitId) === String(q.id) ? ' on' : '') +
            '" data-pt="' + q.id + '"><img src="' + esc(fsrc(q.path)) + '" alt=""></button>';
        }
        portraitBox.innerHTML = po;
      }

      function renderChips() {
        var s = '';
        for (var i = 0; i < STYLES.length; i++) {
          s += '<button class="chip' + (state.cfg.style === STYLES[i].k ? ' on' : '') +
            '" data-style="' + STYLES[i].k + '">' + STYLES[i].n + '</button>';
        }
        back.querySelector('#cwStyles').innerHTML = s;

        var f = '';
        for (var j = 0; j < FONTS.length; j++) {
          f += '<button class="chip' + (state.cfg.font === FONTS[j].k ? ' on' : '') +
            '" data-font="' + FONTS[j].k + '" style="font-family:' + (FONTS[j].k === 'kai' ? 'KaiTi,STKaiti' : (FONTS[j].k === 'hei' ? 'sans-serif' : 'SimSun,serif')) + '">' +
            FONTS[j].n + '</button>';
        }
        back.querySelector('#cwFonts').innerHTML = f;

        var d = '';
        for (var k = 0; k < ACCENTS.length; k++) {
          d += '<button class="dot' + (state.cfg.accent === ACCENTS[k] ? ' on' : '') +
            '" data-accent="' + ACCENTS[k] + '" style="background:' + ACCENTS[k] + '"></button>';
        }
        back.querySelector('#cwAccents').innerHTML = d;

        var g = '';
        for (var r = 0; r < 3; r++) {
          for (var c = 0; c < 3; c++) {
            g += '<button class="pos' + (state.cfg.pos === POS[r][c] ? ' on' : '') +
              '" data-pos="' + POS[r][c] + '"></button>';
          }
        }
        back.querySelector('#cwPos').innerHTML = g;
        back.querySelector('#cwZoom').value = String(Math.round((Number(state.cfg.zoom) || 1) * 100));
      }

      function refresh() { renderStage(); renderPhotos(); renderChips(); }

      back.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t.closest) return;
        if (t.closest('[data-cw-close]')) { back.remove(); return; }

        var cb = t.closest('[data-cover]');
        if (cb && cb.hasAttribute('data-cover')) {
          var v = cb.getAttribute('data-cover');
          state.coverId = v ? Number(v) : null;
          renderStage(); renderPhotos();
          return;
        }
        var pb = t.closest('[data-pt]');
        if (pb && pb.hasAttribute('data-pt')) {
          var pv = pb.getAttribute('data-pt');
          state.portraitId = pv ? Number(pv) : null;
          renderStage(); renderPhotos();
          return;
        }
        var sb = t.closest('[data-style]');
        if (sb) { state.cfg.style = sb.getAttribute('data-style'); refresh(); return; }
        var fb = t.closest('[data-font]');
        if (fb) { state.cfg.font = fb.getAttribute('data-font'); refresh(); return; }
        var ab = t.closest('[data-accent]');
        if (ab) { state.cfg.accent = ab.getAttribute('data-accent'); refresh(); return; }
        var gb = t.closest('[data-pos]');
        if (gb) { state.cfg.pos = gb.getAttribute('data-pos'); refresh(); return; }
      });

      back.querySelector('#cwZoom').addEventListener('change', function () {
        state.cfg.zoom = Number(this.value) / 100;
        renderStage();
      });
      back.querySelector('#cwZoom').addEventListener('input', function () {
        state.cfg.zoom = Number(this.value) / 100;
        renderStage();
      });

      back.querySelector('#cwFile').addEventListener('change', function () {
        var f = this.files && this.files[0];
        if (!f) return;
        readFile(f).then(function (d) { return shrink(d, 1600); }).then(function (d) {
          return addPhoto(archiveId, d, '封面照', a.birth_year).then(function (id) {
            return DB.listPhotos(archiveId).then(function (list) {
              state.photos = list;
              state.coverId = id;
              refresh();
              toast('照片已加进档案');
            });
          });
        }).catch(function (e) { toast(e.message || '上传失败'); });
      });

      back.querySelector('#cwSave').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        Promise.resolve()
          .then(function () { return DB.setCoverPhoto(archiveId, state.coverId); })
          .then(function () { return DB.setPortrait(archiveId, state.portraitId); })
          .then(function () { return DB.saveCoverConfig(archiveId, state.cfg); })
          .then(function () {
            var p = null;
            for (var i = 0; i < state.photos.length; i++) {
              if (String(state.photos[i].id) === String(state.portraitId)) p = state.photos[i];
            }
            if (p) return ensureThumbs(p.path);
            return null;
          })
          .then(function () {
            back.remove();
            toast('封面已更新');
            if (onDone) onDone();
          })
          .catch(function (e) {
            btn.disabled = false;
            toast(e.message || '保存失败');
          });
      });

      refresh();
    }).catch(function (e) { toast(e.message || '打不开封面工坊'); });
  }

  window.CoverUI = { open: open, coverHtml: coverHtml, ensureThumbs: ensureThumbs };
})();
