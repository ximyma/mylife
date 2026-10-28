/**
 * 界面与交互。一套代码，网页端与安卓 WebView 完全一致。
 * 刻意用 ES5：安卓 5/6 的 WebView 内核老，模板字符串/箭头函数/可选链都可能不支持。
 */
(function () {
  'use strict';

  /* ---- 老 WebView 补丁：安卓 5/6 的内核没有 closest / startsWith / find ---- */
  if (!Element.prototype.closest) {
    Element.prototype.closest = function (sel) {
      var el = this;
      while (el && el.nodeType === 1) {
        if ((el.matches || el.msMatchesSelector || el.webkitMatchesSelector).call(el, sel)) return el;
        el = el.parentElement;
      }
      return null;
    };
  }
  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (t, pos) {
      return this.substr(pos || 0, String(t).length) === String(t);
    };
  }
  if (!Array.prototype.find) {
    Array.prototype.find = function (fn) {
      for (var i = 0; i < this.length; i++) if (fn(this[i], i, this)) return this[i];
      return undefined;
    };
  }

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search + location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * /files/ 的地址。图片和音频是标签直接 fetch 的，发不了 Authorization 头，
   * 所以统一把 token 挂在 query 上（本地服务也认 cookie，双保险）。
   * 以前安卓端这些地址一律 401，表现就是"照片不显示、录音点不动"。
   */
  function fsrc(p) {
    var path = String(p === null || p === undefined ? '' : p).replace(/^\/+/, '');
    var t = (window.API && API.auth && API.auth.token) ? (API.auth.token() || '') : '';
    return '/files/' + path + (t ? '?token=' + encodeURIComponent(t) : '');
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  function fail(e) {
    toast((e && e.message) ? e.message : String(e));
    if (window.console) console.error(e);
  }

  function go(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  function topbar(opts) {
    opts = opts || {};
    var right = '';
    if (opts.right) {
      for (var i = 0; i < opts.right.length; i++) {
        right += '<a href="' + opts.right[i].href + '">' + esc(opts.right[i].text) + '</a>';
      }
    }
    return '<header class="top"><div class="top-in">' +
      (opts.back ? '<a class="top-back" href="' + opts.back + '">‹</a>' : '') +
      '<span class="logo">' + esc(opts.title || '我的人生档案') + '</span>' +
      '<div class="top-right">' + right + '</div>' +
      '</div></header>';
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  /* 给 v0.5 拆出去的几个模块用（cover / timeline / chat / export）。
     只放纯工具与导航，不放业务——拆出去是为了不再把 app.js 撑大。 */
  window.ML = {
    esc: esc, fsrc: fsrc, toast: toast, fail: fail, go: go,
    topbar: topbar, bytes: bytes, qs: qs,
    openChangePassword: openChangePassword,
    openSetSecurity: openSetSecurity,
    openResetPassword: openResetPassword,
    safeName: function (s) { return String(s || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); },
  };

  /* ---------------- v0.9：账号弹窗（改密 / 密保 / 重置他人） ---------------- */

  function modalBox(title, bodyHtml) {
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal"><h3>' + esc(title) + '</h3>' + bodyHtml +
      '<div class="ml-modal-msg" id="mlmMsg"></div></div>';
    document.body.appendChild(ov);
    ov.onclick = function (e) { if (e.target === ov) close(); };
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    return { ov: ov, close: close, msg: function (t, bad) {
      var el = document.getElementById('mlmMsg');
      if (el) { el.textContent = t || ''; el.style.color = bad ? 'var(--danger)' : 'var(--accent)'; }
    } };
  }

  function openChangePassword() {
    var m = modalBox('修改密码',
      '<div class="fld"><label>原密码</label><input id="cpOld" type="password"></div>' +
      '<div class="fld"><label>新密码（至少 6 位）</label><input id="cpNew" type="password"></div>' +
      '<div class="ml-modal-acts"><button class="btn primary" id="cpOk">确定</button>' +
      '<button class="btn" id="cpCancel">取消</button></div>');
    m.ov.querySelector('#cpCancel').onclick = m.close;
    m.ov.querySelector('#cpOk').onclick = function () {
      var oldP = m.ov.querySelector('#cpOld').value;
      var newP = m.ov.querySelector('#cpNew').value;
      if (!newP || newP.length < 6) { m.msg('新密码至少 6 位', true); return; }
      API.auth.changePassword(oldP, newP).then(function () { toast('密码已修改'); m.close(); })
        .catch(function (e) { m.msg(e.message, true); });
    };
  }

  function openSetSecurity() {
    var m = modalBox('设置密保问题',
      '<p class="hint">忘记密码时可用它自助找回，答案只有你自己知道。</p>' +
      '<div class="fld"><label>密保问题</label><input id="sq" placeholder="例如：我小学班主任姓什么"></div>' +
      '<div class="fld"><label>密保答案</label><input id="sa" placeholder="例如：王"></div>' +
      '<div class="ml-modal-acts"><button class="btn primary" id="sqOk">保存</button>' +
      '<button class="btn" id="sqCancel">取消</button></div>');
    m.ov.querySelector('#sqCancel').onclick = m.close;
    m.ov.querySelector('#sqOk').onclick = function () {
      var q = m.ov.querySelector('#sq').value.trim();
      var a = m.ov.querySelector('#sa').value.trim();
      if (!q || !a) { m.msg('问题和答案都要填', true); return; }
      API.auth.setSecurity(q, a).then(function () { toast('密保已设置'); m.close(); })
        .catch(function (e) { m.msg(e.message, true); });
    };
  }

  function openResetPassword(uid, phone) {
    var m = modalBox('重置密码 · ' + esc(phone),
      '<div class="fld"><label>新密码（至少 6 位）</label><input id="rp" type="password"></div>' +
      '<div class="ml-modal-acts"><button class="btn primary" id="rpOk">确定</button>' +
      '<button class="btn" id="rpCancel">取消</button></div>');
    m.ov.querySelector('#rpCancel').onclick = m.close;
    m.ov.querySelector('#rpOk').onclick = function () {
      var pw = m.ov.querySelector('#rp').value;
      if (!pw || pw.length < 6) { m.msg('新密码至少 6 位', true); return; }
      API.auth.resetUser(uid, pw).then(function () { toast('已重置 ' + phone + ' 的密码'); m.close(); })
        .catch(function (e) { m.msg(e.message, true); });
    };
  }

  /* ---------------- 用户管理（管理员页） ---------------- */

  function renderUsers() {
    app.innerHTML = topbar({ back: '#/settings', title: '用户管理' }) +
      '<main class="wrap narrow"><div class="boot">正在加载用户……</div></main>';
    API.auth.me().then(function (me) {
      if (!me.isAdmin) {
        app.innerHTML = topbar({ back: '#/settings', title: '用户管理' }) +
          '<main class="wrap narrow"><p class="warn-text">只有管理员能管理用户。</p></main>';
        return;
      }
      return API.auth.users().then(function (r) {
        var users = r.users || [];
        var rows = '';
        for (var i = 0; i < users.length; i++) {
          var u = users[i];
          rows += '<div class="usr-row">' +
            '<div class="usr-info"><b>' + esc(u.phone) + '</b>' +
            (u.nickname ? ' <span class="muted">' + esc(u.nickname) + '</span>' : '') +
            (u.isAdmin ? ' <span class="tag">管理员</span>' : '') + '</div>' +
            '<div class="usr-acts">' +
            '<button class="btn tiny" data-rp="' + u.id + '" data-phone="' + esc(u.phone) + '">重置密码</button>' +
            (u.id !== me.uid ? '<button class="btn tiny danger-t" data-del="' + u.id + '" data-phone="' + esc(u.phone) + '">删除</button>' : '') +
            '</div></div>';
        }
        var html = topbar({ back: '#/settings', title: '用户管理' }) + '<main class="wrap narrow">' +
          '<h2 class="set-h">已有用户（' + users.length + '）</h2>' + (rows || '<p class="muted">还没有其它用户</p>') +
          '<h2 class="set-h">添加用户</h2>' +
          '<div class="fld"><label>手机号</label><input id="nuPhone" maxlength="11" placeholder="11 位手机号"></div>' +
          '<div class="fld"><label>昵称（选填）</label><input id="nuNick" placeholder="怎么称呼"></div>' +
          '<div class="fld"><label>初始密码（至少 6 位）</label><input id="nuPw" type="password"></div>' +
          '<label class="chk"><input type="checkbox" id="nuAdmin"> 设为管理员</label>' +
          '<p class="ml-modal-msg" id="nuMsg" style="min-height:16px;color:var(--danger)"></p>' +
          '<button class="btn primary" id="nuAdd" style="width:100%">添加用户</button>' +
          '</main>';
        app.innerHTML = html;
        bindUsers(me);
      });
    }).catch(fail);
  }

  function bindUsers(me) {
    var addBtn = document.getElementById('nuAdd');
    if (addBtn) addBtn.onclick = function () {
      var phone = document.getElementById('nuPhone').value.trim();
      var nick = document.getElementById('nuNick').value.trim();
      var pw = document.getElementById('nuPw').value;
      var isAdm = document.getElementById('nuAdmin').checked;
      var msg = document.getElementById('nuMsg');
      if (!pw || pw.length < 6) { msg.textContent = '初始密码至少 6 位'; return; }
      API.auth.createUser(phone, pw, nick, isAdm).then(function () { toast('已添加用户'); renderUsers(); })
        .catch(function (e) { msg.textContent = e.message; });
    };
    var rows = app.querySelectorAll('[data-rp]');
    for (var i = 0; i < rows.length; i++) {
      (function (el) {
        el.onclick = function () { ML.openResetPassword(Number(el.getAttribute('data-rp')), el.getAttribute('data-phone')); };
      })(rows[i]);
    }
    var dels = app.querySelectorAll('[data-del]');
    for (var j = 0; j < dels.length; j++) {
      (function (el) {
        el.onclick = function () {
          var id = Number(el.getAttribute('data-del'));
          var phone = el.getAttribute('data-phone');
          if (!window.confirm('确定删除用户 ' + phone + '？\n该账号将无法登录，但其档案数据保留（可由管理员找回）。')) return;
          API.auth.deleteUser(id).then(function () { toast('已删除 ' + phone); renderUsers(); })
            .catch(function (e) { alert(e.message); });
        };
      })(dels[j]);
    }
  }

  /* ---------------- 首页 ---------------- */

  function renderHome() {
    app.innerHTML = topbar({ right: [{ href: '#/settings', text: '设置' }] }) +
      '<main class="wrap"><div class="boot">正在读档案……</div></main>';

    DB.listArchives().then(function (list) {
      var cards = '';
      for (var i = 0; i < list.length; i++) {
        var a = list[i];

        // 编辑态：整张卡变成表单（照片清单在进入编辑时已拉好，见 data-arc-edit）
        if (isEdit('archive', a.id)) {
          a.photo_list = (editState.photos || []);  // 进入编辑时已按需拉取
          cards += '<div class="arc-wrap"><div class="arc-card editing">' +
            '<div class="arc-edit-form">' +
            '<label>名字<input class="fi" id="ae-name" value="' + esc(a.subject_name) + '"></label>' +
            '<div class="ae-row">' +
            '<label>出生<input class="fi" id="ae-birth" type="number" value="' + esc(a.birth_year || '') + '"></label>' +
            '<label>离世<input class="fi" id="ae-death" type="number" value="' + esc(a.death_year || '') + '"></label>' +
            '</div>' +
            '<label>籍贯<input class="fi" id="ae-home" value="' + esc(a.hometown || '') + '"></label>' +
            '<label>封面一句话<input class="fi" id="ae-intro" value="' + esc(a.intro || '') + '"></label>' +
            (a.photo_list && a.photo_list.length
              ? '<label>封面照片<select class="fi" id="ae-cover">' +
                '<option value="">自动（第一张）</option>' +
                (function () {
                  var o = '';
                  for (var q = 0; q < a.photo_list.length; q++) {
                    o += '<option value="' + a.photo_list[q].id + '"' +
                      (String(a.cover_photo_id) === String(a.photo_list[q].id) ? ' selected' : '') + '>' +
                      esc(a.photo_list[q].taken_year + ' · ' + a.photo_list[q].event) + '</option>';
                  }
                  return o;
                })() + '</select></label>'
              : '<small class="muted">没有照片可选，封面将自动留空</small>') +
            '</div>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-arc-save="' + a.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button>' +
            '</div></div></div>';
          continue;
        }

        cards += '<div class="arc-wrap">' +
          '<a class="arc-card" href="#/a/' + a.id + '">' +
          '<div class="arc-cover">' +
          (a.cover_path ? '<img src="' + esc(fsrc(a.cover_path)) + '" alt="">' :
            '<span class="arc-empty">档案</span>') +
          (a.portrait_path ? '<img class="arc-pt" src="' + esc(fsrc(a.portrait_path)) + '" alt="">' : '') +
          '</div>' +
          '<div class="arc-meta">' +
          '<div class="arc-no">第 ' + esc(a.archive_no || '—') + ' 号</div>' +
          '<div class="arc-name">' + esc(a.subject_name) + '</div>' +
          '<div class="arc-years">' + esc(DB.yearLabel(a.birth_year, a.death_year)) +
          (a.hometown ? ' · ' + esc(a.hometown) : '') + '</div>' +
          '<div class="arc-stat">' + a.chapter_count + ' 章 · ' + a.entry_count + ' 条 · ' +
          a.photo_count + ' 张照片</div>' +
          '</div></a>' +
          '<div class="arc-tools">' +
          '<button class="arc-export" data-export="' + a.id + '" title="把这本档案连照片带录音存成一个文件">导出</button>' +
          '<button class="arc-export" data-arc-edit="' + a.id + '" title="改名字、生卒、封面">改</button>' +
          '<button class="arc-export danger-t" data-arc-del="' + a.id + '" title="整本删除，含照片和录音">删</button>' +
          '</div></div>';
      }

      var guide = list.length ? '' :
        '<section class="empty-guide">' +
        '<h2>从第一段讲述开始</h2>' +
        '<p class="muted">先把人的名字写下来，其余边讲边补。</p>' +
        '<ol class="steps">' +
        '<li><b>说一段</b><span>想到哪说到哪，不用按顺序。可以打字，也可以录音。</span></li>' +
        '<li><b>加几张照片</b><span>每张标上「哪一年、在哪儿、什么事」，才能被排进目录。</span></li>' +
        '<li><b>点一下生成</b><span>自动按年份分章、排目录、把照片放回原位。</span></li>' +
        '</ol></section>';

      app.innerHTML = topbar({ right: [
        { href: '#/chat', text: 'AI 助手' },
        { href: '#/settings', text: '设置' }
      ] }) +
        '<main class="wrap">' +
        '<section class="hello"><h1 class="h1">我的档案</h1>' +
        '<p class="muted">一个人，一本档案。</p></section>' +
        '<section class="arc-grid">' + cards +
        '<button class="arc-new" id="newBtn"><span>＋</span><b>新建档案</b>' +
        '<small>写下他的名字就能开始</small></button>' +
        '</section>' +
        '<div class="row end"><label class="btn tiny ghost" id="importBtn">导入档案 / Word' +
        '<input type="file" id="importFile" accept=".json,.docx,application/json" hidden></label></div>' +
        guide + '</main>';

      var nb = document.getElementById('newBtn');
      if (nb) nb.onclick = askNew;

      /* --- 导出 / 改 / 删 --- */
      var expHandler = function (ev) {
        var t = ev.target.closest ? ev.target : null;
        if (!t) return;
        var b;

        /* 导出 */
        if ((b = t.closest('[data-export]'))) {
          var aid = Number(b.getAttribute('data-export'));
          b.disabled = true;
          var old = b.textContent;
          b.textContent = '打包中…';
          DB.exportArchive(aid).then(function (pack) {
            var fname = '档案-' + (pack.archive.subject_name || aid) + '-' +
              new Date().toISOString().slice(0, 10) + '.mylife.json';
            b.disabled = false;
            b.textContent = old;
            if (window.NativeIO && window.NativeIO.saveExport) {
              var ok = window.NativeIO.saveExport(JSON.stringify(pack), fname);
              toast(ok ? '已存到手机 Download 目录' : '保存失败');
            } else {
              var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
              var a2 = document.createElement('a');
              a2.href = URL.createObjectURL(blob);
              a2.download = fname;
              document.body.appendChild(a2);
              a2.click();
              document.body.removeChild(a2);
              setTimeout(function () { URL.revokeObjectURL(a2.href); }, 2000);
              toast('已导出 ' + fname);
            }
          }).catch(function (e) {
            b.disabled = false;
            b.textContent = old;
            fail(e);
          });
          return;
        }

        /* 进入编辑：先按需拉照片清单（封面下拉用），再渲染表单 */
        if ((b = t.closest('[data-arc-edit]'))) {
          var eid = Number(b.getAttribute('data-arc-edit'));
          API.query('SELECT id, taken_year, event FROM photos WHERE archive_id=? ORDER BY taken_year', [eid])
            .then(function (rows) {
              editState = { type: 'archive', id: eid, photos: rows };
              route();
            })
            .catch(fail);
          return;
        }
        if ((b = t.closest('[data-edit-cancel]'))) {
          clearEdit();
          return route();
        }

        /* 保存编辑 */
        if ((b = t.closest('[data-arc-save]'))) {
          var sid = Number(b.getAttribute('data-arc-save'));
          var g = function (sel) {
            var el = document.getElementById(sel);
            return el ? el.value : '';
          };
          DB.updateArchive(sid, {
            name: g('ae-name'), birth: g('ae-birth') || null, death: g('ae-death') || null,
            hometown: g('ae-home'), intro: g('ae-intro'),
            cover_photo_id: g('ae-cover') || null,
          }).then(function () {
            clearEdit();
            toast('改好了');
            route();
          }).catch(fail);
          return;
        }

        /* 删除整本：话要说得足够重 */
        if ((b = t.closest('[data-arc-del]'))) {
          var did = Number(b.getAttribute('data-arc-del'));
          var card = null;
          for (var li = 0; li < list.length; li++) if (String(list[li].id) === String(did)) card = list[li];
          if (!card) return;
          var warn = '整本删除「' + card.subject_name + '」？\n\n' +
            '包含 ' + card.chapter_count + ' 章、' + card.entry_count + ' 条内容、' +
            card.photo_count + ' 张照片，照片和录音的文件也一起删掉。\n删了就找不回来了。';
          if (!confirm(warn)) return;
          DB.deleteArchive(did).then(function () {
            toast('已删除整本档案');
            route();
          }).catch(fail);
          return;
        }
      };
      if (homeClickHandler) app.removeEventListener('click', homeClickHandler);
      homeClickHandler = expHandler;
      app.addEventListener('click', homeClickHandler);

      /* --- 导入：认两种文件——本程序导出的 .json 档案包，或别人给的 .docx 文档 --- */
      var fin = document.getElementById('importFile');
      if (fin) fin.onchange = function () {
        var f = fin.files && fin.files[0];
        if (!f) return;
        fin.value = '';                       // 清掉，允许再选同一个文件
        var ext = String(f.name || '').split('.').pop().toLowerCase();
        if (ext === 'docx') return importWordFile(f);
        if (ext === 'doc') return toast('老的 .doc 读不了，请用 Word/WPS 另存为 .docx 再导');
        if (f.size > 200 * 1024 * 1024) return toast('这个文件超过 200MB，先删掉一些再导');
        var reader = new FileReader();
        reader.onload = function () {
          var pack;
          try { pack = JSON.parse(String(reader.result)); }
          catch (e) { return toast('文件读不出来，不是完整的导出文件'); }
          if (!pack || pack.format !== 'mylife-archive' || !pack.archive) {
            return toast('这不是本程序导出的档案文件（要 .mylife.json，或者 .docx 文档）');
          }
          startImport(pack, 'json');
        };
        reader.readAsText(f);
      };
    }).catch(function (e) {
      app.innerHTML = topbar() + '<main class="wrap"><div class="empty">读不出来：' +
        esc(e.message) + '</div></main>';
    });
  }

  function askNew() {
    var name = prompt('这部档案是谁的？（写名字就行）');
    if (!name || !name.trim()) return;
    var birth = prompt('出生年份？（可以留空，填了目录会带上具体年份）');
    DB.createArchive(name, parseInt(birth, 10) || null, '').then(function (id) {
      // 建完先把人生阶段目录搭好——一进来看到的是「目录」，不是一个空白页
      return DB.buildOutline(id).then(function () { return id; }, function () { return id; });
    }).then(function (id) {
      toast('建好了，目录已按人生阶段排好，点一章就能开始写');
      go('#/a/' + id);
    }).catch(fail);
  }

  /* ---------------- 导入：Word / 档案包 ---------------- */

  /** 大文件转 base64：一次 apply 几 MB 会爆栈，分块拼 */
  function bytesToB64(u8) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }

  function importWordFile(f) {
    if (f.size > 60 * 1024 * 1024) return toast('这个 Word 超过 60MB，先用 Word 压一下图片再导');
    toast('正在读这本 Word……');
    var fr = new FileReader();
    fr.onerror = function () { toast('文件读不出来'); };
    fr.onload = function () {
      var b64;
      try { b64 = bytesToB64(new Uint8Array(fr.result)); }
      catch (e) { return toast('文件读不出来'); }
      API.docxParse({ base64: b64, name: f.name }).then(function (r) {
        if (!r || r.ok !== true) throw new Error((r && r.message) || '这个 Word 读不出内容');
        showWordPreview(r);
      }).catch(fail);
    };
    fr.readAsArrayBuffer(f);
  }

  /** Word 读出来了先给人看一眼：多少章、多少字、几章，名字能改 */
  function showWordPreview(r) {
    var st = r.stats || {};
    var chs = r.chapters || [];
    var listHtml = '';
    for (var i = 0; i < chs.length && i < 12; i++) {
      var n = 0, imgs = 0;
      var blocks = chs[i].blocks || [];
      for (var b = 0; b < blocks.length; b++) {
        if (blocks[b].type === 'photo') imgs++; else n++;
      }
      listHtml += '<div class="imp-row"><b>' + (i + 1) + '</b><span>' + esc(chs[i].title || '（无题）') +
        '</span><i class="dim">' + (chs[i].years ? esc(chs[i].years) + ' · ' : '') + n + ' 段' +
        (imgs ? ' · ' + imgs + ' 图' : '') + '</i></div>';
    }
    if (chs.length > 12) listHtml += '<p class="hint dim">还有 ' + (chs.length - 12) + ' 章没列出来……</p>';
    var warn = (r.warnings && r.warnings.length)
      ? '<p class="hint warn">' + esc(r.warnings.join('；')) + '</p>' : '';

    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal book-modal imp-modal">' +
      '<h3>这本 Word 读成了 ' + st.chapters + ' 章</h3>' +
      '<p class="hint dim">确认名字就能建成一本新档案：</p>' +
      '<label class="imp-fld"><span>档案姓名</span>' +
      '<input id="impName" value="' + esc(r.suggest_name || (r.archive && r.archive.subject_name) || '') + '"></label>' +
      '<p class="imp-stat">' + st.paragraphs + ' 段 · ' + st.words + ' 字 · ' + st.photos + ' 张图片' +
      (r.archive && r.archive.archive_no ? ' · 文档里的编号 ' + esc(r.archive.archive_no) : '') + '</p>' +
      warn +
      '<p class="hint dim">Word 里只有文字和图片，录音、视频这类带不进来。</p>' +
      '<div class="imp-list">' + listHtml + '</div>' +
      '<div class="ml-modal-acts"><button class="btn" data-imp="cancel">取消</button>' +
      '<button class="btn primary" data-imp="go">导入成档案</button></div>' +
      '<div class="ml-modal-msg" id="impMsg"></div></div>';
    document.body.appendChild(ov);

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov) { close(); return; }
      var btn = ev.target.closest && ev.target.closest('[data-imp]');
      if (!btn) return;
      if (btn.getAttribute('data-imp') === 'cancel') { close(); return; }
      var nm = String(ov.querySelector('#impName').value || '').trim();
      if (!nm) { ov.querySelector('#impMsg').textContent = '先写个名字'; return; }
      var pack = DB.docxToPack(r);
      if (!pack) { ov.querySelector('#impMsg').textContent = '这份文档没有可用内容'; return; }
      pack.archive.subject_name = nm;
      close();
      startImport(pack, 'docx');
    });
  }

  /** 入库前先看库里有没有同一本（同编号或同名）——有就问是覆盖还是另存 */
  function startImport(pack, from) {
    DB.findImportTargets(pack).then(function (hits) {
      if (!hits || !hits.length) return doImport(pack, { mode: 'copy' }, from);
      askImportMode(pack, hits[0], from);
    }).catch(fail);
  }

  function askImportMode(pack, hit, from) {
    var what = esc(hit.subject_name || '这本档案') +
      (hit.archive_no ? '（' + esc(hit.archive_no) + '）' : '');
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal book-modal">' +
      '<h3>库里已经有「' + what + '」了</h3>' +
      '<p class="hint dim">上次导入没问你，结果多出一本一模一样的。这次你想怎么办：</p>' +
      '<button class="ex-card" data-im="replace"><b>覆盖现在这一本</b>' +
      '<small>先清掉它现有的 ' + (hit.chapter_count || 0) + ' 章、' + (hit.entry_count || 0) +
      ' 条内容、' + (hit.photo_count || 0) + ' 张照片（文件也删），再按文件重建；' +
      '编号和名字都不变。文件里没有的东西（录音、原图、手排的顺序）不会留下。</small></button>' +
      '<button class="ex-card" data-im="copy"><b>当成另一本存进来</b>' +
      '<small>名字自动加「（副本）」，编号重新分配，原来那本一点都不动</small></button>' +
      '<div class="ml-modal-acts"><button class="btn" data-im="cancel">算了，不导了</button></div></div>';
    document.body.appendChild(ov);

    ov.addEventListener('click', function (ev) {
      if (ev.target === ov) { ov.parentNode.removeChild(ov); return; }
      var btn = ev.target.closest && ev.target.closest('[data-im]');
      if (!btn) return;
      var act = btn.getAttribute('data-im');
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (act === 'replace') doImport(pack, { mode: 'replace', intoId: hit.id }, from);
      else if (act === 'copy') doImport(pack, { mode: 'copy' }, from);
    });
  }

  function doImport(pack, opts, from) {
    toast(opts.mode === 'replace' ? '正在覆盖这本……' : (from === 'docx' ? '正在把 Word 存成档案……' : '正在导入……'));
    DB.importArchive(pack, opts).then(function (r) {
      toast(opts.mode === 'replace' ? '已按文件重建完成' : '导入完成，去验收');
      go('#/a/' + r.archiveId);
    }).catch(fail);
  }

  /* ---------------- 档案页 ---------------- */

  var entrySel = {};          // 勾选了哪些条目（换页保留，切档案清空）
  var entrySelArchive = null;

  function renderArchive(id) {
    if (entrySelArchive !== String(id)) { entrySel = {}; entrySelArchive = String(id); }
    app.innerHTML = topbar({ back: '#/', right: [{ href: '#/a/' + id + '/collect', text: '补内容' }] }) +
      '<main class="wrap"><div class="boot">正在装订……</div></main>';

    DB.getArchive(id).then(function (d) {
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var byChapter = {}, orphans = [];
      for (var i = 0; i < d.entries.length; i++) {
        var e = d.entries[i];
        if (e.chapter_id) {
          if (!byChapter[e.chapter_id]) byChapter[e.chapter_id] = [];
          byChapter[e.chapter_id].push(e);
        } else {
          orphans.push(e);
        }
      }

      var photoById = {};
      for (var p = 0; p < d.photos.length; p++) photoById[d.photos[p].id] = d.photos[p];

      /* 封面 */
      var coverPhoto = null;
      for (var c0 = 0; c0 < d.photos.length; c0++) {
        if (String(d.photos[c0].id) === String(a.cover_photo_id)) coverPhoto = d.photos[c0];
      }
      if (!coverPhoto && d.photos.length) coverPhoto = d.photos[0];

      var html = topbar({
        back: '#/',
        right: [{ href: '#/a/' + id + '/collect', text: '补内容' }]
      });

      html += '<main class="paper">';

      html += '<section class="cover-wrap">' +
        (window.CoverUI
          ? CoverUI.coverHtml(a, d.photos)
          : '<div class="cover">' +
            (coverPhoto ? '<img class="cover-photo" src="' + esc(fsrc(coverPhoto.path)) + '" alt="">' : '') +
            '<h1 class="cover-name">' + esc(a.subject_name) + '</h1></div>') +
        '<div class="cover-tools">' +
        '<button class="btn tiny" data-aid="' + id + '" data-cover-open="1">换封面</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="timeline">时间轴</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-export-open="1">导出文档</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="chat">AI 助手</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="song">主题曲</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="script">剧本</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="art">插图</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="comic">漫画</button>' +
        '<button class="btn tiny" data-aid="' + id + '" data-goto="movie">短片' +
        (d.movies && d.movies.length ? ' · ' + d.movies.length : '') + '</button>' +
        (d.chapters.length ? '<button class="btn tiny" data-read-all="1" data-aid="' + id + '">从头朗读</button>' : '') +
        '</div></section>';

      /* 档案信息 */
      var facts = [];
      try { facts = JSON.parse(a.facts_json || '[]'); } catch (e) { facts = []; }
      if (facts && facts.length) {
        html += '<section class="facts"><h2 class="sec-label">档 案 信 息</h2><dl class="fact-list">';
        for (var f = 0; f < facts.length; f++) {
          html += '<div class="fact"><dt>' + esc(facts[f].k) + '</dt><dd>' + esc(facts[f].v) + '</dd></div>';
        }
        html += '</dl></section>';
      }

      if (!d.chapters.length) {
        html += '<section class="outline-empty">' +
          '<h2 class="sec-label">还 没 有 目 录</h2>' +
          '<p class="muted">' + ((d.entries.length || d.segments.length)
            ? '材料已经有了。点一下，按「出生与家世 → 童年 → 求学 → 工作 → 婚姻 → 子女 → 事业 → 晚年」把内容排成目录。'
            : '先把目录搭起来，一章一章往里写。以后录的音、打的字会自动归到对应的章。') + '</p>' +
          '<div class="row">' +
          '<button class="btn primary" data-outline="1">按人生阶段生成目录</button>' +
          '<button class="btn" data-ch-add="1">自己加一章</button>' +
          '<a class="btn ghost" href="#/a/' + id + '/collect">先去说一段</a>' +
          '</div></section>';
      }

      /* 目录：一章一行，点进去是这一章自己的页面 */
      if (d.chapters.length) {
        html += '<section class="toc" id="toc"><div class="toc-head"><h2 class="sec-label">目 录</h2>' +
          '<span class="toc-hint">点一章进去，读、写、听、改都在那一页</span></div>';
        for (var t = 0; t < d.chapters.length; t++) {
          var ch = d.chapters[t];
          var title = String(ch.title || '').replace(/^[^·]*·\s*/, '');
          var cEnt = byChapter[ch.id] || [];
          var cWords = 0;
          for (var cw = 0; cw < cEnt.length; cw++) cWords += String(cEnt[cw].text || '').length;
          html += '<div class="toc-item">' +
            '<a class="toc-row" href="#/a/' + id + '/ch/' + ch.id + '">' +
            '<span class="toc-idx">' + (t + 1) + '</span>' +
            '<span class="toc-title">' + esc(title) +
            (ch.stage ? '<em class="toc-stage">' + esc(ch.stage) + '</em>' : '') + '</span>' +
            '<span class="toc-year">' + esc(ch.year_from ? DB.yearLabel(ch.year_from, ch.year_to) : '') + '</span>' +
            '<span class="toc-n">' + (cEnt.length ? cEnt.length + ' 段' +
              (cWords ? ' · ' + cWords + ' 字' : '') : '还没写') + '</span>' +
            '<span class="toc-go">›</span></a>' +
            '<div class="toc-tools">' +
            '<button class="linkbtn" data-move-chapter="' + ch.id + '" data-dir="-1" title="这一章上移">↑</button>' +
            '<button class="linkbtn" data-move-chapter="' + ch.id + '" data-dir="1" title="这一章下移">↓</button>' +
            '<button class="linkbtn" data-ch-edit="' + ch.id + '" title="改章名">改</button>' +
            '<button class="linkbtn danger-t" data-ch-del="' + ch.id + '" title="删这一章（内容退回待归档）">删</button>' +
            '</div></div>';
        }
        if (orphans.length) {
          html += '<a class="toc-row toc-orphan" href="#/a/' + id + '/ch/0">' +
            '<span class="toc-idx">·</span>' +
            '<span class="toc-title">待归档</span>' +
            '<span class="toc-year"></span>' +
            '<span class="toc-n">' + orphans.length + ' 段</span>' +
            '<span class="toc-go">›</span></a>';
        }
        html += '<div class="toc-add">' +
          '<button class="btn tiny" data-ch-add="1">＋ 新增一章</button>' +
          (d.entries.length ? '<button class="btn tiny ghost" data-outline="force">' +
            '按年份重排目录</button>' : '') +
          '<button class="btn tiny ghost" data-toggle-full="1">整本阅读</button>' +
          '<button class="btn tiny" data-whole-book="1">看整本</button>' +
          '</div>';
        html += '</section>';
      }

      /* 合成过的短片：成片是档案资产（存在 media 表里），关掉页面、换设备回来都还在 */
      if (d.movies && d.movies.length) {
        html += '<section class="mv-hist" id="archiveMovies"><div class="toc-head">' +
          '<h2 class="sec-label">合 成 的 片 子</h2>' +
          '<span class="toc-hint">' + d.movies.length + ' 条 · 点播放看，点「下载」存到手机或电脑</span></div>' +
          '<div class="mv-hist-list">';
        for (var mv = 0; mv < d.movies.length; mv++) {
          var mm = d.movies[mv];
          var msec = Math.round((Number(mm.duration_ms) || 0) / 1000);
          html += '<div class="mv-hist-item">' +
            '<video preload="metadata" playsinline controls src="' + esc(fsrc(mm.path)) + '"></video>' +
            '<div class="mv-line"><span class="muted">' +
            (msec ? msec + ' 秒' : '') + (mm.bytes ? ' · ' + bytes(mm.bytes) : '') + '</span>' +
            '<a class="linkbtn" href="' + esc(fsrc(mm.path)) + '" download>下载</a></div>' +
            (mm.caption ? '<div class="mv-cap">' + esc(String(mm.caption).slice(0, 40)) + '</div>' : '') +
            '</div>';
        }
        html += '</div></section>';
      }

      /* 待归档照片：已经配到段落或已有照片条目的，不再重复列在这里 */
      var usedPhotoIds = {};
      for (var up = 0; up < d.entries.length; up++) {
        if (d.entries[up].photo_id) usedPhotoIds[d.entries[up].photo_id] = 1;
      }
      var pending = [];
      for (var pp = 0; pp < d.photos.length; pp++) {
        // 只要还没被任何条目引用，就列出来让人能放进去（哪怕它身上有旧的章节号）
        if (!usedPhotoIds[d.photos[pp].id]) pending.push(d.photos[pp]);
      }
      if (pending.length) {
        html += '<section class="pending"><h2>这 ' + pending.length +
          ' 张照片还没放进正文 <small>点「放进某章」，或展开全文在某一章里点「＋」插到任意位置</small></h2>' +
          '<div class="pending-grid">';
        for (var pg = 0; pg < pending.length; pg++) {
          var ph = pending[pg];
          html += '<figure class="ph small"><img src="' + esc(fsrc(ph.path)) + '" alt="" loading="lazy">' +
            '<figcaption><span class="ph-meta">' + esc(ph.taken_year || '') + ' · ' + esc(ph.place || '') + '</span>' +
            '<span class="ph-event">' + esc(ph.event || '') + '</span>' +
            '</figcaption>' +
            '<div class="ph-acts">' +
            '<button class="btn tiny" data-ph-place="' + ph.id + '">放进某章</button>' +
            '<button class="btn tiny" data-ph-to-para="' + ph.id + '">插到某段</button>' +
            '<button class="btn tiny" data-ph-meta="' + ph.id + '">改说明</button>' +
            '<button class="btn tiny" data-ph-cover="' + ph.id + '">设为封面</button>' +
            '<button class="btn tiny danger" data-ph-del="' + ph.id + '">删</button>' +
            '</div></figure>';
        }
        html += '</div></section>';
      }

      /* 全文：默认收起，只看目录。要通读时点「整本阅读」展开 */
      html += '<section class="full-wrap"><div class="full-body" id="fullBody" hidden>';

      /* 章节 */
      for (var ci = 0; ci < d.chapters.length; ci++) {
        var c = d.chapters[ci];
        var entries = byChapter[c.id] || [];
        html += '<section class="chapter" id="ch-' + c.id + '">';
        html += '<h2 class="ch-title"><span class="ch-idx">' + (ci + 1) + '</span>' +
          '<span class="ch-name">' + esc(String(c.title || '').replace(/^[^·]*·\s*/, '')) + '</span>' +
          '<span class="ch-year">' + esc(c.year_from ? DB.yearLabel(c.year_from, c.year_to) : '') + '</span>' +
          '<button class="ch-read" data-read-ch="' + c.id + '" title="从这一章开头朗读">读</button>' +
          '<button class="ch-mv" data-move-chapter="' + c.id + '" data-dir="-1" title="本章上移">↑</button>' +
          '<button class="ch-mv" data-move-chapter="' + c.id + '" data-dir="1" title="本章下移">↓</button>' +
          '<button class="ch-edit" data-ch-edit="' + c.id + '" title="改章名">改</button></h2>';
        if (c.stage) html += '<div class="ch-kicker">' + esc(c.stage) +
          (a.birth_year && c.year_from ? ' · ' + (c.year_from - a.birth_year) + ' 岁' : '') + '</div>';
        if (c.quote) html += '<blockquote class="ch-quote">“' + esc(c.quote) + '”</blockquote>';

        if (!entries.length) html += '<p class="muted">这一章还是空的。</p>' + insPoint('', c.id);
        for (var ei = 0; ei < entries.length; ei++) {
          html += renderEntry(entries[ei]);
          html += insPoint(entries[ei].id, c.id);
        }
        html += '</section>';
      }

      /* 手写补充 */
      if (orphans.length) {
        html += '<section class="chapter" id="ch-orphan"><h2 class="ch-title"><span class="ch-name">待归档</span>' +
          '<small class="ch-hint">给这些段落点「归章」，或直接上移到某一章</small></h2>';
        for (var oi = 0; oi < orphans.length; oi++) {
          html += renderEntry(orphans[oi]);
          html += insPoint(orphans[oi].id, '');
        }
        html += '</section>';
      }

      html += '</div></section>';

      html += '<footer class="doc-foot"><span>' + esc(a.archive_no || '') + ' · ' +
        esc(a.subject_name) + '</span><span>由 AI 协助整理 · 可随时修改</span></footer>';
      // 批量操作条：勾选若干段后可整块上下移 / 归到某章
      html += '<div class="sel-bar" id="selBar">' +
        '<span class="sel-n" id="selCount">已选 0 段</span>' +
        '<button class="btn tiny" data-sel-move="-1">↑ 上移</button>' +
        '<button class="btn tiny" data-sel-move="1">↓ 下移</button>' +
        '<button class="btn tiny" data-sel-chap="1">归到某章</button>' +
        '<button class="btn tiny" data-sel-clear="1">清空</button>' +
        '</div>';
      html += '</main>';
      app.innerHTML = html;
      bindArchive(id);
      updateSelBar();
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message) + '</div></main>';
    });
  }

  /* ---------------- 章节页：一章一个页面，读、写、听、改都在这里 ---------------- */

  function renderChapterPage(id, chId) {
    app.innerHTML = topbar({ back: '#/a/' + id, title: '正在翻页……' }) +
      '<main class="wrap"><div class="boot">正在翻页……</div></main>';

    DB.getArchive(id).then(function (d) {
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var ch = null, idx = -1, i;
      if (String(chId) === '0') {
        ch = { id: 0, title: '待归档', stage: '', quote: '', summary: '' };
        idx = d.chapters.length;
      } else {
        for (i = 0; i < d.chapters.length; i++) {
          if (String(d.chapters[i].id) === String(chId)) { ch = d.chapters[i]; idx = i; }
        }
      }
      if (!ch) throw new Error('这一章不存在，可能已经被删掉了。');

      /* 本章的条目：待归档那页收的是没有章号的 */
      var entries = [];
      for (i = 0; i < d.entries.length; i++) {
        var e = d.entries[i];
        if (String(chId) === '0') {
          if (!e.chapter_id) entries.push(e);
        } else if (String(e.chapter_id) === String(ch.id)) entries.push(e);
      }
      var words = 0;
      for (i = 0; i < entries.length; i++) words += String(entries[i].text || '').length;

      var prevCh = idx > 0 ? d.chapters[idx - 1] : (String(chId) === '0' ? d.chapters[d.chapters.length - 1] : null);
      var nextCh = String(chId) === '0' ? null : d.chapters[idx + 1];

      /* 本章里的照片（照片条目 + 直接挂在章上的照片） */
      var chPhotos = [], usedIds = {};
      for (i = 0; i < entries.length; i++) {
        if (entries[i].photo_id) usedIds[entries[i].photo_id] = 1;
      }
      for (i = 0; i < d.photos.length; i++) {
        var ph = d.photos[i];
        if (String(chId) === '0') {
          if (!ph.chapter_id && !usedIds[ph.id]) chPhotos.push(ph);
        } else if (String(ph.chapter_id) === String(ch.id)) {
          chPhotos.push(ph);
        }
      }

      var titleTxt = String(ch.title || '').replace(/^[^·]*·\s*/, '');
      var html = topbar({
        back: '#/a/' + id,
        title: String(chId) === '0' ? '待归档' : ('第 ' + (idx + 1) + ' 章'),
        right: [{ href: '#/a/' + id, text: '目录' }]
      });

      html += '<main class="paper chapter-paper">';

      html += '<section class="ch-page-hd">' +
        '<div class="ch-crumb">' +
        '<a href="#/a/' + id + '">目录</a>' +
        '<span>' + (String(chId) === '0' ? '待归档' : '第 ' + (idx + 1) + ' / ' + d.chapters.length + ' 章') + '</span>' +
        '</div>' +
        '<h1 class="ch-page-title">' + esc(titleTxt) + '</h1>' +
        '<div class="ch-page-meta">' +
        (ch.year_from ? esc(DB.yearLabel(ch.year_from, ch.year_to)) : '') +
        (ch.stage ? ' · ' + esc(ch.stage) : '') +
        ' · ' + entries.length + ' 段' + (words ? ' · 约 ' + words + ' 字' : '') +
        '</div>' +
        '<div class="ch-page-tools">' +
        (entries.length ? '<button class="btn tiny" data-read-ch="' + ch.id + '">朗读这一章</button>' : '') +
        '<button class="btn tiny" data-ch-edit="' + ch.id + '">改章名</button>' +
        (String(chId) === '0' ? '' :
          '<button class="btn tiny" data-move-chapter="' + ch.id + '" data-dir="-1">上移</button>' +
          '<button class="btn tiny" data-move-chapter="' + ch.id + '" data-dir="1">下移</button>' +
          '<button class="btn tiny danger-t" data-ch-del="' + ch.id + '">删这一章</button>') +
        '<a class="btn tiny" href="#/a/' + id + '/art' + (ch.id ? '?ch=' + ch.id : '') + '">配插图</a>' +
        '<a class="btn tiny" href="#/a/' + id + '/comic' + (ch.id ? '?ch=' + ch.id : '') + '">做漫画</a>' +
        '<a class="btn tiny" href="#/a/' + id + '/script' + (ch.id ? '?ch=' + ch.id : '') + '">写成剧本</a>' +
        '<a class="btn tiny" href="#/a/' + id + '/movie' + (ch.id ? '?ch=' + ch.id : '') + '">做成短片</a>' +
        '<a class="btn tiny" href="#/a/' + id + '/collect">录音 / 上传</a>' +
        '</div></section>';

      if (ch.quote) html += '<blockquote class="ch-quote">“' + esc(ch.quote) + '”</blockquote>';
      if (ch.summary) html += '<p class="ch-sum">' + esc(ch.summary) + '</p>';

      html += '<section class="chapter ch-page-body" id="ch-' + ch.id + '">';
      if (!entries.length) {
        html += '<p class="empty-line">这一章还没有内容。在下面写第一段，或者回去说一段录音。</p>';
      }
      for (i = 0; i < entries.length; i++) {
        html += renderEntry(entries[i]);
        html += insPoint(entries[i].id, ch.id);
      }
      html += '</section>';

      /* 就地写一段：不用回「补内容」页 */
      html += '<section class="ch-quick">' +
        '<h2 class="sec-label">往这一章里写</h2>' +
        '<textarea class="say mini" id="chQuickText" rows="4" placeholder="想到什么写什么，写完点「写进这一章」"></textarea>' +
        '<div class="row end"><button class="btn primary" data-ch-quick="' + ch.id + '">写进这一章</button></div>' +
        (String(chId) === '0' ? '<p class="hint">写在这里的内容还没有归章。可以写完用每段下面的「归章」放进某一章。</p>' : '') +
        '</section>';

      /* 本章照片 */
      if (chPhotos.length) {
        html += '<section class="ch-photos"><h2 class="sec-label">这一章的照片</h2><div class="pending-grid">';
        for (i = 0; i < chPhotos.length; i++) {
          var cp = chPhotos[i];
          html += '<figure class="ph small"><img src="' + esc(fsrc(cp.path)) + '" alt="" loading="lazy">' +
            '<figcaption><span class="ph-meta">' + esc(cp.taken_year || '') +
            (cp.place ? ' · ' + esc(cp.place) : '') + '</span>' +
            '<span class="ph-event">' + esc(cp.event || '') + '</span></figcaption>' +
            '<div class="ph-acts">' +
            '<button class="btn tiny" data-ph-to-body="' + cp.id + '" data-ch="' + (chId === '0' ? '' : ch.id) + '">放进正文</button>' +
            '<button class="btn tiny" data-ph-move="' + cp.id + '">移到别的章</button>' +
            '<button class="btn tiny" data-ph-meta="' + cp.id + '">改说明</button>' +
            '<button class="btn tiny" data-ph-cover="' + cp.id + '">设为封面</button>' +
            '<button class="btn tiny danger" data-ph-del="' + cp.id + '">删</button>' +
            '</div></figure>';
        }
        html += '</div></section>';
      }

      /* 上一章 / 下一章 */
      html += '<nav class="ch-page-nav">' +
        (prevCh ? '<a class="pn prev" href="#/a/' + id + '/ch/' + prevCh.id + '">' +
          '<small>上一章</small><b>' + esc(String(prevCh.title || '').replace(/^[^·]*·\s*/, '')) + '</b></a>' : '<span></span>') +
        (nextCh ? '<a class="pn next" href="#/a/' + id + '/ch/' + nextCh.id + '">' +
          '<small>下一章</small><b>' + esc(String(nextCh.title || '').replace(/^[^·]*·\s*/, '')) + '</b></a>' : '<span></span>') +
        '</nav>';

      html += '</main>';
      app.innerHTML = html;
      bindArchive(id);
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/a/' + id }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '这一章打不开') + '</div></main>';
    });
  }

  /** 卷宗里的改与删：条目改字、改章名、删条目 */
  function bindArchive(id) {
    if (archiveClickHandler) app.removeEventListener('click', archiveClickHandler);
    if (archiveChangeHandler) app.removeEventListener('change', archiveChangeHandler);
    archiveChangeHandler = function (ev) {
      var cb = ev.target;
      if (!cb || !cb.getAttribute || !cb.getAttribute('data-check-entry')) return;
      var cid = cb.getAttribute('data-check-entry');
      if (cb.checked) entrySel[cid] = 1; else delete entrySel[cid];
      updateSelBar();
    };
    app.addEventListener('change', archiveChangeHandler);
    archiveClickHandler = function (ev) {
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var b;

      if ((b = t.closest('[data-entry-edit]'))) {
        editState = { type: 'entry', id: Number(b.getAttribute('data-entry-edit')) };
        return route();
      }
      if ((b = t.closest('[data-edit-cancel]'))) {
        clearEdit();
        return route();
      }
      if ((b = t.closest('[data-entry-save]'))) {
        var eid = Number(b.getAttribute('data-entry-save'));
        var ta = document.querySelector('[data-entry-text="' + eid + '"]');
        DB.updateEntry(eid, ta ? ta.value : '').then(function () {
          clearEdit();
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-entry-del]'))) {
        var did = Number(b.getAttribute('data-entry-del'));
        if (!confirm('删掉这一段？删了就找不回来了。')) return;
        DB.deleteEntry(did).then(function () {
          toast('已删除');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-entry-upload]'))) {
        var ch = b.getAttribute('data-ch');
        uploadToEntry(id, ch ? Number(ch) : null, route, Number(b.getAttribute('data-entry-upload')));
        return;
      }
      if ((b = t.closest('[data-move-entry]'))) {
        var meid = Number(b.getAttribute('data-move-entry'));
        var mdir = Number(b.getAttribute('data-dir')) || 1;
        DB.moveEntry(meid, mdir).then(function (r) {
          if (!r || !r.moved) toast('已经到头了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-meta]'))) {
        openPhotoMeta(Number(b.getAttribute('data-ph-meta')));
        return;
      }
      if ((b = t.closest('[data-ch-quick]'))) {
        var qch = Number(b.getAttribute('data-ch-quick'));
        var qta = document.getElementById('chQuickText');
        var qtxt = qta ? String(qta.value || '').trim() : '';
        if (!qtxt) return toast('先写点什么');
        b.disabled = true;
        DB.insertAfter(id, { chapterId: qch || null, kind: 'text', text: qtxt })
          .then(function () { toast('写进去了'); route(); })
          .catch(function (e) { b.disabled = false; fail(e); });
        return;
      }
      if ((b = t.closest('[data-outline]'))) {
        var force = b.getAttribute('data-outline') === 'force';
        b.disabled = true;
        b.textContent = '正在排……';
        DB.buildOutline(id, { force: force }).then(function (r) {
          toast(r && r.created
            ? '目录排好了：' + r.created + ' 章'
            : (r && r.homed ? '把 ' + r.homed + ' 段补进了对应的章' : '目录没有变化'));
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ch-add]'))) {
        var ntitle = prompt('新的一章叫什么？（比如「1978 年，进城打工」）');
        if (!ntitle || !ntitle.trim()) return;
        var yr = prompt('大概哪一年？（可留空）');
        DB.addChapter(id, ntitle.trim(), parseInt(yr, 10) || null, parseInt(yr, 10) || null)
          .then(function (r) { toast('加好了'); go('#/a/' + id + '/ch/' + r.id); })
          .catch(fail);
        return;
      }
      if ((b = t.closest('[data-ch-del]'))) {
        var delCh = Number(b.getAttribute('data-ch-del'));
        if (!confirm('删掉这一章？章里的内容不会丢，会退回「待归档」。')) return;
        DB.deleteChapter(delCh).then(function () { toast('删了，内容退到待归档'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-toggle-full]'))) {
        var fb = document.getElementById('fullBody');
        if (fb) {
          fb.hidden = !fb.hidden;
          b.textContent = fb.hidden ? '整本阅读' : '收起全文';
          if (!fb.hidden) fb.scrollIntoView({ block: 'start' });
        }
        return;
      }
      if ((b = t.closest('[data-move-chapter]'))) {
        var mc = Number(b.getAttribute('data-move-chapter'));
        var cdir = Number(b.getAttribute('data-dir')) || 1;
        DB.moveChapter(mc, cdir).then(function (r) {
          if (!r || !r.moved) toast('已经到头了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-pair-entry]'))) {
        var pe = Number(b.getAttribute('data-pair-entry'));
        openMultiPhotoPicker(id, '给这一段配图（可多选）', function (pids) {
          // 第一张贴在段落里（写 entries.photo_id）——漫画、短片、导出都靠这个字段找段落配图；
          // 其余一张一张插在这段后面，成为独立照片条目，张数不设上限。
          DB.setEntryPhoto(pe, Number(pids[0])).then(function () {
            var chain = Promise.resolve(), last = pe;
            pids.slice(1).forEach(function (pid) {
              chain = chain.then(function () {
                return DB.insertAfter(id, { afterId: last, kind: 'photo', photoId: pid })
                  .then(function (r) { if (r && r.lastId) last = r.lastId; });
              });
            });
            return chain;
          }).then(function () {
            toast(pids.length > 1 ? ('配好了 ' + pids.length + ' 张') : '配好了');
            route();
          }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-unpair-entry]'))) {
        var ue = Number(b.getAttribute('data-unpair-entry'));
        DB.setEntryPhoto(ue, null).then(function () { toast('已去图'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-sel-move]'))) {
        var sdir = Number(b.getAttribute('data-sel-move')) || 1;
        var sids = [], sk;
        for (sk in entrySel) if (entrySel.hasOwnProperty(sk)) sids.push(Number(sk));
        if (!sids.length) return toast('先勾选几段');
        DB.moveEntries(sids, sdir).then(function (r) {
          if (!r || !r.moved) toast('已经到头了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-sel-clear]'))) {
        entrySel = {};
        route();
        return;
      }
      if ((b = t.closest('[data-sel-chap]'))) {
        var cids = [], ck;
        for (ck in entrySel) if (entrySel.hasOwnProperty(ck)) cids.push(Number(ck));
        if (!cids.length) return toast('先勾选几段');
        openChapterPicker(id, function (chId) {
          var chain = Promise.resolve();
          cids.forEach(function (eid) {
            chain = chain.then(function () { return DB.setEntryChapter(eid, chId); });
          });
          chain.then(function () { entrySel = {}; toast('归好了'); route(); }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-assign-chapter]'))) {
        var ae = Number(b.getAttribute('data-assign-chapter'));
        openChapterPicker(id, function (chId) {
          DB.setEntryChapter(ae, chId).then(function () { toast('归好了'); route(); }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-ins-after]'))) {
        openInsertMenu(id, b.getAttribute('data-ins-after') || '', b.getAttribute('data-ins-ch') || '');
        return;
      }
      if ((b = t.closest('[data-ph-place]'))) {
        var phId = Number(b.getAttribute('data-ph-place'));
        openChapterPicker(id, function (chId) {
          if (!chId) return toast('请选一章');
          DB.insertAfter(id, { chapterId: chId, kind: 'photo', photoId: phId })
            .then(function () { toast('放进去了'); route(); }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-ph-to-para]'))) {
        var phPara = Number(b.getAttribute('data-ph-to-para'));
        openParagraphPickerLocal(id, function (eid) {
          DB.insertAfter(id, { afterId: eid, kind: 'photo', photoId: phPara })
            .then(function () { toast('插到那一段后面了'); route(); }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-ph-to-body]'))) {
        // 把「本章照片」变成正文里的一张图，之后就能上下移动、换章
        var phBody = Number(b.getAttribute('data-ph-to-body'));
        var chBody = b.getAttribute('data-ch') || '';
        DB.insertAfter(id, { chapterId: chBody ? Number(chBody) : null, kind: 'photo', photoId: phBody })
          .then(function () { toast('已经放进正文，可以上下移动了'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-move]'))) {
        var phMv = Number(b.getAttribute('data-ph-move'));
        openChapterPicker(id, function (chId) {
          DB.movePhotoChapter(phMv, chId || null)
            .then(function () { toast(chId ? '换到那一章了' : '退回待归档了'); route(); }).catch(fail);
        });
        return;
      }
      if ((b = t.closest('[data-whole-book]'))) {
        openWholeBook(id);
        return;
      }
      if ((b = t.closest('[data-ph-cover]'))) {
        var cvId = Number(b.getAttribute('data-ph-cover'));
        DB.setCoverPhoto(id, cvId).then(function () { toast('封面换好了'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-del]'))) {
        var dph = Number(b.getAttribute('data-ph-del'));
        if (!confirm('删掉这张照片？文件也会一起删。')) return;
        DB.deletePhotoSafe(dph).then(function () { toast('删了'); route(); }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ch-edit]'))) {
        var chid = Number(b.getAttribute('data-ch-edit'));
        var el = document.querySelector('[data-ch-title="' + chid + '"]');
        var cur = el ? el.textContent : '';
        var v = prompt('章名改成什么？（留空就不改）', cur);
        if (v === null) return;
        DB.updateChapter(chid, v, '').then(function () {
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
    };
    app.addEventListener('click', archiveClickHandler);
  }

  /**
   * 「传」的公共流程：选图片/视频/录音 → 存盘 → 记 media → 插一条媒体条目。
   * 图片压到 1600px 再存，视频录音原样收（上限 80MB）。
   */
  function uploadToEntry(aid, chapterId, done, afterId) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*,video/*,audio/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var kind = /^image/.test(f.type) ? 'photo'
        : /^video/.test(f.type) ? 'video'
        : /^audio/.test(f.type) ? 'audio' : null;
      if (!kind) return toast('只能传图片、视频或录音');

      if (kind === 'photo') {
        compress(f, function (dataUrl) {
          DB.addMediaEntry(aid, chapterId, 'photo', dataUrl, 'image/jpeg', f.name, 'jpg', afterId)
            .then(function () { toast('传好了'); done(); }).catch(fail);
        });
        return;
      }
      if (f.size > 80 * 1024 * 1024) return toast('超过 80MB，传不动，换小一点的');
      var reader = new FileReader();
      reader.onload = function () {
        var ext = (f.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
        DB.addMediaEntry(aid, chapterId, kind, String(reader.result), f.type, f.name, ext, afterId)
          .then(function () { toast('传好了，正在排进档案'); done(); }).catch(fail);
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  /** 上下移动按钮：给条目、照片、媒体都用，dir=-1 上移 / 1 下移 */
  function moveActs(e) {
    return '<button class="linkbtn" data-move-entry="' + e.id + '" data-dir="-1" title="上移（可跨章）">↑</button>' +
      '<button class="linkbtn" data-move-entry="' + e.id + '" data-dir="1" title="下移（可跨章）">↓</button>';
  }

  /** 勾选框：选中后可批量上下移 / 归章。（样式在 style.css 的 .ckb，原生勾选在这套 CSS 里会被吃掉，所以要自绘） */
  function selCheck(e) {
    return '<label class="ckb en-check" title="勾选后可批量移动、批量归章">' +
      '<input type="checkbox" data-check-entry="' + e.id + '"' +
      (entrySel[e.id] ? ' checked' : '') + '><i></i></label>';
  }

  /** 归章入口：没归章的写「归章」，已归章的写「换章」——任何时候都能改到别的章去 */
  function assignAct(e) {
    return '<button class="linkbtn" data-assign-chapter="' + e.id + '" title="' +
      (e.chapter_id ? '换到别的章' : '归到某一章') + '">' + (e.chapter_id ? '换章' : '归章') + '</button>';
  }

  function renderEntry(e) {
    if (e.kind === 'photo') {
      return '<figure class="ph">' +
        (e.photo_path ? '<img src="' + esc(fsrc(e.photo_path)) + '" alt="" loading="lazy">' : '') +
        '<figcaption><span class="ph-meta">' + esc(e.taken_year || '') +
        (e.place ? ' · ' + esc(e.place) : '') + '</span>' +
        '<span class="ph-event">' + esc(e.text || '') + '</span>' +
        (e.match_reason ? '<span class="ph-why">归位理由：' + esc(e.match_reason) + '</span>' : '') +
        '</figcaption>' +
        '<div class="en-acts">' + selCheck(e) + moveActs(e) + assignAct(e) + '</div></figure>';
    }
    if (e.kind === 'media') {
      var url = fsrc(e.media_path || '');
      var inner = '';
      if (e.media_kind === 'video') {
        inner = '<video controls playsinline preload="metadata" src="' + url + '"' +
          (e.media_poster ? ' poster="' + esc(fsrc(e.media_poster)) + '"' : '') + '></video>';
      } else if (e.media_kind === 'audio') {
        inner = '<audio controls preload="metadata" src="' + url + '"></audio>';
      } else {
        inner = '<img src="' + url + '" alt="" loading="lazy">';
      }
      return '<div class="md">' + inner +
        (e.text ? '<div class="md-cap">' + esc(e.text) + '</div>' : '') +
        '<div class="en-acts">' + selCheck(e) + moveActs(e) + assignAct(e) + '</div></div>';
    }
    // 文字条目：可就地改，可删，可配图，还能往后面传图片/视频/录音
    if (isEdit('entry', e.id)) {
      return '<div class="en editing">' +
        '<textarea class="say mini" data-entry-text="' + e.id + '">' + esc(e.text) + '</textarea>' +
        '<div class="en-acts">' +
        '<button class="btn tiny primary" data-entry-save="' + e.id + '">保存</button>' +
        '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
    }
    var paired = '';
    if (e.photo_path) {
      paired = '<figure class="ph en-photo">' +
        '<img src="' + esc(fsrc(e.photo_path)) + '" alt="" loading="lazy">' +
        '<figcaption><span class="ph-meta">' + esc(e.taken_year || '') +
        (e.place ? ' · ' + esc(e.place) : '') + '</span></figcaption></figure>';
    }
    return '<div class="en' + (e.kind === 'quote' ? ' quote' : '') + '"><p>' + esc(e.text) + '</p>' +
      paired +
      '<div class="en-acts">' + selCheck(e) + moveActs(e) + assignAct(e) +
      '<button class="linkbtn" data-polish="' + e.id + '" title="AI 润色，原文不动">润</button>' +
      '<button class="linkbtn" data-entry-edit="' + e.id + '">改</button>' +
      '<button class="linkbtn" data-pair-entry="' + e.id + '" title="给这一段配图，可以一次配多张">＋图</button>' +
      (e.photo_path ? '<button class="linkbtn" data-unpair-entry="' + e.id + '" title="拿掉这一段的配图">去图</button>' : '') +
      '<button class="linkbtn" data-entry-upload="' + e.id + '" data-ch="' +
        (e.chapter_id || '') + '">传</button>' +
      '<button class="linkbtn danger-t" data-entry-del="' + e.id + '">删</button>' +
      '</div></div>';
  }

  /** 选一张档案里的照片配到某一段 */
  /** 改照片的「哪一年 / 在哪儿 / 什么事」——三样决定它排进哪一章 */
  function openPhotoMeta(pid) {
    API.query('SELECT * FROM photos WHERE id=?', [pid]).then(function (rows) {
      if (!rows.length) return toast('这张照片已经删了');
      var p = rows[0];
      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal"><h3>这张照片</h3>' +
        '<p class="hint dim">填准这三样，它才能被排进对应的那一章。</p>' +
        '<label>哪一年<input class="fi" id="pmYear" type="number" value="' +
        esc(p.taken_year || '') + '" placeholder="1968"></label>' +
        '<label>在哪儿<input class="fi" id="pmPlace" value="' + esc(p.place || '') +
        '" placeholder="老屋门口"></label>' +
        '<label>什么事<input class="fi" id="pmEvent" value="' + esc(p.event || '') +
        '" placeholder="全家合影"></label>' +
        '<div class="ml-modal-acts">' +
        '<button class="btn primary" data-pm-save="1">保存</button>' +
        '<button class="btn" data-pm-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pm-cancel]'))) {
          document.body.removeChild(ov); return;
        }
        if (ev.target.closest && ev.target.closest('[data-pm-save]')) {
          var y = Number(ov.querySelector('#pmYear').value) || null;
          var pl = String(ov.querySelector('#pmPlace').value || '').trim();
          var evt = String(ov.querySelector('#pmEvent').value || '').trim();
          DB.updatePhoto(pid, { year: y, place: pl, event: evt }).then(function () {
            document.body.removeChild(ov);
            toast('改好了');
            route();
          }).catch(fail);
        }
      });
    }).catch(fail);
  }

  function openPhotoPicker(aid, onPick) {
    API.query('SELECT id, path, taken_year, place FROM photos WHERE archive_id=? ORDER BY taken_year, id', [aid])
      .then(function (photos) {
        var grid = '', i;
        for (i = 0; i < photos.length; i++) {
          var p = photos[i];
          grid += '<button class="pick-ph" data-pick-ph="' + p.id + '">' +
            '<img src="' + esc(fsrc(p.path)) + '" alt="">' +
            '<span>' + esc(p.taken_year || '') + (p.place ? ' · ' + esc(p.place) : '') + '</span></button>';
        }
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML = '<div class="ml-modal pick-modal"><h3>选一张照片配到这一段</h3>' +
          '<div class="pick-grid">' + (grid || '<p class="muted">这本档案还没有照片</p>') + '</div>' +
          '<div class="ml-modal-acts"><button class="btn" data-pick-cancel="1">取消</button></div></div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pick-cancel]'))) {
            document.body.removeChild(ov);
            return;
          }
          var pb = ev.target.closest && ev.target.closest('[data-pick-ph]');
          if (pb) {
            var pid = Number(pb.getAttribute('data-pick-ph'));
            document.body.removeChild(ov);
            onPick(pid);
          }
        });
      }).catch(fail);
  }

  /**
   * 多选照片：一段配几张都行。点一下切换选中，最后点「配到这一段」。
   * 选中的会依次插在这段后面，作为独立的图片条目——数量不设上限。
   */
  function openMultiPhotoPicker(aid, title, onPick) {
    API.query('SELECT id, path, taken_year, place FROM photos WHERE archive_id=? ORDER BY taken_year, id', [aid])
      .then(function (photos) {
        var picked = {}, count = 0;
        var grid = '', i;
        for (i = 0; i < photos.length; i++) {
          var p = photos[i];
          grid += '<button class="pick-ph mpick" data-mpick="' + p.id + '">' +
            '<img src="' + esc(fsrc(p.path)) + '" alt="">' +
            '<span>' + esc(p.taken_year || '') + (p.place ? ' · ' + esc(p.place) : '') + '</span>' +
            '<em class="mpick-tick">✓</em></button>';
        }
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML = '<div class="ml-modal pick-modal"><h3>' + esc(title || '配图') + '</h3>' +
          '<p class="hint dim">点图片选中，可以多选，张数不设上限；第一张贴在段落里，其余按顺序跟在段落后面。</p>' +
          '<div class="pick-grid">' + (grid || '<p class="muted">这本档案还没有照片，先用「传」上传几张</p>') + '</div>' +
          '<div class="ml-modal-acts">' +
          '<button class="btn primary" data-mpick-ok="1" disabled>配到这一段</button>' +
          '<button class="btn" data-mpick-cancel="1">取消</button></div></div>';
        document.body.appendChild(ov);

        var okb = ov.querySelector('[data-mpick-ok]');
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-mpick-cancel]'))) {
            ov.parentNode.removeChild(ov); return;
          }
          var b = ev.target.closest && ev.target.closest('[data-mpick]');
          if (b) {
            var pid = b.getAttribute('data-mpick');
            if (picked[pid]) { delete picked[pid]; b.classList.remove('on'); count--; }
            else { picked[pid] = 1; b.classList.add('on'); count++; }
            okb.disabled = count === 0;
            okb.textContent = count ? ('配到这一段（' + count + ' 张）') : '配到这一段';
            return;
          }
          if (ev.target.closest && ev.target.closest('[data-mpick-ok]')) {
            var ids = [];
            for (var k in picked) if (picked.hasOwnProperty(k)) ids.push(Number(k));
            if (!ids.length) return;
            ids.sort(function (x, y) { return x - y; });
            ov.parentNode.removeChild(ov);
            onPick(ids);
          }
        });
      }).catch(fail);
  }

  /** 从段落清单里挑一段（用在「把这张图插到某段后面」） */
  function openParagraphPickerLocal(aid, onPick) {
    API.query('SELECT id, text, at_year, chapter_id FROM entries WHERE archive_id=? AND kind IN (?,?) ' +
      'ORDER BY COALESCE(sort_key,seq,0), id LIMIT 400', [aid, 'text', 'quote'])
      .then(function (list) {
        var rows = '', i;
        for (i = 0; i < list.length; i++) {
          var e = list[i];
          rows += '<button class="pick-ch" data-pick-para="' + e.id + '">' +
            '<b>' + (e.at_year ? esc(e.at_year + ' 年') : '未标年份') + '</b> ' +
            esc(String(e.text || '').slice(0, 56)) + '</button>';
        }
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML = '<div class="ml-modal pick-modal"><h3>插到哪一段后面</h3>' +
          '<div class="pick-chs">' + (rows || '<p class="muted">还没有段落</p>') + '</div>' +
          '<div class="ml-modal-acts"><button class="btn" data-pick-para-cancel="1">取消</button></div></div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pick-para-cancel]'))) {
            ov.parentNode.removeChild(ov); return;
          }
          var b = ev.target.closest && ev.target.closest('[data-pick-para]');
          if (b) {
            var eid = Number(b.getAttribute('data-pick-para'));
            ov.parentNode.removeChild(ov);
            onPick(eid);
          }
        });
      }).catch(fail);
  }

  /** 选一章（0 = 退回「待归档」） */
  function openChapterPicker(aid, onPick) {
    API.query('SELECT id, title, year_from, year_to FROM chapters WHERE archive_id=? ORDER BY seq, id', [aid])
      .then(function (chs) {
        var rows = '<button class="pick-ch" data-pick-ch="0">（退回待归档）</button>', i;
        for (i = 0; i < chs.length; i++) {
          var t = String(chs[i].title || '').replace(/^[^·]*·\s*/, '') || ('第 ' + (i + 1) + ' 章');
          rows += '<button class="pick-ch" data-pick-ch="' + chs[i].id + '">' + (i + 1) + '. ' + esc(t) + '</button>';
        }
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML = '<div class="ml-modal pick-modal"><h3>归到哪一章</h3>' +
          '<div class="pick-chs">' + rows + '</div>' +
          '<div class="ml-modal-acts"><button class="btn" data-pick-ch-cancel="1">取消</button></div></div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pick-ch-cancel]'))) {
            document.body.removeChild(ov);
            return;
          }
          var pb = ev.target.closest && ev.target.closest('[data-pick-ch]');
          if (pb) {
            var cid = Number(pb.getAttribute('data-pick-ch'));
            document.body.removeChild(ov);
            onPick(cid);
          }
        });
      }).catch(fail);
  }

  /** 段落之间的「＋ 在这里插入」——点了就在这个位置加，不用去猜别的入口 */
  function insPoint(afterId, chapterId) {
    return '<div class="ins"><button class="ins-btn" data-ins-after="' + (afterId || '') +
      '" data-ins-ch="' + (chapterId || '') + '">＋ 在这里插入</button></div>';
  }

  /** 插入菜单：插照片 / 写一段 */
  function openInsertMenu(aid, afterId, chapterId) {
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal"><h3>在这里插入</h3>' +
      '<div class="ins-menu">' +
      '<button class="ins-choice" data-ins-kind="photo">🖼 插一张照片</button>' +
      '<button class="ins-choice" data-ins-kind="text">✍ 写一段话</button>' +
      '</div>' +
      '<div class="ml-modal-acts"><button class="btn" data-ins-cancel="1">取消</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-ins-cancel]'))) {
        document.body.removeChild(ov); return;
      }
      var b = ev.target.closest && ev.target.closest('[data-ins-kind]');
      if (!b) return;
      var kind = b.getAttribute('data-ins-kind');
      document.body.removeChild(ov);
      if (kind === 'photo') {
        openInsertPhoto(aid, afterId || null, chapterId || null);
      } else {
        openTextPrompt('写一段话', '想到什么写什么，写错了随时能改', function (text) {
          DB.insertAfter(aid, { afterId: afterId || null, chapterId: chapterId || null, kind: 'text', text: text })
            .then(function () { toast('写好了'); route(); }).catch(fail);
        });
      }
    });
  }

  /** 插照片：列出还没放进正文的照片；没有就直接传一张新的 */
  function openInsertPhoto(aid, afterId, chapterId) {
    var sql = 'SELECT id, path, taken_year, place FROM photos WHERE archive_id=? ' +
      'AND id NOT IN (SELECT photo_id FROM entries WHERE archive_id=? AND photo_id IS NOT NULL) ' +
      'ORDER BY taken_year, id';
    API.query(sql, [aid, aid]).then(function (photos) {
      var grid = '', i;
      for (i = 0; i < photos.length; i++) {
        var p = photos[i];
        grid += '<button class="pick-ph" data-pick-ph="' + p.id + '">' +
          '<img src="' + esc(fsrc(p.path)) + '" alt="">' +
          '<span>' + esc(p.taken_year || '') + (p.place ? ' · ' + esc(p.place) : '') + '</span></button>';
      }
      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal pick-modal"><h3>选一张还没放进正文的照片</h3>' +
        '<div class="pick-grid">' + (grid || '<p class="muted">没有待放的照片了，可以点下面上传一张新的</p>') + '</div>' +
        '<div class="ml-modal-acts"><button class="btn" data-pick-upload="1">上传新照片</button>' +
        '<button class="btn" data-pick-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pick-cancel]'))) {
          document.body.removeChild(ov); return;
        }
        if (ev.target.closest && ev.target.closest('[data-pick-upload]')) {
          document.body.removeChild(ov);
          uploadToEntry(aid, chapterId, route, afterId);
          return;
        }
        var pb = ev.target.closest && ev.target.closest('[data-pick-ph]');
        if (pb) {
          var pid = Number(pb.getAttribute('data-pick-ph'));
          document.body.removeChild(ov);
          DB.insertAfter(aid, { afterId: afterId, chapterId: chapterId, kind: 'photo', photoId: pid })
            .then(function () { toast('插好了'); route(); }).catch(fail);
        }
      });
    }).catch(fail);
  }

  /** 简单的多行输入弹窗 */
  function openTextPrompt(title, placeholder, onOk) {
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal"><h3>' + esc(title) + '</h3>' +
      '<textarea id="insTextArea" placeholder="' + esc(placeholder) + '" ' +
      'style="width:100%;min-height:130px;box-sizing:border-box;font-family:inherit;font-size:15px;padding:10px"></textarea>' +
      '<div class="ml-modal-acts"><button class="btn primary" data-txt-ok="1">保存</button>' +
      '<button class="btn" data-txt-cancel="1">取消</button></div></div>';
    document.body.appendChild(ov);
    var ta = document.getElementById('insTextArea');
    if (ta) ta.focus();
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-txt-cancel]'))) {
        document.body.removeChild(ov); return;
      }
      if (ev.target.closest && ev.target.closest('[data-txt-ok]')) {
        var v = ta ? String(ta.value || '').trim() : '';
        document.body.removeChild(ov);
        if (v) onOk(v);
      }
    });
  }

  /** 刷新底部批量条：选中数量 + 是否显示 */
  function updateSelBar() {
    var n = 0, k;
    for (k in entrySel) if (entrySel.hasOwnProperty(k)) n++;
    var bar = document.getElementById('selBar');
    var cnt = document.getElementById('selCount');
    if (cnt) cnt.textContent = '已选 ' + n + ' 段';
    if (bar) { if (n) bar.className = 'sel-bar on'; else bar.className = 'sel-bar'; }
  }

  /* ---------------- 补内容 ---------------- */

  var rec = { mr: null, chunks: [], path: '', started: 0, native: false, peak: 0 };
  // 每段录音的播放地址：补内容页渲染时顺手记下，点击时不用再查库
  var segAudio = {};
  // 上一次转写失败的原始信息（模型、地址、HTTP 状态、响应体），给「看详情」用
  var lastDiag = null;

  function renderCollect(id) {
    app.innerHTML = topbar({
      back: '#/a/' + id, title: '补内容',
      right: [{ href: '#/a/' + id, text: '看档案' }]
    }) + '<main class="wrap narrow"><div class="boot">正在打开……</div></main>';

    DB.getArchive(id).then(function (d) {
      var a = d.archive;
      if (!a) throw new Error('找不到这本档案');

      var mats = '';
      segAudio = {};

      /* --- 讲述：可改可删，有录音的还能转成文字 --- */
      for (var i = d.segments.length - 1; i >= 0; i--) {
        var s = d.segments[i];
        var txt = String(s.raw_text || '');
        // 录音存进来时留的是占位文本，这时按钮说"转成文字"；转过之后是"再转一次"
        var pending = !!s.audio_path &&
          (!txt || txt.indexOf('待转写') >= 0 || txt.indexOf('录音已保存') >= 0);

        if (isEdit('seg', s.id)) {
          mats += '<div class="mat editing">' +
            '<textarea class="say mini" data-seg-text="' + s.id + '">' + esc(txt) + '</textarea>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-seg-save="' + s.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
          continue;
        }

        if (s.audio_path) segAudio[s.id] = s.audio_path;

        mats += '<div class="mat" data-mat="' + s.id + '">' +
          '<div class="mat-text">' +
          esc(txt.slice(0, 110)) + (txt.length > 110 ? '…' : '') + '</div>' +
          '<div class="mat-side">' + (s.year_hint ? s.year_hint + ' 年' : '未编年') + '</div>' +
          '<div class="mat-acts">' +
          (s.audio_path
            ? '<button class="btn tiny" data-play="' + s.id + '">试听</button>' +
              '<button class="btn tiny" data-tr="' + s.id + '">' +
              (pending ? '转成文字' : '再转一次') + '</button>'
            : '') +
          '<button class="btn tiny" data-seg-edit="' + s.id + '">改</button>' +
          '<button class="btn tiny" data-seg-upload="' + s.id + '">传</button>' +
          '<button class="btn tiny danger" data-seg-del="' + s.id + '">删</button>' +
          '</div></div>';
      }

      /* --- 照片：看得到、改得了、删得掉 --- */
      for (var pi = d.photos.length - 1; pi >= 0; pi--) {
        var ph = d.photos[pi];

        if (isEdit('photo', ph.id)) {
          mats += '<div class="mat editing">' +
            '<div class="ph-edit">' +
            '<img class="ph-thumb" src="' + esc(fsrc(ph.path)) + '" alt="">' +
            '<div class="ph-fields">' +
            '<label>哪一年<input class="fi" type="number" data-ph-year="' + ph.id +
            '" value="' + esc(ph.taken_year) + '" placeholder="1958"></label>' +
            '<label>在哪儿<input class="fi" data-ph-place="' + ph.id +
            '" value="' + esc(ph.place) + '" placeholder="北京"></label>' +
            '<label>什么事<input class="fi" data-ph-event="' + ph.id +
            '" value="' + esc(ph.event) + '" placeholder="在天安门前"></label>' +
            '</div></div>' +
            '<div class="mat-acts">' +
            '<button class="btn tiny primary" data-ph-save="' + ph.id + '">保存</button>' +
            '<button class="btn tiny" data-edit-cancel="1">取消</button></div></div>';
          continue;
        }

        mats += '<div class="mat">' +
          '<img class="mat-thumb" src="' + esc(fsrc(ph.path)) + '" alt="">' +
          '<div class="mat-text"><b>' + esc(ph.taken_year) + '</b> · ' +
          esc(ph.place) + ' · ' + esc(ph.event) + '</div>' +
          '<div class="mat-acts">' +
          '<button class="btn tiny" data-ph-edit="' + ph.id + '">改</button>' +
          '<button class="btn tiny danger" data-ph-del="' + ph.id + '">删</button>' +
          '</div></div>';
      }

      if (!mats) mats = '<p class="muted">还没有材料。上面说一段，或者加张照片。</p>';

      app.innerHTML = topbar({
        back: '#/a/' + id, title: '补内容',
        right: [{ href: '#/a/' + id, text: '看档案' }]
      }) + '<main class="wrap narrow">' +

        '<section class="blk">' +
        '<h1 class="blk-title">说一段</h1>' +
        '<p class="muted">想到哪说到哪。系统会按年份把内容排进档案，不用管顺序。</p>' +
        '<div class="ask"><span class="ask-label">可以这样开头</span>' +
        '<p id="askText">您是哪一年出生的？在什么地方？家里有几口人？</p>' +
        '<button class="btn tiny ghost" id="askNext">换一个问题</button></div>' +
        '<textarea id="sayText" class="say" rows="6" placeholder="也可以直接打字……"></textarea>' +
        '<div class="rec">' +
        '<button class="btn rec-btn" id="recBtn"><span class="dot"></span> <b>点一下，开始说</b></button>' +
        '<span class="rec-state" id="recState"></span></div>' +
        // 录完立刻能听：判断"录音本身有没有问题"最快的办法
        '<div class="rec-play" id="recPlayRow" hidden>' +
        '<audio id="recPlay" controls preload="metadata"></audio>' +
        '<span class="muted" id="recPlayTip">先听一遍，声音正常再存</span></div>' +
        '<select id="micSel" hidden class="mic-sel"></select>' +
        '<div class="row end"><button class="btn primary" id="saveSeg">存为一条讲述</button></div>' +
        '</section>' +

        '<section class="blk">' +
        '<h1 class="blk-title">加照片</h1>' +
        '<p class="muted">每张都要填三样：<b>哪一年、在哪儿、什么事</b>。这是照片能被排进档案的唯一依据。</p>' +
        '<label class="drop" id="drop">点这里选照片<input type="file" id="photoInput" accept="image/*" hidden></label>' +
        '<div id="phQueue"></div>' +
        '</section>' +

        '<section class="blk">' +
        '<h1 class="blk-title">已有的材料</h1>' +
        '<p class="muted">' + d.segments.length + ' 条讲述 · ' + d.photos.length + ' 张照片</p>' +
        '<div>' + (mats || '<p class="muted">还没有讲述。</p>') + '</div>' +
        // 转写失败时把原始信息摊在这里：是网络、Key、模型名还是音频本身的问题，一眼能分
        '<div class="last-diag" id="trDiag" hidden></div>' +
        '<div class="row"><button class="btn primary block" id="genBtn">整理进目录</button></div>' +
        '<p class="hint" id="genHint">把刚说的、传的，按人生阶段归进目录里对应的章。已经排好的章不会被打乱。</p>' +
        '<div class="row end"><button class="btn tiny ghost" id="genRebuild">' +
        '按年份重建整本目录（会拆掉现有章节，内容不丢）</button></div>' +
        '</section>' +

        '</main>';

      bindCollect(id, d);
    }).catch(function (e) {
      app.innerHTML = topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message) + '</div></main>';
    });
  }

  function bindCollect(id, d) {
    var QUESTIONS = [
      '您是哪一年出生的？在什么地方？家里有几口人？',
      '小时候住的房子是什么样的？院子里有什么？',
      '父亲母亲是做什么的？他们说话是什么样子？',
      '上学上到几年级？印象最深的老师是谁？',
      '第一次离开家是哪一年？去做什么？',
      '第一份工作是什么？第一个月挣了多少钱？',
      '成家那一年，是怎么操办的？',
      '这辈子最难的一年是哪一年？发生了什么？',
      '您最得意的一件事是什么？',
      '如果让您给孙子讲一件事，您会讲哪件？'
    ];
    var qi = 0;
    document.getElementById('askNext').onclick = function () {
      qi = (qi + 1) % QUESTIONS.length;
      document.getElementById('askText').textContent = QUESTIONS[qi];
    };

    var sayText = document.getElementById('sayText');
    var recBtn = document.getElementById('recBtn');
    var recState = document.getElementById('recState');

    /* ---- 播放：全页共用一个 <audio>，避免十段录音同时加载 ---- */

    function resetPlayBtns() {
      var bs = document.querySelectorAll('[data-play]');
      for (var i = 0; i < bs.length; i++) bs[i].textContent = '试听';
    }

    /** 录完立刻能听——这是判断"录音本身有没有问题"最快的办法 */
    function showRecPlay(path) {
      var row = document.getElementById('recPlayRow');
      var au = document.getElementById('recPlay');
      if (!row || !au) return;
      au.src = fsrc(path);
      row.hidden = false;
      au.load();
    }

    /** 转写失败的原始信息摊开：比一句"转不出来"有用一百倍 */
    function showDiag(diag) {
      var box = document.getElementById('trDiag');
      if (!box || !diag) return;
      var lines = [];
      if (diag.status !== undefined && diag.status !== null) lines.push('HTTP 状态：' + diag.status);
      if (diag.base) lines.push('接口地址：' + diag.base);
      if (diag.profile) lines.push('用的配置：' + diag.profile);
      if (diag.model) lines.push('模型：' + diag.model);
      if (diag.path) lines.push('音频：' + diag.path + (diag.bytes ? '（' + Math.round(diag.bytes / 1024) + ' KB）' : ''));
      if (diag.body) lines.push('服务端原话：' + diag.body);
      if (!lines.length) return;
      box.hidden = false;
      box.innerHTML = '<div class="diag-head"><b>上次转写失败详情</b>' +
        '<button class="btn tiny ghost" id="diagHide">收起</button></div>' +
        '<pre>' + esc(lines.join('\n')) + '</pre>';
      var h = document.getElementById('diagHide');
      if (h) h.onclick = function () { box.hidden = true; };
    }

    if (lastDiag) showDiag(lastDiag);

    /* --- 录音：边录边写盘，别攒在内存里 ---
     *
     * 两条路：
     *  ① 安卓壳里的 NativeRec（原生 AudioRecord）——稳，优先走这条
     *  ② 浏览器 / WebView 的 getUserMedia —— Windows 版和普通浏览器走这条
     * 安卓上 getUserMedia 经常被 WebView 那一层挡掉（系统权限给了也没用），
     * 所以原生这条路是主力，WebView 那条只当兜底。
     */
    var NATIVE = window.NativeRec || null;
    var canRec = !!NATIVE || (typeof MediaRecorder !== 'undefined' &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!canRec) {
      recState.textContent = '这台设备不支持录音，可以直接打字';
      recBtn.disabled = true;
    } else {
      recState.textContent = '录音会同时留着原声';
    }

    var recording = false;
    var nativeTick = 0;
    recBtn.onclick = function () {
      if (!canRec) return;
      if (recording) return stopRec();
      startRec();
    };

    /**
     * 麦克风选择：装了 ToDesk 这类远控软件后，系统会多出一个虚拟声卡，
     * Chrome 默认抓的输入设备很可能不是你以为的那个——录出来全是静音。
     * 把设备列出来让用户自己挑，选一次就记住。
     */
    function fillMicList() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (ds) {
        var sel = document.getElementById('micSel');
        if (!sel) return;
        var saved = localStorage.getItem('mylife.mic') || '';
        var html = '', n = 0;
        for (var i = 0; i < ds.length; i++) {
          if (ds[i].kind !== 'audioinput') continue;
          n++;
          var label = ds[i].label || ('麦克风 ' + n);
          html += '<option value="' + esc(ds[i].deviceId) + '"' +
            (ds[i].deviceId === saved ? ' selected' : '') + '>' + esc(label) + '</option>';
        }
        sel.innerHTML = html;
        sel.hidden = n < 2;   // 只有一个设备就不摆出来添乱
      }).catch(function () {});
    }
    if (!NATIVE) fillMicList();   // 原生录音直接抓系统默认麦克风，不用挑设备

    var micSel = document.getElementById('micSel');
    if (micSel) micSel.onchange = function () {
      localStorage.setItem('mylife.mic', micSel.value);
      toast('已切换麦克风：' + (micSel.options[micSel.selectedIndex] || {}).text);
    };

    function startRec() {
      if (NATIVE) return startRecNative();
      return startRecWeb('');
    }

    /* ---- ① 原生录音（安卓壳里的 AudioRecord） ---- */

    function startRecNative() {
      var st = '';
      try { st = String(NATIVE.state() || ''); } catch (e) { st = ''; }
      if (st.indexOf('granted') < 0) {
        recState.textContent = '正在请求麦克风权限……';
        window.__micPerm = function (r) {
          window.__micPerm = null;
          if (String(r) === 'granted') doStartNative();
          else {
            recState.textContent = '系统没放行麦克风（' + r + '）。到「设置 → 应用 → 我的人生档案 → 权限」' +
              '把麦克风改成「仅使用期间允许」，再点一次';
          }
        };
        try { NATIVE.ask(); } catch (e) {
          window.__micPerm = null;
          recState.textContent = '要不了麦克风权限：' + e.message;
        }
        return;
      }
      doStartNative();
    }

    function doStartNative() {
      var name = 'seg-' + id + '-' + Date.now() + '.wav';
      var r = '';
      try { r = String(NATIVE.start(API.auth.token(), name) || ''); } catch (e) { r = 'err:' + e.message; }

      if (r.indexOf('ok') !== 0) {
        if (r.indexOf('needperm') >= 0) {
          recState.textContent = '系统还没给麦克风权限，去设置里打开再点一次';
          return;
        }
        // 原生也开不了：退回 WebView 那条路再试一次，两条路都失败就把原因一起报出来
        var why = r.replace(/^err:/, '');
        recState.textContent = '原生录音开不了（' + why + '），换一条路试试……';
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return startRecWeb(why);
        recState.textContent = '录音打不开：' + why + '。可以先直接打字';
        return;
      }

      recording = true;
      rec.native = true;
      rec.peak = 0;
      rec.started = Date.now();
      rec.path = '';
      recBtn.className = 'btn rec-btn on';
      recBtn.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>';
      recState.textContent = '正在听……';

      nativeTick = setInterval(function () {
        if (!recording) return;
        var pk = 0, sec = 0;
        try { pk = Number(NATIVE.level()) || 0; } catch (e) {}
        try { sec = Number(NATIVE.seconds()) || 0; } catch (e) {}
        if (pk > rec.peak) rec.peak = pk;
        var db = pk > 0 ? Math.round(20 * Math.log(pk) / Math.LN10 * 10) / 10 : -99;
        recState.textContent = '正在听… 音量 ' + db + ' dB · 已录 ' + sec + ' 秒' +
          (pk < 0.01 ? '（几乎没有声音，对着手机底下的小孔说）' : '');
        if (sec >= 600) stopRec();      // 10 分钟上限：再长转写服务就不收了
      }, 500);
    }

    function stopRecNative() {
      recording = false;
      rec.native = false;
      if (nativeTick) { clearInterval(nativeTick); nativeTick = 0; }
      recBtn.className = 'btn rec-btn';
      recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';

      var out = null;
      try { out = JSON.parse(String(NATIVE.stop() || '{}')); } catch (e) { out = null; }
      if (!out || !out.ok) {
        recState.textContent = '这段没存下来：' + ((out && out.err) || '一个字节都没录到') + '，重录一次试试';
        return;
      }
      if (Number(out.peak) < 0.01) {
        // 全静音的文件留着也是垃圾，让原生删掉
        try { NATIVE.cancel(); } catch (e) {}
        recState.textContent = '这段全是静音。看看手机壳有没有挡到麦克风孔，再录一次';
        return;
      }
      rec.path = out.path;
      recState.textContent = '录好了 ' + out.seconds + ' 秒 · 先听一遍，再点「存为一条讲述」';
      showRecPlay(out.path);
    }

    /* ---- ② WebView / 浏览器录音（兜底） ---- */

    function startRecWeb(nativeErr) {
      // AudioContext 必须在点击手势里创建并确认运行——
      // 在 getUserMedia 回调里才创建的话，Chrome 会把它挂起：
      // 回调照常触发、文件照常生成，但里面全是接近全零的低频噪声，
      // 转写服务返回空，界面上就成了"录音是空的"。
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        recState.textContent = '这个浏览器内核太老，录不了音' + (nativeErr ? '（' + nativeErr + '）' : '') + '，可以先直接打字';
        return;
      }
      var ctx;
      try { ctx = new AC(); } catch (e) {
        recState.textContent = '音频通道打不开（' + e.name + '）' + (nativeErr ? '，原生录音也失败：' + nativeErr : '') + '，可以先直接打字';
        return;
      }
      var kick = (ctx.state === 'suspended') ? ctx.resume() : Promise.resolve();
      kick.then(function () {
        // 用用户选过的麦克风；没选过就让系统定（选错设备是"录出来全静音"的头号原因）
        var cons = { audio: true };
        var savedMic = localStorage.getItem('mylife.mic');
        if (savedMic) cons.audio = { deviceId: { exact: savedMic } };
        return navigator.mediaDevices.getUserMedia(cons);
      }).then(function (stream) {
        rec.chunks = [];
        rec.path = '';
        rec.native = false;
        rec.started = Date.now();
        rec.peak = 0;                 // 全程最大瞬时音量，停的时候用来判断"到底录没录上"
        var src = ctx.createMediaStreamSource(stream);
        var proc = ctx.createScriptProcessor(4096, 1, 1);
        var mute = ctx.createGain();  // 采到的声音不能外放出去（会啸叫），接个零增益
        mute.gain.value = 0;
        proc.onaudioprocess = function (e) {
          if (!recording) return;
          var d = e.inputBuffer.getChannelData(0);
          rec.chunks.push(new Float32Array(d));
          // 实时算峰值，让用户看得见"有没有录上"
          var pk = 0;
          for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
          if (pk > rec.peak) rec.peak = pk;
          var db = pk > 0 ? Math.round(20 * Math.log(pk) / Math.LN10 * 10) / 10 : -99;
          recState.textContent = '正在听… 音量 ' + db + ' dB' +
            (pk < 0.01 ? '（几乎没有声音，检查麦克风）' : '');
          // 12 分钟上限：WAV 到 25MB 附近，转写服务就不收了
          if (rec.chunks.length * 4096 / ctx.sampleRate > 720) stopRec();
        };
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);   // ScriptProcessor 必须接到输出才会跑
        rec.ctx = ctx; rec.src = src; rec.proc = proc; rec.stream = stream; rec.mute = mute;

        recording = true;
        recBtn.className = 'btn rec-btn on';
        recBtn.innerHTML = '<span class="dot"></span> <b>正在录 · 点这里停下</b>';
        recState.textContent = ctx.state === 'running'
          ? '正在听……'
          : '音频通道没就绪（' + ctx.state + '），重试一次';
      }).catch(function (e) {
        // 以前这里一律说"没有拿到麦克风权限"，把设备不可用、被占用、
        // WebView 不放行全糊成一句，反而让人以为是自己权限没开。
        var n = (e && e.name) || '';
        var tip;
        if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
          tip = '系统/网页内核没放行麦克风（NotAllowedError）';
        } else if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
          tip = '系统里找不到可用的麦克风（NotFoundError）';
        } else if (n === 'NotReadableError' || n === 'TrackStartError') {
          tip = '麦克风被别的应用占着（NotReadableError），先关掉录音、通话、语音助手再试';
        } else if (n === 'OverconstrainedError') {
          try { localStorage.removeItem('mylife.mic'); } catch (e2) {}
          tip = '上次选的麦克风不在了，已重置，再点一次';
        } else {
          tip = '录音打不开' + (n ? '（' + n + (e.message ? '：' + e.message : '') + '）' : '');
        }
        recState.textContent = tip + (nativeErr ? '；原生录音也失败：' + nativeErr : '') + '。也可以直接打字';
      });
    }

    /** 采到的浮点 PCM 合并、降采样到 16k、打成 16bit 单声道 WAV */
    function buildWav(chunks, srcRate, targetRate) {
      var total = 0, i;
      for (i = 0; i < chunks.length; i++) total += chunks[i].length;
      var merged = new Float32Array(total);
      var off = 0;
      for (i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }

      var ratio = srcRate / targetRate;
      var n = Math.floor(total / ratio);
      var pcm = new Int16Array(n);
      for (i = 0; i < n; i++) {
        var v = merged[Math.floor(i * ratio)];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }

      var buf = new ArrayBuffer(44 + n * 2);
      var dv = new DataView(buf);
      function wstr(o, s) { for (var k = 0; k < s.length; k++) dv.setUint8(o + k, s.charCodeAt(k)); }
      wstr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true);
      wstr(8, 'WAVE'); wstr(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, targetRate, true); dv.setUint32(28, targetRate * 2, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wstr(36, 'data'); dv.setUint32(40, n * 2, true);
      new Int16Array(buf, 44).set(pcm);
      return buf;
    }

    function stopRec() {
      if (!recording) return;
      if (rec.native) return stopRecNative();
      recording = false;
      try { if (rec.proc) rec.proc.disconnect(); } catch (e) {}
      try { if (rec.src) rec.src.disconnect(); } catch (e) {}
      try { if (rec.mute) rec.mute.disconnect(); } catch (e) {}
      try { if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (rec.ctx) rec.ctx.close(); } catch (e) {}

      // 全程峰值都接近零＝根本没录上声音，别浪费一次转写
      if (rec.peak < 0.01) {
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
        recState.textContent = '这段全是静音。多半是抓错了麦克风——从上面「麦克风」下拉里换一个设备（选真实麦克风阵列，别选 ToDesk 虚拟声卡），再录一次';
        return;
      }

      var rate = rec.ctx ? rec.ctx.sampleRate : 48000;
      var buf = buildWav(rec.chunks, rate, 16000);
      var bytes = new Uint8Array(buf);
      // 一段段拼 base64，直接 apply 几 MB 会爆栈
      var bin = '', CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      var b64 = btoa(bin);
      var name = 'seg-' + id + '-' + rec.started + '.wav';
      var sec = Math.round((Date.now() - rec.started) / 1000);

      recState.textContent = '正在保存录音…';
      API.file({ op: 'save', kind: 'audio', name: name, base64: b64 }).then(function (r) {
        if (r && r.path) rec.path = r.path;
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
        recState.textContent = '录好了 ' + sec + ' 秒 · 先听一遍，再点「存为一条讲述」';
        if (rec.path) showRecPlay(rec.path);
      }).catch(function () {
        recState.textContent = '录音保存失败，重录一次试试';
        recBtn.className = 'btn rec-btn';
        recBtn.innerHTML = '<span class="dot"></span> <b>点一下，开始说</b>';
      });
    }

    /* --- 存一条讲述 --- */
    document.getElementById('saveSeg').onclick = function () {
      var btn = this;
      btn.disabled = true;
      DB.addSegment(id, sayText.value, rec.path || null).then(function () {
        toast('存好了');
        rec.path = '';
        setTimeout(function () { renderCollect(id); }, 300);
      }).catch(function (e) { fail(e); btn.disabled = false; });
    };

    /* --- 加照片 --- */
    var input = document.getElementById('photoInput');
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) return toast('这张超过 20MB，换一张小点的');
      compress(file, function (dataUrl) {
        showPhotoForm(id, dataUrl);
      });
    };

    /* --- 语音转文字 + 改 / 删 --- */
    // 反复进出这页时，监听器不能一层层往上叠
    if (collectClickHandler) app.removeEventListener('click', collectClickHandler);
    collectClickHandler = function (ev) {
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var b, sid;

      /* 试听这一段录音 */
      if ((b = t.closest('[data-play]'))) {
        sid = Number(b.getAttribute('data-play'));
        var src = segAudio[sid];
        if (!src) return;
        var ap = document.getElementById('segPlayer');
        var host = b.parentNode.parentNode;      // .mat
        if (!ap) {
          ap = document.createElement('audio');
          ap.id = 'segPlayer';
          ap.controls = true;
          ap.preload = 'metadata';
          ap.addEventListener('ended', function () { resetPlayBtns(); });
          ap.addEventListener('pause', function () {
            if (ap.currentTime > 0 && !ap.ended) return;   // 拖动进度条不算停
            resetPlayBtns();
          });
        }
        // 全页只有这一个播放器，点到哪一段就把它挪到哪一段下面
        if (ap.parentNode !== host) host.appendChild(ap);
        var want = fsrc(src);
        if (ap.getAttribute('data-src') === want) {
          if (ap.paused) { ap.play(); b.textContent = '暂停'; }
          else { ap.pause(); b.textContent = '试听'; }
          return;
        }
        resetPlayBtns();
        ap.setAttribute('data-src', want);
        ap.src = want;
        var pr = ap.play();
        // 播不动就把原因说出来，别让人对着按钮瞎猜
        if (pr && pr.catch) pr.catch(function (e) {
          toast('这段音频打不开：' + (e && e.name ? e.name : e.message || e));
        });
        b.textContent = '暂停';
        return;
      }

      /* 转成文字 */
      if ((b = t.closest('[data-tr]'))) {
        sid = Number(b.getAttribute('data-tr'));
        if (b.disabled) return;
        b.disabled = true;
        var label = b.textContent;
        b.textContent = '转写中…';
        DB.transcribe(sid).then(function (r) {
          if (!r.ok) {
            lastDiag = r.diag || null;
            toast(r.message || '转不出来');
            b.disabled = false;
            b.textContent = label;
            if (lastDiag) showDiag(lastDiag);
            return;
          }
          lastDiag = null;
          toast('转好了（' + (r.ms / 1000).toFixed(1) + 's' +
            (r.switched ? '，已自动改用 ' + r.switched : '') + '）：' + String(r.text).slice(0, 20));
          route();   // 重画整页，把转出来的文字显示出来
        }).catch(function (e) {
          toast(e.message || '转不出来');
          b.disabled = false;
          b.textContent = label;
        });
        return;
      }

      /* 进入编辑 */
      if ((b = t.closest('[data-seg-edit]'))) {
        editState = { type: 'seg', id: Number(b.getAttribute('data-seg-edit')) };
        return route();
      }
      if ((b = t.closest('[data-ph-edit]'))) {
        editState = { type: 'photo', id: Number(b.getAttribute('data-ph-edit')) };
        return route();
      }
      if ((b = t.closest('[data-edit-cancel]'))) {
        clearEdit();
        return route();
      }

      /* 保存 */
      if ((b = t.closest('[data-seg-save]'))) {
        sid = Number(b.getAttribute('data-seg-save'));
        var ta = document.querySelector('[data-seg-text="' + sid + '"]');
        DB.updateSegment(sid, ta ? ta.value : '').then(function () {
          clearEdit();
          toast('改好了');
          route();
        }).catch(fail);
        return;
      }
      if ((b = t.closest('[data-ph-save]'))) {
        var pid = Number(b.getAttribute('data-ph-save'));
        var g = function (sel) {
          var el = document.querySelector('[data-ph-' + sel + '="' + pid + '"]');
          return el ? el.value : '';
        };
        DB.updatePhoto(pid, { year: g('year'), place: g('place'), event: g('event') })
          .then(function () {
            clearEdit();
            toast('改好了');
            route();
          }).catch(fail);
        return;
      }

      /* 删除：都先问一句，删了就找不回来了 */
      if ((b = t.closest('[data-seg-del]'))) {
        var dseg = Number(b.getAttribute('data-seg-del'));
        if (!confirm('删掉这段讲述？删了就找不回来了。')) return;
        DB.deleteSegment(dseg).then(function () { toast('已删除'); route(); }).catch(fail);
        return;
      }
      /* 采集页的「传」：媒体先进待归档，生成档案时归位 */
      if ((b = t.closest('[data-seg-upload]'))) {
        uploadToEntry(id, null, function () {
          toast('传好了，生成档案时会排进卷宗');
          route();
        });
        return;
      }
      if ((b = t.closest('[data-ph-del]'))) {
        var dph = Number(b.getAttribute('data-ph-del'));
        if (!confirm('删掉这张照片？删了就找不回来了。')) return;
        DB.deletePhoto(dph).then(function () { toast('已删除'); route(); }).catch(fail);
        return;
      }
    };
    app.addEventListener('click', collectClickHandler);

    /* --- 生成 --- */
    document.getElementById('genBtn').onclick = function () {
      var btn = this, hint = document.getElementById('genHint');
      btn.disabled = true;
      hint.textContent = '正在把材料归进目录……';
      DB.buildOutline(id).then(function (r) {
        hint.textContent = (r && r.created)
          ? ('建好了 ' + r.created + ' 章，正在打开')
          : ('归好了 ' + ((r && r.homed) || 0) + ' 段，正在打开');
        setTimeout(function () { go('#/a/' + id); }, 400);
      }).catch(function (e) {
        hint.textContent = '';
        btn.disabled = false;
        fail(e);
      });
    };

    var rb = document.getElementById('genRebuild');
    if (rb) rb.onclick = function () {
      if (!confirm('会按年份把整本目录重新拆排一遍。内容和照片都不会丢，但你手动改过的章节顺序会变。继续吗？')) return;
      var btn = this, hint = document.getElementById('genHint');
      btn.disabled = true;
      hint.textContent = '正在读你的讲述……';
      DB.generate(id).then(function () {
        hint.textContent = '装订完成，正在打开';
        setTimeout(function () { go('#/a/' + id); }, 400);
      }).catch(function (e) {
        hint.textContent = '';
        btn.disabled = false;
        fail(e);
      });
    };
  }

  /** 用 canvas 压到 1600px，避免原图太大 */
  function compress(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height, max = 1600;
        if (w > max || h > max) {
          var r = Math.min(max / w, max / h);
          w = Math.round(w * r);
          h = Math.round(h * r);
        }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        try {
          done(cv.toDataURL('image/jpeg', 0.86));
        } catch (e) {
          done(reader.result);
        }
      };
      img.onerror = function () { toast('这张图读不了'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function showPhotoForm(id, dataUrl) {
    var box = document.getElementById('phQueue');
    box.innerHTML = '<div class="ph-item" id="phForm">' +
      '<div class="idx">给这张照片标三样</div>' +
      '<img src="' + dataUrl + '" alt="">' +
      '<div class="row"><div class="col"><label>哪一年（必填）</label>' +
      '<input id="fYear" inputmode="numeric" placeholder="1975"></div>' +
      '<div class="col"><label>在哪儿（必填）</label>' +
      '<input id="fPlace" placeholder="沈阳，纺织厂门口"></div></div>' +
      '<div class="fld"><label>什么事（必填）</label>' +
      '<input id="fEvent" placeholder="进厂第一年，穿新工装"></div>' +
      '<div class="row end">' +
      '<button class="btn ghost tiny" id="phCancel">取消</button>' +
      '<button class="btn primary" id="phSave">保存</button></div></div>';

    document.getElementById('phCancel').onclick = function () { box.innerHTML = ''; };
    document.getElementById('phSave').onclick = function () {
      var y = document.getElementById('fYear').value.trim();
      var p = document.getElementById('fPlace').value.trim();
      var ev = document.getElementById('fEvent').value.trim();
      if (!y) return toast('这张是哪一年的？');
      if (!p) return toast('这张照片是在哪儿拍的？');
      if (!ev) return toast('这张照片是什么事？');
      this.disabled = true;
      DB.addPhoto(id, dataUrl, parseInt(y, 10), p, ev).then(function () {
        toast('照片存好了');
        box.innerHTML = '';
        renderCollect(id);
      }).catch(function (e) { fail(e); });
    };
  }

  /* ---------------- 设置 ---------------- */

  var KINDS = [
    { k: 'openai', label: 'OpenAI 兼容', base: 'https://api.openai.com/v1', key: true },
    { k: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', key: true },
    { k: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1', key: true },
    { k: 'zhipu', label: '智谱 bigmodel', base: 'https://open.bigmodel.cn/api/paas/v4', key: true },
    { k: 'groq', label: 'Groq（需外网）', base: 'https://api.groq.com/openai/v1', key: true },
    { k: 'ollama', label: '本机 Ollama', base: 'http://127.0.0.1:11434/v1', key: false },
    { k: 'custom', label: '自定义 / 内网', base: '', key: true }
  ];

  // 平台注册入口。前者是本项目作者的硅基流动邀请码，点了两边都有券；
  // 后面各家是实测能领到免费额度、且接口与本项目兼容的。
  var SIGNUP = [
    { name: '硅基流动', url: 'https://cloud.siliconflow.cn/i/oSZ7RcMc',
      note: '免费档常驻模型：SenseVoiceSmall / TeleSpeechASR（语音转文字）、DeepSeek-OCR（看图）、Hunyuan-MT-7B（写稿）、Qwen3-8B', star: true },
    { name: '腾讯云混元', url: 'https://curl.qcloud.com/ofeR1Flf',
      note: '首次开通送 100 万 tokens（含 hunyuan-turbos-vision 等多模态），有效期 1 年；hunyuan-lite 永久免费' },
    { name: '智谱 bigmodel', url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
      note: 'Flash 系列永久免费，GLM-4.6V-Flash 是免费的多模态（能看懂照片场景，比 OCR 更进一步）' }
  ];

  function kindLabel(k) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].k === k) return KINDS[i].label;
    return k;
  }

  var APP_VERSION = 'v0.9.6';  // 与 CHANGELOG.md、server.js 保持一致
  var editing = null;          // 正在编辑的配置；null 表示新增
  var settingsClickHandler = null;   // 反复进出设置页时不能叠加监听器
  var collectClickHandler = null;    // 同上，采集页的「转成文字」
  var archiveClickHandler = null;    // 同上，卷宗页的改与删
  var archiveChangeHandler = null;   // 卷宗页勾选框
  var homeClickHandler = null;       // 同上，首页的导出

  /* 就地编辑：哪一条正在被改。type 为 seg / photo / entry / chapter，null 表示没在改 */
  var editState = { type: null, id: null };

  function isEdit(type, id) {
    return editState.type === type && String(editState.id) === String(id);
  }

  function clearEdit() { editState.type = null; editState.id = null; }

  function renderSettings() {
    Promise.all([DB.listProfiles(), DB.getSlots(), DB.getSettings(), API.auth.me().catch(function(){return {};})]).then(function (r) {
      var profiles = r[0], slots = r[1], cfg = r[2], me = r[3] || {};
      var isAdmin = !!me.isAdmin;
      var slotMap = {};
      for (var i = 0; i < slots.length; i++) slotMap[slots[i].slot] = slots[i];

      var html = topbar({ back: '#/', title: '设置' }) + '<main class="wrap narrow">';

      /* ---- 账号（v0.9：单机版多用户 / 找回密码） ---- */
      html += '<h2 class="set-h">账号</h2>' +
        '<div class="acc-actions">' +
        '<button class="btn" id="accChPw">修改密码</button>' +
        '<button class="btn" id="accSec">设置密保问题</button>' +
        (isAdmin ? '<a class="btn" href="#/users">用户管理</a>' : '') +
        '</div>' +
        '<p class="hint dim">忘记密码时，可用密保问题自助找回；管理员也能在「用户管理」里重置他人密码。</p>';

      /* ---- 模型来源 ---- */
      html += '<h2 class="set-h">模型来源</h2>' +
        '<p class="hint">随便加几条，用哪个都行。不配也能用——章节名会按年份和内容自动生成。</p>' +
        '<p class="hint dim">「拉模型」只读模型清单，几乎不占资源；「测试」会真发一句话。' +
        '标着<b>本机</b>的配置会把模型加载进这台机器，没有独立显卡时很慢也很吃内存，' +
        '平时建议用云端服务。</p>';

      /* ---- 该填什么模型：照抄就行，这些全都免费 ---- */
      html += '<h2 class="set-h">该填什么模型</h2>' +
        '<p class="hint">下面这几款都是实测过、不用花钱的，照着名字抄进「模型 ID」即可。</p>' +
        '<dl class="ai-kv pick">' +
        '<dt>起章名 / 写简介</dt><dd><code>tencent/Hunyuan-MT-7B</code> <span class="muted">0.5 秒</span></dd>' +
        '<dt>看照片</dt><dd><code>deepseek-ai/DeepSeek-OCR</code> <span class="muted">0.3 秒</span></dd>' +
        '<dt>语音转文字</dt><dd><code>Qwen/Qwen3-ASR-1.7B</code> <span class="muted">0.4 秒</span></dd>' +
        '<dt>要更好文笔</dt><dd><code>Qwen/Qwen3-8B</code> <span class="muted">免费但慢些（会先思考）</span></dd>' +
        '<dt>图片生成</dt><dd><code>Kwai-Kolors/Kolors</code> <span class="muted">免费，功能接入前可先配好</span></dd>' +
        '<dt>视频生成</dt><dd><code>Wan-AI/Wan2.2-T2V-A14B</code> 等 <span class="warn-text">很贵，一条几块钱起，慎重</span></dd>' +
        '</dl>' +
        '<p class="hint dim">想让程序真正「看懂」照片场景而不只是认字，' +
        '可以去智谱开个号用 <code>GLM-4.6V-Flash</code>，那是免费的多模态模型。' +
        '视频生成模型普遍较贵，等功能接入再配不迟。</p>';

      /* ---- 去哪拿 Key（常驻，不只在没配置时才出现） ---- */
      var links = '';
      for (var gi = 0; gi < SIGNUP.length; gi++) {
        var g = SIGNUP[gi];
        links += '<a class="signup" href="' + esc(g.url) + '" target="_blank" rel="noopener"' +
          (g.star ? ' data-star="1"' : '') + '>' +
          '<b>' + esc(g.name) + '</b>' +
          (g.star ? '<span class="tag">推荐</span>' : '') +
          '<span class="su-arrow">→</span>' +
          '<small>' + esc(g.note) + '</small></a>';
      }
      html += '<div class="signup-box">' +
        '<p class="hint">' + (profiles.length
          ? '要去别家拿免费额度？这几家都能直接用：'
          : '还没有 API Key？这几家都有免费额度，注册就能用，不用先充值：') + '</p>' +
        links + '</div>';

      if (!profiles.length) {
        html += '<div class="empty">还没有配置。点下面「添加」开始。</div>';
      }

      // 五个环节。kind 决定模型下拉只列哪一类；rec 是一个 Key 就自动配好的推荐款。
      // img/vid 是给接下来的图片生成、视频生成功能预留的，功能上线前先配好不耽误事
      var SLOTS = [
        { k: 'title', label: '起章名 / 写简介', kind: 'text',
          rec: ['tencent/Hunyuan-MT-7B', 'Qwen/Qwen3-8B'],
          hint: '要一点文笔。填好 Key 会自动配好，不用动' },
        { k: 'vision', label: '看照片', kind: 'vision',
          rec: ['deepseek-ai/DeepSeek-OCR'],
          hint: '认老照片上的字和场景，必须用看图的模型' },
        { k: 'asr', label: '语音转文字', kind: 'asr',
          rec: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR', 'glm-asr-2512', 'whisper-large-v3-turbo'],
          hint: '能走转写接口的模型不多：SenseVoiceSmall、TeleSpeechASR（硅基流动免费）、glm-asr-2512、whisper-large-v3' },
        { k: 'img', label: '图片生成（预留）', kind: 't2i',
          rec: ['Kwai-Kolors/Kolors'],
          hint: '文生图，功能快来了，先配好备用。Kolors 免费' },
        { k: 'vid', label: '视频生成（预留）', kind: 't2v',
          rec: ['Wan-AI/Wan2.2-T2V-A14B'],
          hint: '文生视频，普遍很贵（一条几块钱起）。功能接入前配好备用即可，不配不影响其它功能' }
      ];

      for (var p = 0; p < profiles.length; p++) {
        var pf = profiles[p];
        var models = [];
        try { models = JSON.parse(pf.models_json || '[]'); } catch (e) { models = []; }
        // 本机部署（ollama / vLLM / LM Studio）：点测试会真的把模型加载进内存
        var local = /127\.0\.0\.1|localhost|0\.0\.0\.0|192\.168\.|:11434/.test(pf.base_url || '');
        // 这张卡上写全：接口地址、密钥、现在用着的模型、各自负责哪一环。
        // 不用去猜"填在哪"，一眼能核对。
        var keyMask = pf.api_key
          ? String(pf.api_key).slice(0, 6) + '…' + String(pf.api_key).slice(-4)
          : '<span class="warn-text">没填（本机模型不需要）</span>';

        var usedBy = [];
        for (var sl = 0; sl < SLOTS.length; sl++) {
          var bind = slotMap[SLOTS[sl].k] || {};
          if (String(bind.profile_id) === String(pf.id)) {
            usedBy.push(SLOTS[sl].label + ' → ' + (bind.model || pf.default_model || '?'));
          }
        }

        html += '<div class="ai-card' + (pf.enabled ? '' : ' off') + '">' +
          '<div class="ai-card-top">' +
          '<b>' + esc(pf.name) + '</b>' +
          '<span class="tag">' + esc(kindLabel(pf.kind)) + '</span>' +
          (local ? '<span class="tag warn" title="模型跑在这台机器上">本机</span>' : '') +
          '<button class="linkbtn" data-toggle="' + pf.id + '" data-to="' + (pf.enabled ? 0 : 1) + '">' +
          (pf.enabled ? '停用' : '启用') + '</button>' +
          '</div>' +

          '<dl class="ai-kv">' +
          '<dt>接口地址</dt><dd><code>' + esc(pf.base_url) + '</code></dd>' +
          '<dt>密钥</dt><dd><code>' + keyMask + '</code></dd>' +
          '<dt>默认模型</dt><dd><code>' +
            (pf.default_model ? esc(pf.default_model) : '还没选') + '</code></dd>' +
          '<dt>负责</dt><dd>' + (usedBy.length
            ? usedBy.join('；')
            : '<span class="muted">没绑到具体环节（会被自动挑用）</span>') + '</dd>' +
          '</dl>' +

          '<div class="ai-acts">' +
          '<button class="btn tiny" data-test="' + pf.id + '"' +
            (local ? ' data-local="1"' : '') + '>测试</button>' +
          '<button class="btn tiny" data-pull="' + pf.id + '">拉模型</button>' +
          '<button class="btn tiny" data-edit="' + pf.id + '">改</button>' +
          '<button class="btn tiny danger" data-del="' + pf.id + '">删</button>' +
          '</div></div>';
      }

      html += '<div id="profileForm"></div>' +
        (profiles.length ? '' : '') +
        '<div class="row end" style="margin-top:14px">' +
        '<button class="btn" id="addProfile">＋ 添加配置</button></div>';

      /* ---- 用途绑定 ---- */
      html += '<h2 class="set-h">各环节用哪个模型</h2>' +
        '<p class="hint">留空就用上面第一条可用的配置。这三个环节可以同时用不同家的服务。</p>';

      for (var si = 0; si < SLOTS.length; si++) {
        var sl = SLOTS[si];
        var bound = slotMap[sl.k] || {};
        var opts = '<option value="">不用（按规则）</option>';
        for (var q = 0; q < profiles.length; q++) {
          opts += '<option value="' + profiles[q].id + '"' +
            (String(bound.profile_id) === String(profiles[q].id) ? ' selected' : '') + '>' +
            esc(profiles[q].name) + '</option>';
        }

        // 模型下拉只列这一环节用得上的：给"看照片"选模型时，
        // 纯文本模型压根不该出现在列表里——选了也调不通。
        var slotModels = [];
        var seen = {};
        function pushModel(id) {
          if (!id || seen[id]) return;
          seen[id] = 1;
          slotModels.push(id);
        }
        // 绑定的那条配置里拉到过的模型优先
        if (bound.profile_id) {
          for (var q2 = 0; q2 < profiles.length; q2++) {
            if (String(profiles[q2].id) === String(bound.profile_id)) {
              var ml = [];
              try { ml = JSON.parse(profiles[q2].models_json || '[]'); } catch (e) {}
              for (var m1 = 0; m1 < ml.length; m1++) {
                if (DB.modelKind(ml[m1]) === sl.kind) pushModel(ml[m1]);
              }
            }
          }
        }
        // 兜底：把所有配置里同类的模型也列上，跨家换着用不用来回改
        for (var q3 = 0; q3 < profiles.length; q3++) {
          var ml2 = [];
          try { ml2 = JSON.parse(profiles[q3].models_json || '[]'); } catch (e2) {}
          for (var m2 = 0; m2 < ml2.length; m2++) {
            if (DB.modelKind(ml2[m2]) === sl.kind) pushModel(ml2[m2]);
          }
        }
        // 连拉都没拉过：把写死的推荐款摆出来，照抄也能用
        if (!slotModels.length && sl.rec) {
          for (var r = 0; r < sl.rec.length; r++) pushModel(sl.rec[r]);
        }

        var mopts = '<option value="">' +
          (bound.model ? '当前：' + esc(bound.model) : '自动（用默认）') + '</option>';
        for (var m3 = 0; m3 < slotModels.length; m3++) {
          var mid = slotModels[m3];
          mopts += '<option value="' + esc(mid) + '"' +
            (bound.model === mid ? ' selected' : '') + '>' +
            esc(mid) + (DB.isFreeModel(mid) ? ' · 免费' : ' · 付费') + '</option>';
        }

        // 硅基流动的 Qwen3-ASR 挂在模型列表里，但 /audio/transcriptions 不认它
        // （实测报 20012 Model does not exist）。光看下拉是发现不了这件事的，
        // 所以直接把警告和"一键换掉"摆在当前模型旁边。
        var asrWarn = '';
        if (sl.k === 'asr' && bound.model && /qwen3-asr|omni/i.test(bound.model)) {
          asrWarn = '<small class="slot-warn" style="display:block;color:#c0392b;margin-top:4px">' +
            '这个模型在转写接口上会报「Model does not exist」' +
            '<button class="btn tiny" data-asr-fix="' + esc(String(bound.profile_id || '')) + '">' +
            '改用 SenseVoice（免费）</button></small>';
        }

        html += '<div class="slot-row" data-slot="' + sl.k + '">' +
          '<div class="slot-label"><b>' + esc(sl.label) + '</b>' +
          // 正在用什么模型，直接摆在明面上，不用去下拉里翻
          (bound.model
            ? '<small class="slot-now">当前：<code>' + esc(bound.model) + '</code>' +
              (DB.isFreeModel(bound.model) ? '（免费）' : '（<b>付费</b>）') + '</small>'
            : '') +
          '<small>' + esc(sl.hint) + '</small>' + asrWarn + '</div>' +
          '<select class="slot-pick">' + opts + '</select>' +
          '<select class="slot-model">' + mopts + '</select>' +
          (sl.k === 'title' || sl.k === 'vision' || sl.k === 'asr'
            ? '<button class="btn tiny" data-slot-test="' + sl.k + '">试一下</button>'
            : '') +
          '</div>';
      }

      /* ---- 阅读 ---- */
      html += '<h2 class="set-h">阅读</h2>' +
        '<div class="pref-row"><span>字号</span>' +
        '<input type="range" id="prefFont" min="15" max="30" step="1" value="' +
        esc(cfg['pref.font'] || '18') + '">' +
        '<b id="prefFontVal">' + esc(cfg['pref.font'] || '18') + '</b></div>' +

        '<div class="pref-row"><span>夜间模式</span>' +
        '<input type="checkbox" id="prefNight" class="switch"' +
        (cfg['pref.night'] === '1' ? ' checked' : '') + '>' +
        '<span class="muted">黑底米字，晚上看不刺眼</span></div>' +

        '<div class="pref-row"><span>朗读语速</span>' +
        '<input type="range" id="prefRate" min="6" max="14" step="1" value="' +
        esc(Math.round((Number(cfg['pref.rate']) || 0.95) * 10)) + '">' +
        '<b id="prefRateVal">' + (Number(cfg['pref.rate']) || 0.95).toFixed(1) + '×</b></div>' +

        /* ---- 朗读音色与配乐 ---- */
        '<h2 class="set-h">朗读音色与配乐</h2>' +
        '<p class="hint">系统音色离线可用、不花钱；云端音色更好听，但要给「朗读」环节绑一个模型，' +
        '而且每段文字只会合成一次（同一句再读不再计费）。</p>' +
        '<div class="pref-row"><span>音色来源</span>' +
        '<select class="fi" id="prefTtsMode" style="max-width:150px">' +
        '<option value="system"' + (window.TTS && !window.TTS.cloud() ? ' selected' : '') + '>系统（离线）</option>' +
        '<option value="cloud"' + (window.TTS && window.TTS.cloud() ? ' selected' : '') + '>云端（需配模型）</option>' +
        '</select><span class="muted">' + (window.TTS && window.TTS.native ? '手机上固定用系统音色' : '') + '</span></div>' +
        '<div class="pref-row"><span>背景配乐</span>' +
        '<select class="fi" id="prefBgm" style="max-width:150px">' +
        (function () {
          var list = (window.Mixer && window.Mixer.presets()) || [{ k: 'none', n: '不配乐' }];
          var cur = window.Mixer ? window.Mixer.current() : 'none';
          var o = '';
          for (var i = 0; i < list.length; i++) {
            o += '<option value="' + esc(list[i].k) + '"' + (list[i].k === cur ? ' selected' : '') + '>' +
              esc(list[i].n) + '</option>';
          }
          return o;
        })() + '</select>' +
        '<span class="muted">朗读时才响，会把音量自动压下去</span></div>' +
        '<div class="pref-row"><span>配乐音量</span>' +
        '<input type="range" id="prefBgmVol" min="0" max="100" step="5" value="' +
        Math.round(((window.Mixer ? window.Mixer.restore().volume : 0.34)) * 100) + '">' +
        '<b id="prefBgmVolVal">' + Math.round((window.Mixer ? window.Mixer.restore().volume : 0.34) * 100) + '</b></div>' +
        '<p class="hint dim">配乐是程序实时算出来的氛围垫（六种），不是唱片：不占体积、不涉版权、断网也响。</p>';

      /* ---- 用量与任务 ---- */
      html += '<h2 class="set-h">用量与任务</h2>' +
        '<div class="usage-box" id="usageBox"><div class="usage-row"><b>正在统计……</b></div></div>' +
        '<p class="hint dim">只统计你主动调过 AI 的次数与模型，不含任何内容。' +
        '本地规则生成的章节名不计入。</p>' +
        '<div class="pref-row"><button class="btn tiny" id="jobTest">跑一次自检</button>' +
        '<span class="muted">排一个后台任务，看进度能不能正常跑完</span></div>' +
        '<div class="job-bar" id="jobBar" hidden><i></i><span>排队中</span></div>';

      /* ---- 关于 ---- */
      var myPhone = '';
      try { myPhone = localStorage.getItem('mylife.phone') || ''; } catch (e2) {}
      html += '<h2 class="set-h">关于</h2>' +
        '<p class="hint">我的人生档案 · The Story of My Life <b>' + esc(APP_VERSION) + '</b><br>' +
        '数据全部存在这台设备上，不会上传到任何地方。<br>' +
        '只有你自己配了模型，生成时才会把章节标题发出去；照片只有在你点「看照片」时才会发。</p>' +
        (myPhone
          ? '<div class="pref-row"><span>当前账号</span><b>' + esc(myPhone) + '</b>' +
            '<button class="btn tiny" id="logoutBtn">退出登录</button></div>'
          : '') +
        '<div class="pref-row"><button class="btn tiny" id="dbDiag">数据自检</button>' +
        '<span class="muted">保存了却看不到数据时点这个，把弹出的信息截图发我</span></div>' +
        '<pre id="dbDiagOut" style="display:none;font-size:11px;white-space:pre-wrap;background:var(--card);padding:10px;border-radius:8px"></pre>' +
        '<div class="pref-row"><button class="btn tiny" id="micDiag">麦克风诊断</button>' +
        '<span class="muted">录音打不开、或者录出来没声音时点这个</span></div>' +
        '<pre id="micDiagOut" style="display:none;font-size:11px;white-space:pre-wrap;background:var(--card);padding:10px;border-radius:8px"></pre>';

      html += '</main>';
      app.innerHTML = html;

      var accChPw = document.getElementById('accChPw');
      if (accChPw) accChPw.onclick = function () { ML.openChangePassword(); };
      var accSec = document.getElementById('accSec');
      if (accSec) accSec.onclick = function () { ML.openSetSecurity(); };

      bindSettings(profiles, slotMap);
    }).catch(fail);
  }

  /** 用量统计 + 任务队列的自检按钮（也是 jobs 前端的验收用例） */
  function bindUsage() {
    var box = document.getElementById('usageBox');
    if (box) {
      API.usage(30).then(function (u) {
        var rows = '';
        var list = (u && u.byCapability) || [];
        var NAMES = { text: '文字', asr: '转写', image: '插图', tts: '朗读', music: '音乐', video: '视频' };
        if (!list.length) {
          rows = '<div class="usage-row"><b>最近 30 天还没有调用过模型</b></div>';
        } else {
          for (var i = 0; i < list.length; i++) {
            var c = list[i];
            rows += '<div class="usage-row"><b>' + esc(NAMES[c.capability] || c.capability) + '</b>' +
              '<span>' + Number(c.calls || 0) + ' 次' +
              (Number(c.units) ? ' · ' + Math.round(Number(c.units)) + ' 单位' : '') +
              (Number(c.cost) ? ' · ¥' + Number(c.cost).toFixed(2) : '') + '</span></div>';
          }
        }
        rows += '<div class="usage-row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px">' +
          '<b>合计</b><span>' + Number(u && u.calls || 0) + ' 次</span></div>';
        box.innerHTML = rows;
      }, function () {
        box.innerHTML = '<div class="usage-row"><b>这个版本读不到用量记录</b></div>';
      });
    }

    var btn = document.getElementById('jobTest');
    if (!btn) return;
    btn.onclick = function () {
      var bar = document.getElementById('jobBar');
      var fill = bar.querySelector('i');
      var label = bar.querySelector('span');
      bar.hidden = false;
      fill.style.width = '0%';
      label.textContent = '排队中';
      btn.disabled = true;

      API.job.create('selftest', { steps: 8, ms: 140 }).then(function (r) {
        var timer = setInterval(function () {
          API.job.get(r.id).then(function (g) {
            var j = g && g.job;
            if (!j) return;
            fill.style.width = Math.round((j.progress || 0) * 100) + '%';
            label.textContent = (j.stage || '') + (j.status === 'done' ? ' · 完成' : '');
            if (j.status === 'done' || j.status === 'failed' || j.status === 'canceled') {
              clearInterval(timer);
              btn.disabled = false;
              if (j.status === 'failed') label.textContent = '失败：' + j.error;
              if (j.status === 'canceled') label.textContent = '已取消';
            }
          }, function () { clearInterval(timer); btn.disabled = false; });
        }, 400);
      }).catch(function (e) {
        btn.disabled = false;
        label.textContent = '这个版本还没有任务队列（' + (e.message || e) + '）';
      });
    };
  }

  function bindSettings(profiles, slotMap) {
    bindUsage();
    /* --- 添加 / 编辑 --- */
    var addBtn = document.getElementById('addProfile');
    if (addBtn) addBtn.onclick = function () {
      editing = null;
      showProfileForm({ kind: 'openai', base_url: KINDS[0].base, enabled: 1 });
    };

    if (settingsClickHandler) document.removeEventListener('click', settingsClickHandler);
    settingsClickHandler = function (ev) {
      var t;

      if ((t = ev.target.closest('[data-edit]'))) {
        var id = Number(t.getAttribute('data-edit'));
        for (var i = 0; i < profiles.length; i++) {
          // 比字符串：安卓端读出来的 id 曾是字符串，用 === 比数字永远不中，
          // 表现就是「点改没反应」
          if (String(profiles[i].id) === String(id)) {
            editing = profiles[i];
            showProfileForm(profiles[i]);
            return;
          }
        }
        toast('没找到这条配置，刷新一下再试');
        return;
      }

      if ((t = ev.target.closest('[data-del]'))) {
        var did = Number(t.getAttribute('data-del'));
        if (!confirm('删掉这条配置？绑定了它的环节会自动清空。')) return;
        DB.deleteProfile(did).then(function () {
          toast('已删除');
          renderSettings();
        }).catch(fail);
        return;
      }

      if ((t = ev.target.closest('[data-toggle]'))) {
        var tid = Number(t.getAttribute('data-toggle'));
        var to = Number(t.getAttribute('data-to')) === 1;
        DB.toggleProfile(tid, to).then(function () {
          renderSettings();
        }).catch(fail);
        return;
      }

      if ((t = ev.target.closest('[data-test]'))) {
        var pid = Number(t.getAttribute('data-test'));
        // 本机模型一点测试就真的进内存，没独显的机器会卡很久，先说清楚
        if (t.getAttribute('data-local') === '1') {
          if (!confirm('这条是跑在本机的模型。\n点「确定」会让它加载进内存（7B 约 5–6GB），\n没有独立显卡时单次要 20–60 秒，机器会明显变卡。\n\n继续测试吗？')) return;
        }
        t.disabled = true;
        t.textContent = '测试中';
        DB.testProfile(pid).then(function (r) {
          if (r.ok) {
            var sec = (r.ms / 1000).toFixed(1) + 's';
            if (r.thinking) toast(r.model + ' · ' + sec + ' · 已响应（推理型）');
            else toast(r.model + ' · ' + sec + ' · 「' + (r.reply || '') + '」');
          } else {
            toast(r.message || '不通');
          }
          t.disabled = false;
          t.textContent = '测试';
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '测试'; });
        return;
      }

      if ((t = ev.target.closest('[data-pull]'))) {
        var lid = Number(t.getAttribute('data-pull'));
        t.disabled = true;
        t.textContent = '拉取中';
        DB.pullModels(lid).then(function (r) {
          if (r.ok) {
            // 拉完顺手把空着的环节配好——有了 Key 就不用再选
            DB.autoSetupSlots(lid).then(function (done) {
              if (done.length) {
                toast('拉到 ' + r.count + ' 个模型，并已自动配好 ' + done.length + ' 个环节');
              } else {
                toast('拉到 ' + r.count + ' 个模型');
              }
              renderSettings();
            });
          } else {
            toast(r.message || '拉不到');
            t.disabled = false;
            t.textContent = '拉模型';
          }
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '拉模型'; });
        return;
      }

      if ((t = ev.target.closest('[data-asr-fix]'))) {
        var fpid = Number(t.getAttribute('data-asr-fix')) || null;
        t.disabled = true;
        t.textContent = '正在换…';
        DB.listProfiles().then(function (ps) {
          var want = 'FunAudioLLM/SenseVoiceSmall';
          for (var i = 0; i < ps.length; i++) {
            if (fpid && String(ps[i].id) !== String(fpid)) continue;
            var ml = [];
            try { ml = JSON.parse(ps[i].models_json || '[]'); } catch (e) {}
            for (var j = 0; j < ml.length; j++) {
              if (/sensevoice/i.test(ml[j])) { want = ml[j]; break; }
            }
          }
          return DB.setSlot('asr', fpid, want).then(function () { return want; });
        }).then(function (w) {
          toast('已改用 ' + w);
          renderSettings();
        }).catch(function (e) {
          fail(e); t.disabled = false; t.textContent = '改用 SenseVoice（免费）';
        });
        return;
      }

      if ((t = ev.target.closest('[data-slot-test]'))) {
        var sk = t.getAttribute('data-slot-test');
        t.disabled = true;
        t.textContent = '试跑中';
        DB.testSlot(sk).then(function (r) {
          if (r.ok) {
            var sec2 = (r.ms / 1000).toFixed(1) + 's';
            toast(r.model + ' · ' + sec2 + (r.thinking ? ' · 已响应（推理型）' : ' · 通了'));
          } else {
            toast(r.message || '没配好');
          }
          t.disabled = false;
          t.textContent = '试一下';
        }).catch(function (e) { fail(e); t.disabled = false; t.textContent = '试一下'; });
        return;
      }
    };
    document.addEventListener('click', settingsClickHandler);

    /* --- 用途绑定：换配置、换模型都会立即落库 --- */
    var rows = document.querySelectorAll('.slot-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var sel = row.querySelector('.slot-pick');
        var msel = row.querySelector('.slot-model');
        function slot() { return row.getAttribute('data-slot'); }

        sel.onchange = function () {
          var pid = sel.value ? Number(sel.value) : null;
          DB.setSlot(slot(), pid, null).then(function () {
            toast(pid ? '已绑定' : '已改为按规则');
            renderSettings();   // 重画：模型下拉要跟着换一家重列
          }).catch(fail);
        };
        msel.onchange = function () {
          var pid = sel.value ? Number(sel.value) : null;
          DB.setSlot(slot(), pid, msel.value || null).then(function () {
            toast(msel.value ? '已改用 ' + msel.value : '已恢复自动');
          }).catch(fail);
        };
      })(rows[i]);
    }

    /* --- 阅读偏好 --- */
    var font = document.getElementById('prefFont');
    var fontVal = document.getElementById('prefFontVal');
    if (font) {
      font.oninput = function () {
        fontVal.textContent = font.value;
      };
      font.onchange = function () {
        DB.setPref('font', font.value).then(function () { toast('字号已保存'); }).catch(fail);
      };
    }

    var night = document.getElementById('prefNight');

    var dbDiag = document.getElementById('dbDiag');
    if (dbDiag) dbDiag.onclick = function () {
      var out = document.getElementById('dbDiagOut');
      out.style.display = 'block';
      out.textContent = '正在读取……';
      API.auth.debugData().then(function (r) {
        out.textContent = JSON.stringify(r, null, 2);
      }).catch(function (e) {
        out.textContent = '自检失败：' + e.message;
      });
    };

    var micDiag = document.getElementById('micDiag');
    if (micDiag) micDiag.onclick = function () {
      var out = document.getElementById('micDiagOut');
      out.style.display = 'block';
      out.textContent = '正在检查……';
      if (window.NativeRec && window.NativeRec.info) {
        try { out.textContent = JSON.stringify(JSON.parse(window.NativeRec.info()), null, 2); }
        catch (e) { out.textContent = '原生信息读不出来：' + e.message; }
        return;
      }
      // 浏览器：把 mediaDevices 能看到的东西都列出来
      var o = { native: false, hasMediaDevices: !!(navigator.mediaDevices),
        hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        hasMediaRecorder: typeof MediaRecorder !== 'undefined',
        hasAudioContext: !!(window.AudioContext || window.webkitAudioContext),
        secure: location.protocol + '//' + location.host, isSecureContext: !!window.isSecureContext };
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        out.textContent = JSON.stringify(o, null, 2); return;
      }
      navigator.mediaDevices.enumerateDevices().then(function (ds) {
        o.devices = ds.map(function (d) { return d.kind + ' | ' + (d.label || '(无名字)') + ' | ' + d.deviceId; });
        out.textContent = JSON.stringify(o, null, 2);
      }).catch(function (e) {
        o.err = e.name + ': ' + e.message;
        out.textContent = JSON.stringify(o, null, 2);
      });
    };

    var logoutBtn = document.getElementById('logoutBtn');    if (logoutBtn) logoutBtn.onclick = function () {
      if (!confirm('退出登录？退出后要重新登录才能看到档案。')) return;
      API.auth.logout().catch(function () {});
      API.auth.setToken('');
      try { localStorage.removeItem('mylife.phone'); } catch (e) {}
      go('#/login');
    };
    if (night) night.onchange = function () {
      DB.setPref('night', night.checked ? 1 : 0).then(function () {
        applyPrefs();
      }).catch(fail);
    };

    var ttsMode = document.getElementById('prefTtsMode');
    if (ttsMode) ttsMode.onchange = function () {
      try { localStorage.setItem('ms_tts_mode', ttsMode.value); } catch (e) {}
      toast(ttsMode.value === 'cloud' ? '下次朗读用云端音色（没配模型会自动退回）' : '已切回系统音色');
    };
    var bgmSel = document.getElementById('prefBgm');
    if (bgmSel) bgmSel.onchange = function () {
      if (window.Mixer) window.Mixer.setPreset(bgmSel.value);
      toast(bgmSel.value === 'none' ? '已关闭配乐' : '配乐已切换，朗读时生效');
    };
    var bgmVol = document.getElementById('prefBgmVol');
    var bgmVolVal = document.getElementById('prefBgmVolVal');
    if (bgmVol) {
      bgmVol.oninput = function () {
        bgmVolVal.textContent = bgmVol.value;
        if (window.Mixer) window.Mixer.setVolume(Number(bgmVol.value) / 100);
      };
    }

    var rate = document.getElementById('prefRate');
    var rateVal = document.getElementById('prefRateVal');
    if (rate) {
      rate.oninput = function () {
        rateVal.textContent = (Number(rate.value) / 10).toFixed(1) + '×';
      };
      rate.onchange = function () {
        DB.setPref('rate', Number(rate.value) / 10).then(function () { toast('语速已保存'); }).catch(fail);
      };
    }
  }

  function showProfileForm(pf) {
    var box = document.getElementById('profileForm');
    if (!box) return;

    var isEdit = !!pf.id;
    var kindOpts = '';
    for (var i = 0; i < KINDS.length; i++) {
      kindOpts += '<option value="' + KINDS[i].k + '"' +
        ((pf.kind || 'openai') === KINDS[i].k ? ' selected' : '') + '>' + KINDS[i].label + '</option>';
    }

    var models = [];
    try { models = JSON.parse(pf.models_json || '[]'); } catch (e) { models = []; }
    var modelOpts = '<option value="">— 手填或先拉取 —</option>';
    for (var m = 0; m < models.length; m++) {
      modelOpts += '<option value="' + esc(models[m]) + '"' +
        (pf.default_model === models[m] ? ' selected' : '') + '>' + esc(models[m]) + '</option>';
    }

    box.innerHTML = '<div class="ai-form">' +
      '<div class="ai-form-title">' + (isEdit ? '改这条配置' : '新增一条配置') + '</div>' +
      '<p class="hint">一共就填四样：叫什么、接口地址、密钥、用哪个模型。改完点保存。</p>' +

      '<div class="fld"><label>名称</label>' +
      '<input id="pfName" value="' + esc(pf.name || '') + '" placeholder="比如：硅基流动 / 家里电脑的 Ollama">' +
      '<small>随便起，自己认得就行。</small></div>' +

      '<div class="fld"><label>类型</label>' +
      '<select id="pfKind">' + kindOpts + '</select>' +
      '<small>选一个会自动填好下面的接口地址，也可以自己改。</small></div>' +

      '<div class="fld"><label>接口地址（base_url）</label>' +
      '<input id="pfBase" value="' + esc(pf.base_url || '') + '" placeholder="https://api.siliconflow.cn/v1">' +
      '<small>服务商给的网址，一般到 <code>/v1</code> 为止，别带后面的 <code>/chat/completions</code>。</small></div>' +

      '<div class="fld"><label>密钥（API Key）</label>' +
      '<input id="pfKey" type="password" value="" placeholder="' +
      (isEdit && pf.api_key ? '已保存，留空表示不改' : 'sk-...') + '">' +
      '<small>在服务商后台「API 密钥」页面生成。只存在这台设备上，不会传出去。' +
      '跑在自己电脑上的 Ollama 不需要，留空即可。</small></div>' +

      '<div class="fld"><label>用哪个模型（模型 ID）</label>' +
      '<select id="pfModelSel">' + modelOpts + '</select>' +
      '<small>点上面的「拉模型」会把这家能用的模型全拉回来，在这里挑。' +
      (models.length ? '现在是 ' + models.length + ' 个可选。' : '') + '</small></div>' +

      '<div class="fld"><label>或者手填模型名</label>' +
      '<input id="pfModel" value="' + esc(pf.default_model || '') + '" placeholder="deepseek-chat">' +
      '<small>要和服务商写的<b>一模一样</b>，多了少了都调不通。' +
      '免费档常用：<code>tencent/Hunyuan-MT-7B</code>、<code>deepseek-ai/DeepSeek-OCR</code>、' +
      '<code>Qwen/Qwen3-ASR-1.7B</code></small></div>' +

      '<div class="row end">' +
      '<button class="btn tiny ghost" id="pfCancel">取消</button>' +
      '<button class="btn primary" id="pfSave">保存</button></div>' +
      '</div>';

    var kindSel = document.getElementById('pfKind');
    kindSel.onchange = function () {
      for (var i = 0; i < KINDS.length; i++) {
        if (KINDS[i].k === kindSel.value && KINDS[i].base) {
          document.getElementById('pfBase').value = KINDS[i].base;
        }
      }
    };

    var modelSel = document.getElementById('pfModelSel');
    modelSel.onchange = function () {
      if (modelSel.value) document.getElementById('pfModel').value = modelSel.value;
    };

    document.getElementById('pfCancel').onclick = function () { box.innerHTML = ''; };

    document.getElementById('pfSave').onclick = function () {
      var btn = this;
      btn.disabled = true;
      var keyVal = document.getElementById('pfKey').value;
      var payload = {
        id: pf.id || null,
        name: document.getElementById('pfName').value,
        kind: kindSel.value,
        base_url: document.getElementById('pfBase').value,
        api_key: keyVal ? keyVal : (pf.api_key || null),
        default_model: document.getElementById('pfModel').value.trim() || null,
        enabled: 1
      };
      DB.saveProfile(payload).then(function (r) {
        box.innerHTML = '';
        var newId = payload.id || (r && r.lastId);
        // 保存完顺手拉一次模型清单、把空着的环节配好——
        // 用户填一个 Key 点保存，就什么都不用再弄了
        if (newId) {
          toast('已保存，正在读模型清单…');
          DB.pullModels(newId).then(function (pr) {
            if (!pr.ok) { toast('已保存，但拉不到模型：' + (pr.message || '')); return renderSettings(); }
            return DB.autoSetupSlots(newId).then(function (done) {
              toast(done.length ? '已保存，并自动配好 ' + done.length + ' 个环节' : '已保存');
              renderSettings();
            });
          }).catch(function () { renderSettings(); });
        } else {
          toast('已保存');
          renderSettings();
        }
      }).catch(function (e) { fail(e); btn.disabled = false; });
    };

    box.scrollIntoView({ block: 'center' });
  }

  /** 阅读偏好落到 body，档案页的字号和夜间都靠它 */
  function applyPrefs() {
    DB.getPref('font', '18').then(function (f) {
      document.documentElement.style.setProperty('--fs', f + 'px');
      return DB.getPref('night', '0');
    }).then(function (n) {
      if (n === '1') document.body.className = 'night';
      else document.body.className = '';
    }).catch(function () {});
  }

  /* ---------------- 路由 ---------------- */

  /** 登录 / 注册 / 找回密码。v0.3 起先登录再用；验证码演示版固定 1234 */
  function renderLogin() {
    var mode = 'login';   // login | register | recover

    function box(inner) {
      return topbar() + '<main class="wrap auth-wrap"><div class="auth-box">' +
        '<h1 class="h1" style="text-align:center">我的人生档案</h1>' +
        '<p class="muted" style="text-align:center" id="auSub">登录后开始使用</p>' + inner +
        '<p class="muted" id="auMsg" style="text-align:center;min-height:18px;color:var(--danger)"></p>' +
        '</div></main>';
    }

    function render() {
      var inner;
      if (mode === 'recover') {
        inner =
          '<div class="fld"><label>手机号</label><input id="auPhone" type="tel" maxlength="11" placeholder="11 位手机号"></div>' +
          '<div class="fld" id="recQRow" hidden><label>密保问题</label><input id="auQ" disabled></div>' +
          '<div class="fld" id="recARow" hidden><label>密保答案</label><input id="auA" placeholder="输入你的答案"></div>' +
          '<div class="fld" id="recPRow" hidden><label>新密码（至少 6 位）</label><input id="auPass" type="password"></div>' +
          '<button class="btn primary" id="auGo" style="width:100%;margin-top:6px">下一步</button>' +
          '<p class="muted" style="text-align:center;margin-top:12px">' +
          '<a href="javascript:void 0" id="auBack" style="color:var(--accent)">返回登录</a></p>';
      } else {
        inner =
          '<div class="fld"><label>手机号</label><input id="auPhone" type="tel" maxlength="11" placeholder="11 位手机号"></div>' +
          '<div class="fld"><label>密码</label><input id="auPass" type="password" placeholder="至少 6 位"></div>' +
          '<div class="fld" id="auNickRow"' + (mode === 'register' ? '' : ' hidden') + '><label>昵称（选填）</label><input id="auNick" placeholder="怎么称呼你"></div>' +
          '<div class="fld" id="auCodeRow"' + (mode === 'register' ? '' : ' hidden') + '><label>短信验证码</label><div style="display:flex;gap:8px"><input id="auCode" maxlength="6" placeholder="演示版固定 1234" style="flex:1"><button class="btn" id="auSms" type="button">发验证码</button></div></div>' +
          '<div class="fld" id="auSecQRow"' + (mode === 'register' ? '' : ' hidden') + '><label>密保问题（选填，用于找回密码）</label><input id="auSecQ" placeholder="例如：我小学班主任姓什么"></div>' +
          '<div class="fld" id="auSecARow"' + (mode === 'register' ? '' : ' hidden') + '><label>密保答案</label><input id="auSecA" placeholder="例如：王"></div>' +
          '<button class="btn primary" id="auGo" style="width:100%;margin-top:6px">' + (mode === 'register' ? '注册并进入' : '登录') + '</button>' +
          '<p class="muted" style="text-align:center;margin-top:12px">' +
          '<a href="javascript:void 0" id="auToggle" style="color:var(--accent)">' + (mode === 'register' ? '已有账号？去登录' : '没有账号？注册一个') + '</a>' +
          (mode === 'register' ? '' : ' · <a href="javascript:void 0" id="auForget" style="color:var(--accent)">忘记密码？</a>') +
          '</p>';
      }
      app.innerHTML = box(inner);
      bind();
    }

    function msg(t) { var el = document.getElementById('auMsg'); if (el) el.textContent = t || ''; }
    function isReg() { return mode === 'register'; }

    function bind() {
      var goBtn = document.getElementById('auGo');
      var sub = document.getElementById('auSub');

      if (mode === 'recover') {
        if (sub) sub.textContent = '用密保问题找回密码';
        goBtn.textContent = '下一步';
        goBtn.onclick = function () {
          var phone = document.getElementById('auPhone').value.trim();
          API.auth.recoverQuestion(phone).then(function (r) {
            document.getElementById('recQRow').hidden = false;
            document.getElementById('recARow').hidden = false;
            document.getElementById('recPRow').hidden = false;
            document.getElementById('auQ').value = r.question || '';
            goBtn.textContent = '重置密码';
            goBtn.onclick = function () { doRecover(phone); };
          }).catch(function (e) { msg(e.message); });
        };
        var back = document.getElementById('auBack');
        if (back) back.onclick = function () { mode = 'login'; render(); };
        return;
      }

      if (sub) sub.textContent = isReg() ? '注册一个新账号' : '登录后开始使用';
      goBtn.textContent = isReg() ? '注册并进入' : '登录';
      var toggle = document.getElementById('auToggle');
      if (toggle) toggle.onclick = function () { mode = isReg() ? 'login' : 'register'; render(); };
      var forget = document.getElementById('auForget');
      if (forget) forget.onclick = function () { mode = 'recover'; render(); };
      var sms = document.getElementById('auSms');
      if (sms) sms.onclick = function () {
        var phone = document.getElementById('auPhone').value.trim();
        API.auth.sms(phone).then(function (r) { msg(''); toast(r.message || '验证码已发送'); })
          .catch(function (e) { msg(e.message); });
      };
      goBtn.onclick = function () {
        var btn = this;
        var phone = document.getElementById('auPhone').value.trim();
        var pass = document.getElementById('auPass').value;
        btn.disabled = true;
        var p;
        if (isReg()) {
          var secQ = document.getElementById('auSecQ').value.trim();
          var secA = document.getElementById('auSecA').value.trim();
          p = API.auth.register(phone, pass, document.getElementById('auCode').value.trim(),
            document.getElementById('auNick').value.trim());
          p = p.then(function (r) {
            if (secQ && secA) {
              return API.auth.setSecurity(secQ, secA).catch(function () { return r; }).then(function () { return r; });
            }
            return r;
          });
        } else {
          p = API.auth.login(phone, pass);
        }
        p.then(done).catch(function (e) { msg(e.message); btn.disabled = false; });
      };
      var passEl = document.getElementById('auPass');
      if (passEl) passEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') goBtn.click();
      });
    }

    function doRecover(phone) {
      var answer = document.getElementById('auA').value.trim();
      var newP = document.getElementById('auPass').value;
      if (!answer) { msg('请填写密保答案'); return; }
      if (!newP || newP.length < 6) { msg('新密码至少 6 位'); return; }
      API.auth.recover(phone, answer, newP).then(function () {
        toast('密码已重置，请用新密码登录');
        mode = 'login'; render();
      }).catch(function (e) { msg(e.message); });
    }

    function done(r) {
      API.auth.setToken(r.token);
      try { localStorage.setItem('mylife.phone', r.phone || ''); } catch (e) {}
      toast(r.message || '欢迎回来');
      go('#/');
    }

    render();
  }

  function route() {
    var h = location.hash || '#/';
    // 登录页带 token 直通：自动化测试与外部工具用，token 本就由持有者掌握
    var tk = h.match(/[?&]token=([A-Za-z0-9]+)/);
    if (tk) {
      API.auth.setToken(tk[1]);
      go(h.replace(/[?&]token=[A-Za-z0-9]+/, '') || '#/');
      return;
    }
    if (h === '#/login') return renderLogin();
    var m;

    if ((m = /^#\/a\/(\d+)\/ch\/(\d+)/.exec(h))) return renderChapterPage(m[1], m[2]);
    if ((m = /^#\/a\/(\d+)\/collect/.exec(h))) return renderCollect(m[1]);
    if ((m = /^#\/a\/(\d+)\/timeline/.exec(h))) return renderTimeline(m[1]);
    if ((m = /^#\/a\/(\d+)\/chat/.exec(h))) return renderChat(m[1]);
    if ((m = /^#\/a\/(\d+)\/song/.exec(h))) return renderSong(m[1]);
    if ((m = /^#\/a\/(\d+)\/script/.exec(h))) return renderScript(m[1]);
    if ((m = /^#\/a\/(\d+)\/art/.exec(h))) return renderArt(m[1]);
    if ((m = /^#\/a\/(\d+)\/comic/.exec(h))) return renderComic(m[1]);
    if ((m = /^#\/a\/(\d+)\/movie/.exec(h))) return renderMovie(m[1]);
    if ((m = /^#\/a\/(\d+)/.exec(h))) return renderArchive(m[1]);
    if (h === '#/chat') return renderChat(null);
    if (h === '#/users') return renderUsers();
    if (h.indexOf('#/settings') === 0) return renderSettings();
    return renderHome();
  }

  function renderTimeline(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在排时间轴……</div></main>';
    window.TimelineUI.render(app, Number(id));
  }

  function renderMovie(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在架机位……</div></main>';
    window.MovieUI.render(app, Number(id));
  }

  function renderComic(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在裁纸……</div></main>';
    window.ComicUI.render(app, Number(id));
  }

  function renderArt(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在铺纸……</div></main>';
    window.ArtUI.render(app, Number(id));
  }

  function renderScript(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在排场次……</div></main>';
    window.ScriptUI.render(app, Number(id));
  }

  function renderSong(id) {
    app.innerHTML = topbar({ back: '#/a/' + id }) +
      '<main class="wrap"><div class="boot">正在铺纸研墨……</div></main>';
    window.SongUI.render(app, Number(id));
  }

  function renderChat(id) {
    var aid = id ? Number(id) : null;
    app.innerHTML = topbar({ back: aid ? '#/a/' + aid : '#/' }) +
      '<main class="wrap"><div class="boot">正在打开助手……</div></main>';
    window.ChatUI.render(app, aid);
  }

  window.addEventListener('hashchange', function () {
    // 换页时把抽屉收掉：抽屉挂在 body 上，不清就会跟着下一个页面一起显示
    var sheets = document.querySelectorAll('.sheet-back');
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].parentNode) sheets[i].parentNode.removeChild(sheets[i]);
    }
    window.scrollTo(0, 0);
    route();
  });

  /* ---------------- v0.5：封面 / 时间轴 / 导出 / 助手的统一入口 ---------------- */

  function bindToolsOnce() {
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;

      var cv = t.closest('[data-cover-open]');
      if (cv) {
        var aid = Number(cv.getAttribute('data-aid'));
        window.CoverUI.open(aid, function () { route(); });
        return;
      }
      var gt = t.closest('[data-goto]');
      if (gt) {
        var id2 = Number(gt.getAttribute('data-aid'));
        go('#/a/' + id2 + '/' + gt.getAttribute('data-goto'));
        return;
      }
      var pw = t.closest('[data-polish]');
      if (pw) {
        window.PolishUI.open(Number(pw.getAttribute('data-polish')), function () { route(); });
        return;
      }
      var ex = t.closest('[data-export-open]');
      if (ex) {
        openExportSheet(Number(ex.getAttribute('data-aid')));
      }
    });
  }

  /**
   * 看整本：不再直接跳回目录。给三个真正常用的去处——
   *   ① 回目录页逐章看  ② 直接进导出（Word/PDF/PPT）  ③ 生成一份带目录的整本网页
   */
  function openWholeBook(archiveId) {
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal book-modal"><h3>看整本</h3>' +
      '<p class="hint dim">整本有三种看法，选一个：</p>' +
      '<button class="ex-card" data-wb="toc"><b>回目录页</b>' +
      '<small>一章一行，点进去读那一章；改、听、配图都在章节页</small></button>' +
      '<button class="ex-card" data-wb="export"><b>去导出</b>' +
      '<small>先预览成书排版，再出 Word / PDF / PPT 或打印</small></button>' +
      '<button class="ex-card" data-wb="html"><b>生成整本网页</b>' +
      '<small>带封面、目录和全部正文，新窗口打开，可滚动通读、可打印、可另存</small></button>' +
      '<div class="ml-modal-acts"><button class="btn" data-wb="cancel">取消</button></div>' +
      '<div class="ml-modal-msg" id="wbMsg"></div></div>';
    document.body.appendChild(ov);

    var msg = ov.querySelector('#wbMsg');
    var busy = false;

    ov.addEventListener('click', function (ev) {
      if (ev.target === ov) { ov.parentNode.removeChild(ov); return; }
      var b = ev.target.closest && ev.target.closest('[data-wb]');
      if (!b || busy) return;
      var kind = b.getAttribute('data-wb');
      if (kind === 'cancel') { ov.parentNode.removeChild(ov); return; }

      if (kind === 'toc') {
        ov.parentNode.removeChild(ov);
        go('#/a/' + archiveId);
        return;
      }
      if (kind === 'export') {
        ov.parentNode.removeChild(ov);
        openExportSheet(archiveId);
        return;
      }

      // 生成整本网页
      busy = true;
      msg.textContent = '正在把全文和图片装进一页……';
      window.Exporter.model(archiveId).then(function (m) {
        return window.Exporter.inlineImages(m, 160).then(function (inl) {
          var full = window.Exporter.html(m, { size: 'a5', theme: 'paper', images: inl.map });
          var w = null;
          try { w = window.open('', '_blank'); } catch (e) { w = null; }
          if (w && w.document) {
            w.document.open();
            w.document.write(full);
            w.document.close();
            msg.textContent = '已在新窗口打开：' + m.meta.chapters + ' 章 · ' +
              m.meta.words + ' 字 · ' + m.meta.photos + ' 张照片。可用 Ctrl+P 打印或另存。';
          } else {
            // 手机上弹窗常被拦：落一份文件 + 触发下载
            var blob = new Blob([full], { type: 'text/html;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = (m.meta.title || '整本档案') + '.html';
            link.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
            var fr = new FileReader();
            fr.onload = function () {
              var s = String(fr.result || '');
              API.file({ op: 'save', dir: 'exports', name: (m.meta.title || '整本档案') + '.html',
                base64: s.slice(s.indexOf(',') + 1) }).then(function () {
                msg.textContent = '弹窗被拦，已导出整本网页：文件在 exports/ 里，点浏览器下载也能拿到。';
              }, function () {
                msg.textContent = '弹窗被拦，已触发下载（看浏览器下载列表）。';
              });
            };
            fr.readAsDataURL(blob);
          }
          busy = false;
        });
      }).catch(function (e) {
        busy = false;
        msg.textContent = '没生成成功：' + (e.message || e);
      });
    });
  }

  /** 导出抽屉：打印版 / PDF / Word / PPT，一次说清各要多久、靠什么 */
  /**
   * 成书预览：先把排版结果放进 iframe，让人看清章节、图片、顺序对不对，
   * 再决定导出 Word / PDF / PPT。不再是「点一下就给个文件」。
   */
  function openDocPreview(m, opts) {
    opts = opts || {};
    var back = document.createElement('div');
    back.className = 'sheet-back pv-back';
    back.innerHTML = '<div class="sheet pv-sheet">' +
      '<div class="sheet-hd"><b>成书预览 · ' + esc(m.meta.title) + '</b>' +
      '<button class="sheet-x" data-pv-close="1">✕</button></div>' +
      '<div class="pv-body"><div class="pv-tip" id="pvTip">正在把图片装进去……</div>' +
      '<iframe class="pv-frame" id="pvFrame" title="成书预览"></iframe></div>' +
      '<div class="pv-acts">' +
      '<button class="btn tiny" data-pv-close="1">返回</button>' +
      '<span class="pv-note">这里只是排版检查，还没生成文件</span>' +
      '<button class="btn tiny" data-pv="docx">导出 Word</button>' +
      '<button class="btn tiny" data-pv="pdf">导出 PDF</button>' +
      '<button class="btn tiny primary" data-pv="print">打印 / 存 PDF</button>' +
      '</div></div>';
    document.body.appendChild(back);

    var tip = back.querySelector('#pvTip');
    var frame = back.querySelector('#pvFrame');

    window.Exporter.inlineImages(m, 100).then(function (inl) {
      frame.srcdoc = window.Exporter.html(m, { theme: opts.theme, size: opts.size, images: inl.map });
      tip.textContent = '共 ' + m.meta.chapters + ' 章 · 约 ' + m.meta.words + ' 字 · ' +
        m.meta.photos + ' 张照片';
    }).catch(function (e) {
      tip.textContent = '预览排版出错：' + (e.message || e);
    });

    back.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      if (t.closest('[data-pv-close]')) { back.remove(); return; }
      var b = t.closest('[data-pv]');
      if (!b) return;
      var kind = b.getAttribute('data-pv');
      b.disabled = true;
      var p;
      if (kind === 'print') {
        window.Exporter.print(m, { size: opts.size, theme: opts.theme });
        back.remove();
        return;
      }
      if (kind === 'pdf') p = window.Exporter.pdf(m, { size: opts.size, theme: opts.theme, archiveId: opts.archiveId });
      else p = window.Exporter.docx(m, { archiveId: opts.archiveId });
      Promise.resolve(p).then(function (r) {
        b.disabled = false;
        if (r && r.ok === false) return toast(r.message || '导出失败');
        toast(r && r.path ? '已导出：' + r.path : '好了');
        back.remove();
      }).catch(function (e) { b.disabled = false; fail(e); });
    });
  }

  function openExportSheet(archiveId) {
    var back = document.createElement('div');
    back.className = 'sheet-back';
    back.innerHTML = '<div class="sheet"><div class="sheet-hd"><b>导出这本档案</b>' +
      '<button class="sheet-x" data-ex-close="1">✕</button></div>' +
      '<div class="sheet-bd">' +
      '<button class="ex-preview" data-ex="preview"><b>先预览成书</b>' +
      '<small>按你选的开本和纸色排一遍，看清楚了再决定导出哪种</small></button>' +
      '<div class="ex-grid">' +
      '<button class="ex-card" data-ex="print"><b>印刷版</b><small>浏览器里直接看，按 Ctrl+P 存成 PDF</small></button>' +
      '<button class="ex-card" data-ex="pdf"><b>PDF</b><small>一键出文件，需要电脑上装了 Chrome/Edge</small></button>' +
      '<button class="ex-card" data-ex="docx"><b>Word</b><small>能改能批注，给要动笔的人</small></button>' +
      '<button class="ex-card" data-ex="pptx"><b>PPT</b><small>家族聚会放映用，一页一章</small></button>' +
      '</div>' +
      '<div class="ex-opts"><label>开本' +
      '<select class="fi" id="exSize"><option value="a5">A5（小册子）</option><option value="a4">A4（打印装订）</option></select></label>' +
      '<label>纸色' +
      '<select class="fi" id="exTheme"><option value="paper">素纸</option><option value="ink">靛蓝</option><option value="warm">暖棕</option></select></label>' +
      '</div>' +
      '<div class="ex-tip" id="exTip">导出会读一遍全部内容，图多的时候要等一会儿。生成的文件都在 data/users/&lt;账号&gt;/files/exports/ 里。</div>' +
      '</div></div>';
    document.body.appendChild(back);

    var tip = back.querySelector('#exTip');
    var busy = false;

    back.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      if (t.closest('[data-ex-close]')) { back.remove(); return; }
      var b = t.closest('[data-ex]');
      if (!b || busy) return;
      var kind = b.getAttribute('data-ex');
      var size = back.querySelector('#exSize').value;
      var theme = back.querySelector('#exTheme').value;

      busy = true;
      b.classList.add('on');
      tip.textContent = '正在准备……';

      var t0 = Date.now();
      window.Exporter.model(archiveId).then(function (m) {
        if (kind === 'preview') {
          busy = false; b.classList.remove('on');
          tip.textContent = '正在排版预览……';
          openDocPreview(m, { size: size, theme: theme, archiveId: archiveId });
          return null;
        }
        if (kind === 'print') {
          tip.textContent = '已打开新窗口，按 Ctrl+P（Mac 是 ⌘P）→ 目标选「另存为 PDF」。';
          window.Exporter.print(m, { size: size, theme: theme });
          busy = false; b.classList.remove('on');
          return null;
        }
        if (kind === 'pdf') {
          tip.textContent = '正在把图片打包进文档……';
          return window.Exporter.pdf(m, { size: size, theme: theme, archiveId: archiveId });
        }
        if (kind === 'docx') {
          tip.textContent = '正在排 Word（图多会慢一点）……';
          return window.Exporter.docx(m, { archiveId: archiveId });
        }
        tip.textContent = '正在排 PPT……';
        return window.Exporter.pptx(m, { archiveId: archiveId });
      }).then(function (r) {
        busy = false; b.classList.remove('on');
        if (!r) return;
        if (!r.ok) {
          tip.textContent = r.message || '没导出成功';
          return;
        }
        tip.innerHTML = '好了：' + esc(r.path) + '（' + bytes(r.bytes) + '，用了 ' +
          Math.round((Date.now() - t0) / 1000) + ' 秒）<br>' +
          '<a class="linkbtn" target="_blank" href="' + esc(fsrc(r.path)) + '">打开看看</a>';
      }).catch(function (e) {
        busy = false; b.classList.remove('on');
        tip.textContent = '出错：' + (e.message || e);
      });
    });
  }

  /**
   * 朗读前先给人看一眼：要读哪些章、多少段、多少字。
   * 「从头朗读」必须从目录第一章的第一段开始，而不是封面、档案信息或页尾。
   */
  function openReadSheet(aid, chId) {
    var sql = 'SELECT c.id, c.seq, c.title, COUNT(e.id) n, COALESCE(SUM(LENGTH(COALESCE(e.text,\'\'))),0) chars ' +
      'FROM chapters c LEFT JOIN entries e ON e.chapter_id=c.id AND e.kind IN (\'text\',\'quote\') ' +
      'WHERE c.archive_id=? GROUP BY c.id ORDER BY c.seq, c.id';
    API.query(sql, [aid]).then(function (list) {
      if (!list || !list.length) { toast('这本档案还没有目录'); return; }
      var totalSeg = 0, totalChars = 0, i;
      for (i = 0; i < list.length; i++) { totalSeg += Number(list[i].n) || 0; totalChars += Number(list[i].chars) || 0; }

      var startIdx = 0;
      if (chId) {
        for (i = 0; i < list.length; i++) if (String(list[i].id) === String(chId)) startIdx = i;
      }

      var rows = '';
      for (i = 0; i < list.length; i++) {
        var t = String(list[i].title || '').replace(/^[^·]*·\s*/, '') || ('第 ' + (i + 1) + ' 章');
        rows += '<label class="rd-row' + (i === startIdx ? ' on' : '') + '">' +
          '<input type="radio" name="rdStart" value="' + list[i].id + '"' + (i === startIdx ? ' checked' : '') + '>' +
          '<span class="rd-idx">' + (i + 1) + '</span>' +
          '<span class="rd-t">' + esc(t) + '</span>' +
          '<span class="rd-n">' + (list[i].n || 0) + ' 段' +
          (Number(list[i].chars) ? ' · ' + list[i].chars + ' 字' : '') + '</span></label>';
      }

      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal rd-modal"><h3>' + (chId ? '朗读这一章' : '从头朗读') + '</h3>' +
        '<p class="hint dim">' + (chId
          ? '只读选中的这一章，读完自动停。'
          : '从选中的这一章开始，按目录顺序往下读。要听全本，就选第 1 章。') +
        '一共 ' + totalSeg + ' 段 · 约 ' + totalChars + ' 字，按 0.95 倍速大约 ' +
        Math.max(1, Math.round(totalChars / 240)) + ' 分钟。</p>' +
        '<div class="rd-list">' + rows + '</div>' +
        '<div class="ml-modal-acts"><button class="btn primary" data-rd-go="1">开始朗读</button>' +
        '<button class="btn" data-rd-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);

      ov.addEventListener('click', function (ev) {
        if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-rd-cancel]'))) {
          ov.parentNode.removeChild(ov); return;
        }
        var row = ev.target.closest && ev.target.closest('.rd-row');
        if (row) {
          var all = ov.querySelectorAll('.rd-row');
          for (var k = 0; k < all.length; k++) all[k].className = 'rd-row' + (all[k] === row ? ' on' : '');
          return;
        }
        if (ev.target.closest && ev.target.closest('[data-rd-go]')) {
          var sel = ov.querySelector('input[name=rdStart]:checked');
          var fromId = sel ? sel.value : list[0].id;
          var start = 0;
          for (var j = 0; j < list.length; j++) if (String(list[j].id) === String(fromId)) start = j;
          ov.parentNode.removeChild(ov);
          if (!window.TTS) { toast('这个版本不能朗读'); return; }
          if (chId) {
            var secOne = document.getElementById('ch-' + fromId);
            if (secOne) window.TTS.speakFrom(secOne);
            return;
          }
          // 从头读：页面上「整本阅读」那块默认是收起的，先展开，读的时候能看见高亮
          var fb = document.getElementById('fullBody');
          if (fb && fb.hidden) fb.hidden = false;
          var queue = [];
          for (var s = start; s < list.length; s++) queue.push(list[s].id);
          readChain(queue, 0);
        }
      });
    }).catch(fail);
  }

  /** 一章读完自动接下一章 */
  function readChain(ids, i) {
    if (i >= ids.length) return;
    var sec = document.getElementById('ch-' + ids[i]);
    if (!sec) { readChain(ids, i + 1); return; }
    try { sec.scrollIntoView({ block: 'start' }); } catch (e) {}
    window.TTS.speakFrom(sec, { onDone: function () { readChain(ids, i + 1); } });
  }

  function bindTtsOnce() {
    document.addEventListener('click', function (ev) {
      var t;
      if ((t = ev.target.closest('[data-read-all]'))) {
        var aidAll = t.getAttribute('data-aid');
        if (!aidAll) {
          var mH = (location.hash || '').match(/#\/a\/(\d+)/);
          aidAll = mH ? mH[1] : '';
        }
        if (!aidAll) { toast('先打开一本档案'); return; }
        openReadSheet(Number(aidAll), null);
        return;
      }
      if ((t = ev.target.closest('[data-read-ch]'))) {
        var chId2 = Number(t.getAttribute('data-read-ch'));
        var mH2 = (location.hash || '').match(/#\/a\/(\d+)/);
        var aid2 = mH2 ? Number(mH2[1]) : 0;
        if (aid2) { openReadSheet(aid2, chId2); return; }
        var sec = document.getElementById('ch-' + chId2);
        if (sec && window.TTS) window.TTS.speakFrom(sec);
      }
    });
  }

  function boot() {
    // token 直通必须最先做——applyPrefs 会发请求，401 拦截会抢在正常流程前跳登录页
    var h0 = location.hash || '';
    var tk = h0.match(/[?&]token=([A-Za-z0-9]+)/);
    if (tk) {
      API.auth.setToken(tk[1]);
      // 保留路径，只摘掉 token 参数
      var clean0 = h0.replace(/[?&]token=[A-Za-z0-9]+/, '');
      try { history.replaceState(null, '', location.pathname + location.search + '#' + clean0.replace(/^#/, '')); }
      catch (e) { location.hash = clean0 || '#/'; }
    }
    applyPrefs();   // 先把字号/夜间落到页面，避免闪一下
    bindTtsOnce();
    bindToolsOnce();
    if (window.Mixer) { try { window.Mixer.restore(); } catch (e) {} }
    API.auth.onUnauthorized(function () {
      try { localStorage.removeItem('mylife.token'); } catch (e) {}
      go('#/login');
    });
    // 有 token 先验一下（过期了就地进登录页），没有直接进登录页
    if (!API.auth.token()) { go('#/login'); return; }
    API.auth.me().then(function (u) {
      try { if (u && u.phone) localStorage.setItem('mylife.phone', u.phone); } catch (e2) {}
      route();
    }).catch(function (e) {
      API.auth.setToken('');
      go('#/login');
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.APP = { route: route, toast: toast, openWholeBook: openWholeBook, openExport: openExportSheet, openRead: openReadSheet };
})();
