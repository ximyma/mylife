/**
 * v0.9.17 素材箱（随手记 / 随口说 / 随手拍）+ 数据安全承诺书。
 * 和 cover / timeline / chat 一样是拆出去的界面模块：
 * app.js 只管路由，业务 SQL 在 db.js，这里只管摆界面、接事件。
 * 刻意 ES5——安卓 5/6 的 WebView 内核老。
 */
(function () {
  'use strict';

  var esc = function (s) { return window.ML.esc(s); };
  var fsrc = function (p) { return window.ML.fsrc(p); };
  var toast = function (m) { window.ML.toast(m); };

  /* ================= 数据安全承诺书 ================= */

  var PROMISE_ITEMS = [
    ['你的数据，只存在这台设备里。',
     '档案、照片、录音全部保存在本机。没有注册、没有账号、没有云后台——我们想看也看不到。'],
    ['上传模型的那句话，是你自己授权的。',
     'AI 功能要用你自己申请的模型密钥。只有你点「生成」的那一段文字会发给你选的模型平台，密钥也只存在你本机。'],
    ['随时可以带走全部数据。',
     '一键导出整本档案（含照片与录音），格式公开的 JSON。任何一天想换软件、想自己收着，都不用问我们。'],
    ['不玩「两年不登录就删你数据」那一套。',
     '本机存储没有登录也就没有「不活跃」。哪天你想清掉，也是你自己动手，我们永远不会替你删。'],
    ['删除就是真删除。',
     '你删掉的档案、照片、录音，从磁盘上移除，不进回收站，不留备份。'],
    ['这套承诺写在产品里，不是写在营销页上。',
     '程序完全开源可查，代码即承诺。'],
  ];

  function renderPromise(appEl) {
    var items = '';
    for (var i = 0; i < PROMISE_ITEMS.length; i++) {
      items += '<div class="pm-item"><b>' + (i + 1) + '. ' + esc(PROMISE_ITEMS[i][0]) + '</b>' +
        '<p>' + esc(PROMISE_ITEMS[i][1]) + '</p></div>';
    }
    var full = '《数据安全承诺书》\n\n';
    for (i = 0; i < PROMISE_ITEMS.length; i++) {
      full += (i + 1) + '. ' + PROMISE_ITEMS[i][0] + '\n' + PROMISE_ITEMS[i][1] + '\n\n';
    }
    appEl.innerHTML = window.ML.topbar({ back: '#/', title: '数据安全承诺' }) +
      '<main class="wrap narrow promise-page">' +
      '<p class="pm-lead">一句话版本：<b>数据是你的，不是我们的。</b>下面每一条都对应产品里的真实做法：</p>' +
      items +
      '<div class="row"><button class="btn" id="pmCopy">复制全文</button></div>' +
      '<p class="muted small">本承诺适用本程序全部版本（电脑版 / 网页版 / 安卓版）。</p></main>';

    document.getElementById('pmCopy').onclick = function () {
      var done = function () { window.ML.toast('已复制，可以粘贴给家人看'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).then(done, function () { fallbackCopy(full, done); });
      } else fallbackCopy(full, done);
    };
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { window.ML.toast('复制失败，请手动选择文字'); }
    document.body.removeChild(ta);
  }

  /* ================= 素材箱 ================= */

  var R = { on: false, native: false, chunks: [], ctx: null, started: 0, peak: 0,
            stream: null, proc: null, src: null, mute: null, path: '' };

  /* 素材多选 / 导出（v0.9.39） */
  var selIds = {}, selMode = false;

  function render(appEl, opts) {
    opts = opts || {};
    appEl.innerHTML = window.ML.topbar({
      back: '#/', title: '素材箱',
      right: [{ href: '#/promise', text: '承诺书' }]
    }) +
      '<main class="wrap narrow inbox-page">' +
      '<p class="muted inbox-lead">随手记，不着急整理。想到什么记什么、说什么、拍什么——' +
      '攒到一批点「AI 归纳」出一篇短文，或一条条「收进档案」。</p>' +
      '<div class="inbox-acts">' +
      '<button class="btn rec-btn" id="qRecBtn"><span class="dot"></span> <b>说一段</b></button>' +
      '<button class="btn" id="qPhotoBtn">拍一张 / 选照片</button>' +
      '<input type="file" id="qPhotoFile" accept="image/*" hidden>' +
      '<button class="btn ghost" id="qSumBtn">✨ AI 归纳这一批</button>' +
      '</div>' +
      '<div class="inbox-acts2">' +
      '<button class="btn tiny" id="qSelBtn">选择 / 导出素材</button>' +
      '<button class="btn tiny ghost" id="qImportBtn">导入素材</button>' +
      '<input type="file" id="qMatFile" accept=".json,application/json" multiple hidden>' +
      '</div>' +
      '<div id="qSelBar" class="q-selbar" hidden>' +
      '<span class="q-selbar-n" id="qSelN">已选 0 条</span>' +
      '<button class="btn tiny" id="qSelAll">全选</button>' +
      '<button class="btn tiny primary" id="qSelExport">导出所选</button>' +
      '<button class="btn tiny ghost" id="qSelNone">取消选择</button>' +
      '</div>' +
      '<div id="qRecState" class="muted small rec-state"></div>' +
      '<div id="qSumBox" hidden></div>' +
      '<div id="qAiBox"></div>' +
      '<div id="qList" class="q-list"><div class="boot">正在翻素材箱……</div></div>' +
      '<div id="qDone"></div>' +
      '<div id="qOrphan"></div>' +
      '</main>';

    document.getElementById('qRecBtn').onclick = toggleRec;
    document.getElementById('qPhotoBtn').onclick = function () {
      document.getElementById('qPhotoFile').click();
    };
    document.getElementById('qPhotoFile').onchange = onPickPhoto;
    document.getElementById('qSumBtn').onclick = aiSummarize;
    document.getElementById('qSelBtn').onclick = function () { setSelMode(!selMode); };
    document.getElementById('qImportBtn').onclick = function () {
      document.getElementById('qMatFile').click();
    };
    document.getElementById('qMatFile').onchange = onImportMaterials;
    document.getElementById('qSelAll').onclick = function () { selAll(true); };
    document.getElementById('qSelExport').onclick = function () { exportSelected(this); };
    document.getElementById('qSelNone').onclick = function () { setSelMode(false); };
    selIds = {};
    selMode = false;

    if (!canRec()) {
      var st = document.getElementById('qRecState');
      st.textContent = '这台设备不支持录音，可以打字（首页「记一句」）或拍照';
      document.getElementById('qRecBtn').disabled = true;
    }

    loadList();
    loadAiMade();
    loadOrphan();
    bindOrphan(document.getElementById('qOrphan'));
    bindAiBox(document.getElementById('qAiBox'));
    if (opts.autoRec && canRec()) toggleRec();
    if (opts.autoPhoto) document.getElementById('qPhotoFile').click();
  }

  /* ---- AI 产的料：画过的图、合成的片子、作的曲，生成即落库，这里统一翻得到 ---- */

  var aiRows = [];   // loadAiMade 的查询结果，点击按钮时按序号取

  function loadAiMade() {
    var box = document.getElementById('qAiBox');
    if (!box) return;
    window.API.query("SELECT capability, path, prompt, model FROM ai_assets ORDER BY id DESC LIMIT 18")
      .then(function (rows) {
        if (!rows || !rows.length) { box.innerHTML = ''; aiRows = []; return; }
        aiRows = rows;
        var html = '<h2 class="sec-label">AI 产 的 料</h2><div class="ai-grid">';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var icon = r.capability === 'video' ? '🎬' : '🎵';
          var ops = '';
          if (r.capability === 'image') {
            ops = '<button class="btn tiny" data-ai-arch="' + i + '">收进档案</button>' +
                  '<button class="btn tiny" data-ai-gal="' + i + '">存到相册</button>';
          } else if (r.capability === 'video') {
            ops = '<button class="btn tiny" data-ai-arch="' + i + '">收进档案</button>';
          } else {
            ops = '<span class="muted small">在「歌本」页管理</span>';
          }
          html += '<figure class="ai-asset">' +
            '<a class="art-thumb" href="' + esc(fsrc(r.path)) + '" target="_blank" ' +
            'title="' + esc(String(r.prompt || '').slice(0, 60)) + '">' +
            (r.capability === 'image'
              ? '<img src="' + esc(fsrc(r.path)) + '" alt="" loading="lazy">'
              : '<span class="ai-asset-icon">' + icon + '</span>') +
            '</a>' +
            '<figcaption class="ai-asset-cap">' + esc(String(r.prompt || '').slice(0, 18)) + '</figcaption>' +
            '<div class="ai-asset-ops">' + ops + '</div>' +
            '</figure>';
        }
        html += '</div><p class="muted small">「收进档案」先进待归档，回档案页再「放进某章 / 插到某段」；「存到相册」直接进手机相册的「岁月记录助手」相簿。</p>';
        box.innerHTML = html;
      }).catch(function () { box.innerHTML = ''; aiRows = []; });   // 老库没有 ai_assets 就不显示这一区
  }

  /** 选一本档案收进去：先进待归档照片/合成的片子，归章在档案页做 */
  function aiIntoArchive(r, btn) {
    window.API.query('SELECT id, subject_name FROM archives ORDER BY id DESC').then(function (list) {
      if (!list || !list.length) { toast('还没有档案，先回首页建一本'); return; }
      var chips = '';
      for (var i = 0; i < list.length; i++) {
        chips += '<button class="chip" data-ai-arch-id="' + list[i].id + '" data-ai-arch-name="' +
          esc(list[i].subject_name || '') + '">' + esc(list[i].subject_name || ('档案 ' + list[i].id)) + '</button>';
      }
      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal pick-modal"><h3>收进哪本档案？</h3>' +
        '<p class="hint dim">' + (r.capability === 'video' ? '片子进「合成的片子」' : '图先进待归档照片，再放进某章或插到某段') + '</p>' +
        '<div class="pick-grid">' + chips + '</div>' +
        '<div class="ml-modal-acts"><button class="btn" data-ai-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (!ev.target.closest) return;
        if (ev.target === ov || ev.target.closest('[data-ai-cancel]')) {
          document.body.removeChild(ov); return;
        }
        var ab = ev.target.closest('[data-ai-arch-id]');
        if (!ab) return;
        var aid = Number(ab.getAttribute('data-ai-arch-id'));
        var aname = ab.getAttribute('data-ai-arch-name') || '';
        var sql, params;
        if (r.capability === 'video') {
          sql = 'INSERT INTO media (archive_id,kind,path,mime,bytes,caption) VALUES (?,?,?,?,?,?)';
          params = [aid, 'video', r.path, 'video/mp4', null, String(r.prompt || 'AI 片子').slice(0, 120)];
        } else {
          sql = 'INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)';
          params = [aid, r.path, 0, 'AI 插图', String(r.prompt || 'AI 插图').slice(0, 40)];
        }
        window.API.exec(sql, params).then(function () {
          document.body.removeChild(ov);
          if (btn) { btn.textContent = '已收进'; btn.disabled = true; }
          toast('存进《' + aname + '》了，' + (r.capability === 'video' ? '档案首页「合成的片子」' : '待归档照片里') + '能看到');
        }).catch(function (e) { toast(e.message || '没存上'); });
      });
    }).catch(function (e) { toast('翻档案失败：' + (e.message || e)); });
  }

  function aiToGallery(r, btn) {
    window.API.gallery({ path: r.path }).then(function (g) {
      if (!g || !g.ok) throw new Error((g && g.message) || '没存上');
      if (btn) { btn.textContent = '已存'; btn.disabled = true; }
      toast('存到 ' + (g.where || '系统相册') + ' 了');
    }).catch(function (e) { toast(e.message || '没存上'); });
  }

  function bindAiBox(box) {
    box.addEventListener('click', function (ev) {
      if (!ev.target.closest) return;
      var ab = ev.target.closest('[data-ai-arch]');
      if (ab) {
        var r1 = aiRows[Number(ab.getAttribute('data-ai-arch'))];
        if (r1) aiIntoArchive(r1, ab);
        return;
      }
      var gb = ev.target.closest('[data-ai-gal]');
      if (gb) {
        var r2 = aiRows[Number(gb.getAttribute('data-ai-gal'))];
        if (r2) aiToGallery(r2, gb);
      }
    });
  }

  /* ---- 列表 ---- */

  function loadList() {
    window.DB.listQuick().then(function (list) {
      var box = document.getElementById('qList');
      if (!box) return;
      if (!list.length) {
        box.innerHTML = '<div class="empty"><div class="empty-icon">🧺</div>' +
          '<div class="empty-title">素材箱是空的</div>' +
          '<p class="muted">记忆不用等「有空」，现在就说一句。</p></div>';
      } else {
        var html = '';
        for (var i = 0; i < list.length; i++) html += quickCard(list[i]);
        box.innerHTML = html;
        bindCards(box);
        if (selMode) {
          var cbs = box.querySelectorAll('[data-q-check]');
          for (var j = 0; j < cbs.length; j++) {
            if (selIds[Number(cbs[j].getAttribute('data-q-check'))]) cbs[j].checked = true;
          }
          paintSelBar();
        }
      }
      loadDone();
    }).catch(function (e) { window.ML.fail(e); });
  }

  function quickCard(q) {
    var kept = q.status === 'kept';
    var body = '';
    if (q.kind === 'photo' && q.media_path) {
      body += '<img class="q-thumb" src="' + esc(fsrc(q.media_path)) + '" alt="">';
    }
    if (q.kind === 'audio' && q.media_path) {
      body += '<audio class="q-audio" controls preload="none" src="' + esc(fsrc(q.media_path)) + '"></audio>';
    }
    if (q.kind === 'video' && q.media_path) {
      body += '<video class="q-thumb" controls preload="none" src="' + esc(fsrc(q.media_path)) + '"></video>';
    }
    var txt = String(q.text || '').trim();
    if (q.kind === 'audio' && !txt) {
      body += '<div class="muted small">还没转成文字。' +
        '<button class="btn tiny" data-q-asr="' + q.id + '">转成文字</button></div>';
    } else if (txt) {
      body += '<div class="q-text">' + esc(txt) + '</div>';
    } else if (q.kind === 'photo') {
      body += '<div class="muted small">还没写说明。收录的时候补一句</div>';
    }
    var when = String(q.created_at || '').slice(0, 16);
    var acts = kept
      ? '<button class="btn tiny" data-q-go="' + q.id + '">去看看</button>' +
        '<button class="btn tiny danger" data-q-del="' + q.id + '">删</button>'
      : '<button class="btn tiny primary" data-q-adopt="' + q.id + '">收进档案</button>' +
        '<button class="btn tiny danger" data-q-del="' + q.id + '">删</button>';
    return '<div class="q-card' + (kept ? ' q-kept' : '') + '" data-q="' + q.id + '">' +
      '<label class="q-check"><input type="checkbox" data-q-check="' + q.id + '"><i></i></label>' +
      '<div class="q-kind">' + (q.kind === 'photo' ? '📷 照片' : q.kind === 'video' ? '🎬 视频' :
        q.kind === 'audio' ? '🎙️ 录音' : '✏️ 文字') +
      (kept ? ' <span class="q-kept-tag" title="录音和文字都还留在素材箱，不要了自己删">✓ 已进《' +
        esc(q.subject_name || '档案') + '》</span>' : '') +
      ' <span class="muted small">' + esc(when) + '</span></div>' +
      body +
      '<div class="q-acts">' + acts +
      '</div></div>';
  }

  /** 收了以后总得能找到：点「去看看」直接跳到它在档案里的那一章 */
  function gotoQuick(id) {
    window.DB.getQuick(id).then(function (q) {
      if (!q.archive_id) { toast('这条素材还没收进档案'); return; }
      if (!q.entry_id) { location.hash = '#/a/' + q.archive_id; return; }
      window.API.query('SELECT chapter_id FROM entries WHERE id=?', [q.entry_id]).then(function (r) {
        var ch = r.length ? r[0].chapter_id : null;
        location.hash = '#/a/' + q.archive_id + (ch ? '/ch/' + ch : '');
      }).catch(function () { location.hash = '#/a/' + q.archive_id; });
    }).catch(function () {});
  }

  function bindCards(box) {
    box.onclick = function (ev) {
      var b;
      if ((b = ev.target.closest('[data-q-asr]'))) return doAsr(Number(b.getAttribute('data-q-asr')));
      if ((b = ev.target.closest('[data-q-adopt]'))) return openAdopt(Number(b.getAttribute('data-q-adopt')));
      if ((b = ev.target.closest('[data-q-go]'))) return gotoQuick(Number(b.getAttribute('data-q-go')));
      if ((b = ev.target.closest('[data-q-del]'))) {
        var id = Number(b.getAttribute('data-q-del'));
        if (!confirm('这条素材不要了？删了就找不回来')) return;
        window.DB.removeQuick(id).then(function () {
          delete selIds[id];
          loadList();
        }).catch(window.ML.fail);
      }
    };
    box.onchange = function (ev) {
      var cb = ev.target;
      if (!cb || !cb.getAttribute || !cb.getAttribute('data-q-check')) return;
      var cid = Number(cb.getAttribute('data-q-check'));
      if (cb.checked) selIds[cid] = 1; else delete selIds[cid];
      paintSelBar();
    };
  }

  /* ---- 选素材：单选 / 多选 / 全选，导出成一个文件带到别的终端（v0.9.39） ---- */

  function setSelMode(on) {
    selMode = !!on;
    var list = document.getElementById('qList');
    var bar = document.getElementById('qSelBar');
    if (list) list.className = 'q-list' + (selMode ? ' selmode' : '');
    if (bar) bar.hidden = !selMode;
    if (!selMode) {
      selIds = {};
      var cbs = document.querySelectorAll('[data-q-check]');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
    }
    paintSelBar();
  }

  function selAll(on) {
    var cbs = document.querySelectorAll('[data-q-check]');
    for (var i = 0; i < cbs.length; i++) {
      cbs[i].checked = !!on;
      var id = Number(cbs[i].getAttribute('data-q-check'));
      if (on) selIds[id] = 1; else delete selIds[id];
    }
    paintSelBar();
  }

  function selCount() {
    var n = 0, k;
    for (k in selIds) if (selIds.hasOwnProperty(k)) n++;
    return n;
  }

  function paintSelBar() {
    var el = document.getElementById('qSelN');
    if (el) el.textContent = '已选 ' + selCount() + ' 条';
    var b = document.getElementById('qSelExport');
    if (b) b.disabled = selCount() === 0;
  }

  /** 桌面端（EXE / 静态站）：内存够用，一次打成一个文件（老行为） */
  function exportAllAtOnce(btn, ids) {
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打包…'; }
    var back = function () { if (btn) { btn.disabled = false; btn.textContent = old; } };
    window.DB.exportMaterials(ids).then(function (pack) {
      back();
      var mb = (pack.bytes || 0) / 1048576;
      if (pack.missing) toast(pack.missing + ' 个文件读不出来，包里会缺这几个');
      var fname = '素材-' + new Date().toISOString().slice(0, 10) + '.mylife-materials.json';
      var body = JSON.stringify(pack);
      if (window.NativeIO && window.NativeIO.saveExport) {
        var ok = window.NativeIO.saveExport(body, fname);
        toast(ok ? ('已存到手机 Download 目录：' + pack.count + ' 条素材')
                 : '保存失败，可能一次选太多了，少选几段再试');
      } else {
        var blob = new Blob([body], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        toast('已导出 ' + fname + '（' + pack.count + ' 条，约 ' + Math.round(mb) + ' MB）');
      }
    }).catch(function (e) { back(); window.ML.fail(e); });
  }

  /**
   * 导出选中的素材。
   * 手机端必须分卷：一次性把 170MB 读进内存再 JSON.stringify，WebView 直接 OOM 闪退
   * （实测小米9 全选 30 条 → App 进程消失、Download 里空手）。这里按每卷 16MB 切，
   * 存成「素材-日期-第N卷.mylife-materials.json」，导入时一次勾选这几个文件就行。
   */
  function exportSelected(btn) {
    var ids = [], k;
    for (k in selIds) if (selIds.hasOwnProperty(k)) ids.push(Number(k));
    if (!ids.length) { toast('先勾几条素材'); return; }

    var NIO = window.NativeIO;
    /* 桌面浏览器没有原生接口，内存也够：整包一次导（老路径） */
    if (!(NIO && NIO.saveExport)) return exportAllAtOnce(btn, ids);

    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打包…'; }
    var back = function () { if (btn) { btn.disabled = false; btn.textContent = old; } };
    var date = new Date().toISOString().slice(0, 10);
    var fname = '素材-' + date + '.mylife-materials.json';

    /* 新版原生接口：边读边写同一个文件，内存只占一条素材（171MB 也不会崩） */
    if (NIO.exportBegin) {
      if (!NIO.exportBegin(fname)) {
        back();
        return toast('存不进去：检查手机存储空间，或到「设置 → 应用 → 岁月记录助手 → 权限」打开存储');
      }
      var okWrite = true;
      var head = '{"format":"mylife-materials","version":1,"exported_at":"' +
        new Date().toISOString() + '","count":' + ids.length + ',"items":[';
      /* b64 全是 ASCII，一个字符就是一个字节：累计写入的字符数就是文件大小 */
      var written = head.length;
      okWrite = NIO.exportAppend(head);
      window.DB.exportMaterialsStream(ids, function (txt, m) {
        if (!okWrite) return null;
        var piece = (m.first ? '' : ',') + txt;
        written += piece.length;
        okWrite = NIO.exportAppend(piece);
        if (btn && (m.index % 3 === 0 || m.index === m.count)) {
          btn.textContent = '正在打包…' + m.index + '/' + m.count;
        }
        return null;
      }).then(function (r) {
        if (okWrite) okWrite = NIO.exportAppend(']}');
        var ok = NIO.exportEnd();
        back();
        if (!ok || !okWrite) {
          return toast('写到一半断了，文件可能不完整；少选几条再试一次');
        }
        var msg = '存到 Download 了：' + r.count + ' 条素材，约 ' +
          (Math.round((written + 2) / 104857.6) / 10) + ' MB';
        if (r.missing) msg += '（' + r.missing + ' 个文件读不到，那几条只有文字）';
        toast(msg);
        setSelMode(false);
      }).catch(function (e) {
        try { NIO.exportAbort(); } catch (x) {}
        back();
        window.ML.fail(e);
      });
      return;
    }

    /* 老版原生接口（没升级的 APK）：按 16MB 分卷，多个文件，内存也不会爆 */
    var savedN = 0, missing = 0, failN = 0;
    window.DB.exportMaterialsByVolume(ids, 16 * 1024 * 1024, function (pack, n) {
      var fn = '素材-' + date + '-第' + n + '卷.mylife-materials.json';
      var ok = false;
      try { ok = !!NIO.saveExport(JSON.stringify(pack), fn); } catch (e) { ok = false; }
      if (ok) savedN += pack.count; else failN++;
      missing += pack.missing || 0;
      if (btn) btn.textContent = '正在打包…第 ' + n + ' 卷';
      return Promise.resolve(ok);
    }).then(function (r) {
      back();
      var msg = '存好 ' + (r.parts || 0) + ' 个文件，共 ' + savedN + ' 条素材（都在 Download）';
      if (missing) msg += '；' + missing + ' 个文件读不到';
      if (failN) msg += '；有 ' + failN + ' 卷没存进去，再试一次';
      toast(msg);
      setSelMode(false);
    }).catch(function (e) { back(); window.ML.fail(e); });
  }

  function onImportMaterials(ev) {
    var inp = ev.target;
    var files = [].slice.call(inp.files || []);
    inp.value = '';
    if (!files.length) return;
    var tip = document.getElementById('qRecState');
    var added = 0, missing = 0, skipped = 0, bad = 0;

    function done() {
      if (tip) tip.textContent = '';
      if (!added && !skipped) return toast('一个也没导进来，看看文件是不是素材导出包');
      var m = '导入好了：' + added + ' 条素材';
      if (missing) m += '，' + missing + ' 个文件缺失';
      if (bad) m += '，' + bad + ' 个文件读不出来';
      if (skipped) m += '，' + skipped + ' 个不是素材包';
      toast(m);
      loadList();
    }

    function next(i) {
      if (i >= files.length) return done();
      var f = files[i];
      if (f.size > 200 * 1024 * 1024) { bad++; return next(i + 1); }
      var fr = new FileReader();
      fr.onload = function () {
        var pack;
        try { pack = JSON.parse(String(fr.result)); }
        catch (e) { bad++; return next(i + 1); }
        if (!pack || pack.format !== 'mylife-materials' || !pack.items) { skipped++; return next(i + 1); }
        if (tip) tip.textContent = '正在导入第 ' + (i + 1) + '/' + files.length + ' 个文件……';
        window.DB.importMaterials(pack).then(function (r) {
          added += r.done || 0;
          missing += r.missing || 0;
          next(i + 1);
        }).catch(function (e) {
          bad++;
          next(i + 1);
        });
      };
      fr.onerror = function () { bad++; next(i + 1); };
      fr.readAsText(f);
    }

    if (tip) tip.textContent = '';
    next(0);
  }

  function loadDone() {
    window.DB.listQuickDone().then(function (list) {
      var box = document.getElementById('qDone');
      if (!box || !list.length) return;
      var html = '<h3 class="q-done-title">最近收进档案的</h3>';
      for (var i = 0; i < Math.min(list.length, 5); i++) {
        var q = list[i];
        var icon = q.kind === 'audio' ? '🎙️ ' : q.kind === 'photo' ? '📷 ' : '';
        var t = String(q.text || '');
        html += '<div class="q-done-item muted small">' + icon +
          esc(t.slice(0, 40)) + (t.length > 40 ? '…' : '') + ' → <b>' +
          esc(q.subject_name || '档案') + '</b>' +
          '<button class="linkbtn" data-q-go="' + q.id + '">去看看</button></div>';
      }
      box.innerHTML = html;
      box.onclick = function (ev) {
        var b = ev.target.closest && ev.target.closest('[data-q-go]');
        if (!b) return;
        gotoQuick(Number(b.getAttribute('data-q-go')));
      };
    }).catch(function () {});
  }

  /* ---- 找不到的录音：文件还在磁盘上，但没挂进任何档案（老版本收进档案只搬了文字） ---- */

  var orphanRows = [];

  function loadOrphan() {
    var box = document.getElementById('qOrphan');
    if (!box) return;
    window.DB.listOrphanAudio().then(function (list) {
      orphanRows = list || [];
      if (!orphanRows.length) { box.innerHTML = ''; return; }
      var html = '<h3 class="q-done-title">🔍 还有 ' + orphanRows.length + ' 段录音没挂进档案</h3>' +
        '<p class="muted small">早先版本把录音「收进档案」时只搬了文字，声音留在设备上没跟过去。' +
        '点「放进档案」就能找回来（先进待归档，再放进某一章）。</p>';
      for (var i = 0; i < orphanRows.length; i++) {
        var o = orphanRows[i];
        var kb = o.bytes ? ' · ' + Math.round(o.bytes / 1024) + ' KB' : '';
        html += '<div class="q-card q-orphan">' +
          '<div class="q-kind">🎙️ 录音 <span class="muted small">' + esc(o.name) + esc(kb) + '</span></div>' +
          '<audio class="q-audio" controls preload="none" src="' + esc(fsrc(o.path)) + '"></audio>' +
          '<div class="q-acts"><button class="btn tiny primary" data-orphan-add="' + i + '">放进档案</button></div>' +
          '</div>';
      }
      box.innerHTML = html;
    }).catch(function () { box.innerHTML = ''; });
  }

  function bindOrphan(box) {
    if (!box) return;
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-orphan-add]');
      if (!b) return;
      var o = orphanRows[Number(b.getAttribute('data-orphan-add'))];
      if (o) orphanIntoArchive(o);
    });
  }

  function orphanIntoArchive(o) {
    window.DB.listArchives().then(function (arcs) {
      if (!arcs || !arcs.length) { toast('先在首页建一本档案'); return; }
      var chips = '';
      for (var i = 0; i < arcs.length; i++) {
        chips += '<button class="chip" data-orphan-arc="' + arcs[i].id + '">' +
          esc(arcs[i].subject_name || ('档案 ' + arcs[i].id)) + '</button>';
      }
      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal pick-modal"><h3>这段录音放进哪本档案？</h3>' +
        '<p class="hint dim">先进待归档，回档案页再放进某一章；文字空着的话，可以在档案里补一句说明。</p>' +
        '<div class="pick-grid">' + chips + '</div>' +
        '<div class="ml-modal-acts"><button class="btn" data-orphan-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (!ev.target.closest) return;
        if (ev.target === ov || ev.target.closest('[data-orphan-cancel]')) {
          document.body.removeChild(ov); return;
        }
        var ab = ev.target.closest('[data-orphan-arc]');
        if (!ab) return;
        var aid = Number(ab.getAttribute('data-orphan-arc'));
        window.DB.attachAudioFile(aid, o.path, '').then(function () {
          document.body.removeChild(ov);
          toast('录音放进档案了，回档案页就能听到');
          loadOrphan();
        }).catch(function (e) { toast(e.message || '没放进去'); });
      });
    }).catch(function (e) { toast('翻档案失败：' + (e.message || e)); });
  }

  /* ---- 说一段：录音（原生壳优先，浏览器兜底），停了自动转写 ---- */

  function canRec() {
    return !!(window.NativeRec || (typeof MediaRecorder !== 'undefined' &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }

  function toggleRec() {
    if (R.on) return stopRec();
    var NATIVE = window.NativeRec;
    if (NATIVE) return startRecNative();
    startRecWeb('');
  }

  function setRecState(t) {
    var el = document.getElementById('qRecState');
    if (el) el.textContent = t;
  }

  function recBtnOn(on) {
    var b = document.getElementById('qRecBtn');
    if (!b) return;
    if (on) { b.className = 'btn rec-btn on'; b.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>'; }
    else { b.className = 'btn rec-btn'; b.innerHTML = '<span class="dot"></span> <b>说一段</b>'; }
  }

  function startRecNative() {
    var NATIVE = window.NativeRec;
    var st = '';
    try { st = String(NATIVE.state() || ''); } catch (e) { st = ''; }
    if (st.indexOf('granted') < 0) {
      setRecState('正在请求麦克风权限……');
      window.__micPerm = function (r) {
        window.__micPerm = null;
        if (String(r) === 'granted') doStartNative();
        else setRecState('系统没放行麦克风（' + r + '）。到「设置 → 应用 → 权限」打开麦克风再试');
      };
      try { NATIVE.ask(); } catch (e) { window.__micPerm = null; setRecState('要不了麦克风权限：' + e.message); }
      return;
    }
    doStartNative();
  }

  function doStartNative() {
    var NATIVE = window.NativeRec;
    var name = 'quick-' + Date.now() + '.wav';
    var r = '';
    try { r = String(NATIVE.start(window.API.auth.token(), name) || ''); } catch (e) { r = 'err:' + e.message; }
    if (r.indexOf('ok') !== 0) {
      setRecState('录音开不了（' + r.replace(/^err:/, '') + '），试试打字或拍照');
      return;
    }
    R.on = true; R.native = true; R.peak = 0; R.started = Date.now();
    recBtnOn(true);
    R.tick = setInterval(function () {
      if (!R.on) return;
      var sec = 0;
      try { sec = Number(NATIVE.seconds()) || 0; } catch (e) {}
      setRecState('正在听…… 已录 ' + sec + ' 秒');
    }, 500);
  }

  function startRecWeb(nativeErr) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { setRecState('这个浏览器内核太老，录不了音' + (nativeErr ? '（' + nativeErr + '）' : '') + '，可以打字或拍照'); return; }
    var ctx;
    try { ctx = new AC(); } catch (e) { setRecState('音频通道打不开（' + e.name + '）'); return; }
    var kick = (ctx.state === 'suspended') ? ctx.resume() : Promise.resolve();
    kick.then(function () {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }).then(function (stream) {
      R.chunks = []; R.native = false; R.started = Date.now(); R.peak = 0;
      var src = ctx.createMediaStreamSource(stream);
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = function (e) {
        if (!R.on) return;
        var d = e.inputBuffer.getChannelData(0);
        R.chunks.push(new Float32Array(d));
        var pk = 0;
        for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
        if (pk > R.peak) R.peak = pk;
        setRecState('正在听…' + (pk < 0.01 ? '（几乎没有声音，检查麦克风）' : ''));
        if (R.chunks.length * 4096 / ctx.sampleRate > 600) stopRec();
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      R.ctx = ctx; R.src = src; R.proc = proc; R.stream = stream; R.mute = mute;
      R.on = true;
      recBtnOn(true);
      setRecState('正在听……');
    }).catch(function (e) {
      setRecState('录音打不开（' + ((e && e.name) || '未知') + '）' +
        (nativeErr ? '；原生录音也失败：' + nativeErr : '') + '。可以打字或拍照');
    });
  }

  function stopRec() {
    if (!R.on) return;
    R.on = false;
    recBtnOn(false);
    if (R.native) return stopRecNative();
    try { if (R.proc) R.proc.disconnect(); } catch (e) {}
    try { if (R.src) R.src.disconnect(); } catch (e) {}
    try { if (R.mute) R.mute.disconnect(); } catch (e) {}
    try { if (R.stream) R.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (R.ctx) R.ctx.close(); } catch (e) {}

    if (R.peak < 0.01) { setRecState('这段全是静音，没存。再试一次'); return; }

    var rate = R.ctx ? R.ctx.sampleRate : 48000;
    var buf = window.ML.buildWav(R.chunks, rate, 16000);
    var bytes = new Uint8Array(buf);
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    var b64 = btoa(bin);
    var sec = Math.round((Date.now() - R.started) / 1000);
    saveAudio('quick-' + R.started + '.wav', b64, sec);
  }

  function stopRecNative() {
    var NATIVE = window.NativeRec;
    if (R.tick) { clearInterval(R.tick); R.tick = 0; }
    var out = null;
    try { out = JSON.parse(String(NATIVE.stop() || '{}')); } catch (e) { out = null; }
    if (!out || !out.ok) { setRecState('这段没存下来：' + ((out && out.err) || '一个字节都没录到')); return; }
    if (Number(out.peak) < 0.01) {
      try { NATIVE.cancel(); } catch (e) {}
      setRecState('这段全是静音。看看有没有挡到麦克风孔，再录一次');
      return;
    }
    window.DB.addQuick('audio', '', out.path, Number(out.seconds) || null)
      .then(function () {
        setRecState('录音存好了 ' + out.seconds + ' 秒，正在转成文字…');
        return doAsrLast();
      })
      .then(loadList)
      .catch(window.ML.fail);
  }

  function saveAudio(name, b64, sec) {
    setRecState('正在保存录音…');
    window.API.file({ op: 'save', kind: 'audio', name: name, base64: b64 }).then(function (r) {
      if (!r || !r.path) throw new Error('录音没存下来');
      return window.DB.addQuick('audio', '', r.path, sec).then(function () {
        setRecState('录音存好了 ' + sec + ' 秒，正在转成文字…');
        return doAsrLast();
      }).then(loadList);
    }).catch(function (e) { setRecState(''); window.ML.fail(e); });
  }

  /** 刚录的那条（id 最大的 open 素材）去转写 */
  function doAsrLast() {
    return window.DB.listQuick().then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].kind === 'audio' && list[i].media_path) return transcribe(list[i].id, false);
      }
      return null;
    });
  }

  function doAsr(id) { return transcribe(id, true); }

  function transcribe(id, reload) {
    setRecState('正在转成文字，说得多就多等一会儿……');
    return window.DB.getQuick(id).then(function (q) {
      return window.API.asr({ path: q.media_path });
    }).then(function (r) {
      setRecState('');
      if (!r || !r.ok || !r.text) throw new Error((r && r.message) || '没转出来，点「转成文字」再试');
      return window.DB.updateQuick(id, { text: r.text }).then(function () {
        window.ML.toast('转好了');
        if (reload) loadList();
      });
    }).catch(function (e) {
      setRecState('');
      window.ML.fail(e);
    });
  }

  /* ---- 拍一张 ---- */

  function onPickPhoto(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    window.ML.compress(f, function (dataUrl) {
      var raw = dataUrl;
      var comma = raw.indexOf(',');
      if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
      window.API.file({ op: 'save', kind: 'photo', name: 'quick-' + Date.now() + '.jpg', base64: raw })
        .then(function (r) {
          if (!r || !r.path) throw new Error((r && r.message) || '照片没存下来');
          return window.DB.addQuick('photo', '', r.path, null);
        })
        .then(loadList)
        .catch(window.ML.fail);
    });
  }

  /* ---- AI 归纳这一批 ---- */

  function aiSummarize() {
    window.DB.listQuick().then(function (list) {
      if (!list.length) { window.ML.toast('素材箱是空的'); return; }
      var lines = [];
      for (var i = 0; i < list.length; i++) {
        var t = String(list[i].text || '').trim();
        if (t) lines.push((i + 1) + '. ' + t.slice(0, 300));
      }
      if (!lines.length) {
        window.ML.toast('这批素材还没有文字（录音先转写），归纳不了');
        return;
      }
      var btn = document.getElementById('qSumBtn');
      btn.disabled = true;
      var box = document.getElementById('qSumBox');
      box.hidden = false;
      box.innerHTML = '<div class="q-sum"><div class="boot">正在把这几条串起来读一遍……</div></div>';
      var prompt =
        '下面是一位用户随手记录的家庭记忆碎片（有的来自口述转写，文字口语化）。' +
        '请把它们整理成一篇 300-500 字的短文《这几天的家庭记忆》：保留具体的人名、年份、地点，' +
        '把碎片串成通顺的叙述，不要添油加醋编造没有的细节。最后单独一行列出' +
        '「值得收进档案的条目：1、3」这样的编号建议。\n\n' + lines.join('\n');
      window.API.ai({ messages: [{ role: 'user', content: prompt }], maxTokens: 1200 })
        .then(function (r) {
          btn.disabled = false;
          if (!r || !r.ok) throw new Error((r && r.message) || '模型没回话');
          var text = r.text || '';
          box.innerHTML = '<div class="q-sum"><h3>✨ 这几天的家庭记忆（AI 草稿）</h3>' +
            '<div class="q-sum-text">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
            '<div class="row"><button class="btn tiny" id="qSumCopy">复制</button>' +
            '<button class="btn tiny" id="qSumHide">收起</button></div></div>';
          document.getElementById('qSumCopy').onclick = function () {
            fallbackCopy(text, function () { window.ML.toast('已复制'); });
          };
          document.getElementById('qSumHide').onclick = function () { box.hidden = true; };
        })
        .catch(function (e) {
          btn.disabled = false;
          box.hidden = true;
          window.ML.fail(e);
        });
    }).catch(window.ML.fail);
  }

  /* ---- 收进档案 ---- */

  function openAdopt(id) {
    var DB = window.DB;
    DB.getQuick(id).then(function (q) {
      return DB.listArchives().then(function (arcs) {
        if (!arcs.length) {
          window.ML.toast('先在首页建一本档案，再把素材收进去');
          return;
        }
        var opts = '';
        for (var i = 0; i < arcs.length; i++) {
          opts += '<option value="' + arcs[i].id + '">' + esc(arcs[i].subject_name) + '</option>';
        }
        /* 照片问「在哪儿/什么事」；录音和视频问「要不要一起带进档案」；其余就是把文字收进去 */
        var mediaBlock = '';
        if (q.kind === 'photo') {
          mediaBlock =
            '<label>在哪儿<input class="fi" id="adPlace" placeholder="老家 / 北京……"></label>' +
            '<label>这张照片是什么事<input class="fi" id="adEvent" placeholder="全家福 / 搬新家……"></label>' +
            (q.media_path ? '<img class="q-thumb" src="' + esc(fsrc(q.media_path)) + '" alt="">' : '');
        } else {
          if ((q.kind === 'audio' || q.kind === 'video') && q.media_path) {
            var kindLabel = q.kind === 'video' ? '视频' : '录音';
            mediaBlock += (q.kind === 'video'
              ? '<video class="q-thumb" controls preload="none" src="' + esc(fsrc(q.media_path)) + '"></video>'
              : '<audio class="q-audio" controls preload="none" src="' + esc(fsrc(q.media_path)) + '"></audio>') +
              '<p class="hint dim">只把文字放进档案。' + kindLabel +
              '和这条素材都原样留在素材箱，哪天不想要了自己删。</p>' +
              '<label class="chk"><input type="checkbox" id="adAudioToo">' + kindLabel +
              '也一起带进档案（默认不带）</label>';
          }
          mediaBlock += '<label>以这段文字收进档案（可改）' +
            '<textarea class="fi" id="adText" rows="4">' + esc(q.text || '') + '</textarea></label>';
        }

        var m = window.ML.modalBox('收进档案',
          '<label>收进哪本档案<select class="fi" id="adArc">' + opts + '</select></label>' +
          (q.kind === 'photo' ? '' :
            '<label>放进哪一章<select class="fi" id="adCh">' +
            '<option value="0">先放「待归档」，回档案页再归章</option></select></label>') +
          '<label>发生在哪一年<input class="fi" id="adYear" inputmode="numeric" ' +
          'placeholder="1975（可点右边的按钮让 AI 判断）"></label>' +
          '<button class="btn tiny" id="adYearAi">🤖 AI 帮我判断年份</button>' +
          mediaBlock +
          '<div class="ml-modal-acts"><button class="btn" id="adCancel">再放放</button>' +
          '<button class="btn primary" id="adOk">收进去</button></div>');

        document.getElementById('adCancel').onclick = m.close;

        /* 选了档案就把它的章列出来：直接归到某一章，省得回档案页再找一遍 */
        function fillChapters() {
          var sel = document.getElementById('adCh');
          if (!sel) return;
          var aid = Number(document.getElementById('adArc').value) || 0;
          sel.innerHTML = '<option value="0">先放「待归档」，回档案页再归章</option>';
          if (!aid) return;
          window.API.query('SELECT id, title FROM chapters WHERE archive_id=? ORDER BY seq, id', [aid])
            .then(function (chs) {
              var html = '<option value="0">先放「待归档」，回档案页再归章</option>';
              for (var i = 0; i < (chs || []).length; i++) {
                var t = String(chs[i].title || '').replace(/^[^·]*·\s*/, '') || ('第 ' + (i + 1) + ' 章');
                html += '<option value="' + chs[i].id + '">' + (i + 1) + '. ' + esc(t) + '</option>';
              }
              sel.innerHTML = html;
            }).catch(function () {});
        }
        var arcSel = document.getElementById('adArc');
        if (arcSel) { arcSel.onchange = fillChapters; fillChapters(); }
        document.getElementById('adYearAi').onclick = function () {
          var src = q.kind === 'photo'
            ? (q.text || '') + ' ' + (document.getElementById('adEvent').value || '')
            : document.getElementById('adText').value;
          if (!String(src).trim()) { m.msg('先写点内容，AI 才有得判断'); return; }
          document.getElementById('adYearAi').textContent = '正在想……';
          window.API.ai({
            messages: [{ role: 'user', content:
              '从下面这段家庭记忆里判断事件大概发生的公元年份。只回一个四位数字年份，不要别的。\n\n' +
              String(src).slice(0, 500) }],
            maxTokens: 16
          }).then(function (r) {
            var ym = r && r.ok ? String(r.text || '').match(/(1[89]\d{2}|20\d{2})/) : null;
            if (ym) document.getElementById('adYear').value = ym[1];
            else m.msg('没判断出来，手动填一个吧');
            document.getElementById('adYearAi').textContent = '🤖 AI 帮我判断年份';
          }).catch(function (e) {
            m.msg(e.message || '判断失败');
            document.getElementById('adYearAi').textContent = '🤖 AI 帮我判断年份';
          });
        };

        document.getElementById('adOk').onclick = function () {
          var arcId = Number(document.getElementById('adArc').value);
          var year = parseInt(document.getElementById('adYear').value, 10) || null;
          if (!arcId) { m.msg('选一本档案'); return; }
          if (q.kind === 'photo') {
            var place = document.getElementById('adPlace').value.trim();
            var event = document.getElementById('adEvent').value.trim();
            if (!place || !event) { m.msg('照片要标「在哪儿、什么事」才能进档案'); return; }
            // 读回原图，走正式照片入库（编年、进目录、上封面都和补内容页一样）
            window.API.file({ op: 'read', path: q.media_path }).then(function (f) {
              if (!f || !f.base64) throw new Error('照片文件读不回来了');
              return DB.addPhoto(arcId, f.base64, year, place, event,
                'quick-' + q.id + '.jpg');
            }).then(function () {
              return DB.markQuickAdopted(q.id, arcId, null);
            }).then(function () {
              // 原图已经另存进照片库了，素材里这份留着就是白占地方（尽力而为，删不掉也不影响）
              if (q.media_path) {
                window.API.exec("UPDATE quick_notes SET media_path='' WHERE id=?", [q.id]).catch(function () {});
                window.API.file({ op: 'del', path: q.media_path }).catch(function () {});
              }
            }).then(function () {
              m.close();
              window.ML.toast('照片收进档案了');
              loadList();
            }).catch(function (e) { m.msg(e.message || String(e)); });
          } else {
            var text = document.getElementById('adText').value.trim();
            var chEl = document.getElementById('adCh');
            var chId = chEl ? (Number(chEl.value) || 0) : 0;
            var tooEl = document.getElementById('adAudioToo');
            var bringAudio = !!(tooEl && tooEl.checked);
            DB.adoptQuick(q.id, arcId, year, text, { chapterId: chId || null, bringAudio: bringAudio })
              .then(function (r) {
                m.close();
                window.ML.toast('收进档案了' + (chId ? '，已归到那一章' : '（先放待归档）') +
                  (r && r.keptAudio ? '；录音留在素材箱' : ''));
                loadList();
              }).catch(function (e) { m.msg(e.message || String(e)); });
          }
        };
      });
    }).catch(window.ML.fail);
  }

  window.InboxUI = {
    render: render,
    renderPromise: renderPromise,
  };
})();
