/**
 * 剧本页：把一章口述变成可拍的分场剧本。
 *
 * 用法只有三步：选一章 → 生成 → 不满意就改/重来。
 * 铁律写在 prompt 里：只用档案事实，缺的写 [待考]，不许编人名事件。
 * 导出是纯文本——编剧、演员、打印都认这个格式。
 */
(function () {
  'use strict';

  var ML = window.ML || {};
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    });
  }
  function toast(m) { if (ML.toast) ML.toast(m); }

  function render(host, archiveId) {
    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      DB.listScripts(archiveId)
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], scripts = r[2];
      if (!a) throw new Error('找不到这本档案');

      var opts = '<option value="">整本（前 30 条）</option>';
      for (var i = 0; i < chapters.length; i++) {
        opts += '<option value="' + chapters[i].id + '">' + esc(chapters[i].title || ('第 ' + (i + 1) + ' 章')) + '</option>';
      }
      var listHtml = '';
      for (var k = 0; k < scripts.length; k++) {
        listHtml += '<button class="chip' + (k === 0 ? ' on' : '') + '" data-script="' + scripts[k].id + '">' +
          esc(scripts[k].title || ('剧本 ' + scripts[k].id)) + '</button>';
      }

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '剧本' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">把这一章改成戏</h1>' +
        '<p class="muted">只用档案里的人和事。缺的细节会标 [待考]，不会替老人编。</p></section>' +
        '<section class="sc-bar">' +
        '<select class="fi" id="scCh" style="max-width:240px">' + opts + '</select>' +
        '<button class="btn primary" id="scGen">生成剧本</button>' +
        '</section>' +
        '<section class="sc-req"><label class="ap-l">生成要求<small>可以改；留空按默认（3–6 场，只用档案事实）</small>' +
        '<textarea id="scExtra" placeholder="例如：只写 1960 年代；每场一个地点；对白保留方言；多写母亲的部分"></textarea></label></section>' +
        '<p class="hint dim" id="scTip">生成会用「设置 → 模型来源」里的文字模型，一次约一两千字。</p>' +
        (listHtml ? '<div class="sc-list" id="scList">' + listHtml + '</div>' : '') +
        '<section id="scBody"></section></main>';

      var body = host.querySelector('#scBody');
      var tip = host.querySelector('#scTip');

      host.querySelector('#scGen').addEventListener('click', function () {
        var btn = this;
        var chId = host.querySelector('#scCh').value;
        var extraEl = host.querySelector('#scExtra');
        var extra = extraEl ? String(extraEl.value || '').trim() : '';
        btn.disabled = true;
        tip.textContent = '正在排场次……';
        DB.generateScript(archiveId, chId ? Number(chId) : null, extra).then(function (res) {
          btn.disabled = false;
          tip.textContent = '排好了 ' + res.scenes.length + ' 场。不满意可以再生成一次。';
          showScript(res.id);
        }).catch(function (e) {
          btn.disabled = false;
          tip.textContent = '没排成：' + (e.message || e);
        });
      });

      if (scripts.length) {
        var listEl = host.querySelector('#scList');
        if (listEl) listEl.addEventListener('click', function (ev) {
          var t = ev.target.closest ? ev.target.closest('[data-script]') : null;
          if (!t) return;
          var all = listEl.querySelectorAll('[data-script]');
          for (var i = 0; i < all.length; i++) all[i].className = 'chip' + (all[i] === t ? ' on' : '');
          showScript(Number(t.getAttribute('data-script')));
        });
        showScript(Number(scripts[0].id));
      } else {
        body.innerHTML = '<div class="empty-guide"><h2>还没有剧本</h2>' +
          '<p>选一章，点「生成剧本」。生成的稿子可以导出成纯文本，拿去改、拿去演。</p></div>';
      }

      function showScript(id) {
        DB.getScript(id).then(function (row) {
          var scenes = (row.parsed && row.parsed.scenes) || [];
          var html = '<div class="sc-head"><b>' + esc(row.title || '剧本') + '</b>' +
            '<div class="sc-ops">' +
            '<button class="btn tiny" data-sc-print="1">打印版</button>' +
            '<button class="btn tiny" data-sc-txt="1">导出 .txt</button>' +
            '<button class="btn tiny danger-t" data-sc-del="' + row.id + '">删</button>' +
            '</div></div>';

          for (var i = 0; i < scenes.length; i++) {
            var s = scenes[i];
            html += '<article class="sc-card">' +
              '<div class="sc-slug"><span>场 ' + (s.no || i + 1) + '</span>' + esc(s.slug || '') + '</div>' +
              (s.chars && s.chars.length ? '<div class="sc-chars">人物：' + esc(s.chars.join('、')) + '</div>' : '');
            for (var a2 = 0; a2 < (s.action || []).length; a2++) {
              html += '<p class="sc-act">' + esc(s.action[a2]) + '</p>';
            }
            for (var d = 0; d < (s.dialogue || []).length; d++) {
              html += '<p class="sc-line"><b>' + esc(s.dialogue[d].who) + '</b>' +
                esc(s.dialogue[d].line) + '</p>';
            }
            html += '</article>';
          }
          body.innerHTML = html;

          body.querySelector('[data-sc-txt]').onclick = function () {
            var text = DB.scriptToText(row);
            var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = (row.title || '剧本') + '.txt';
            link.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
            // 同时存一份到 exports/，安卓端也能在文件里找到
            var reader = new FileReader();
            reader.onload = function () {
              var s2 = String(reader.result || '');
              API.file({ op: 'save', dir: 'exports', name: (row.title || '剧本') + '.txt',
                base64: s2.slice(s2.indexOf(',') + 1) }).then(function () {
                toast('已导出，文件在 exports/ 里');
              }, function () {});
            };
            reader.readAsDataURL(blob);
          };

          body.querySelector('[data-sc-print]').onclick = function () {
            var text = DB.scriptToText(row);
            var w = window.open('', '_blank');
            if (!w) { toast('弹窗被拦了，改用「导出 .txt」'); return; }
            w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
              esc(row.title || '剧本') + '</title><style>' +
              'body{font:12pt/1.9 "Courier New","Songti SC",monospace;max-width:170mm;margin:20mm auto;padding:0 16px;color:#111}' +
              'h1{font-size:15pt;margin:0 0 10mm}' +
              '.slug{font-weight:700;margin:8mm 0 2mm;border-bottom:1px solid #999;padding-bottom:1mm}' +
              '.act{margin:2mm 0 2mm 8mm;color:#333}' +
              '.line{margin:1.5mm 0 1.5mm 24mm;text-indent:-24mm}' +
              '.line b{display:inline-block;width:22mm}' +
              '@page{size:A4;margin:18mm}' +
              '</style></head><body><pre style="display:none">' + esc(text) + '</pre></body></html>');
            w.document.close();
            setTimeout(function () { try { w.print(); } catch (e) {} }, 400);
          };

          body.querySelector('[data-sc-del]').onclick = function () {
            if (!window.confirm('删掉这份剧本？原文不受影响。')) return;
            DB.deleteScript(row.id).then(function () {
              toast('已删');
              location.hash = '#/a/' + archiveId + '/script';
              render(host, archiveId);
            });
          };
        }).catch(function (e) { toast(e.message || '打不开这份剧本'); });
      }
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/' }) + '<main class="wrap"><div class="empty">' +
        esc(e.message || '打不开') + '</div></main>';
    });
  }

  window.ScriptUI = { render: render };
})();
