/**
 * AI 助手：五个角色、语音输入、流式回复、回复可一键插回档案。
 *
 * 最后这条是它跟普通聊天最大的区别：聊天不该只产生聊天记录。
 * 上下文不引入向量库——档案就几百条，关键词召回 + 结构化摘要足够，
 * 多装一个 embedding 服务既费钱又要联网。
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
  function fail(e) { if (ML.fail) ML.fail(e); else toast(e && e.message || String(e)); }

  var ROLES = {
    interviewer: {
      n: '采访者',
      sys: '你是一位很有耐心的访谈者，面对一位愿意讲述一生的老人。规则：一次只问一个问题；问题要具体到时间、地点、人物、动作、感受；不要评价、不要总结、不要替对方抒情；如果对方回答模糊，就顺着细节再追问一层。用口语，句子短。'
    },
    editor: {
      n: '编辑',
      sys: '你是一位资深图书编辑，负责整理口述史。规则：保留说话人的语气与用词习惯，只修掉重复、口误和跑题；不添加原文没有的信息；不把口语改成书面腔；改动处尽量少。'
    },
    playwright: {
      n: '编剧',
      sys: '你是一位写实风格的编剧。规则：只能使用用户提供的档案事实，不得虚构人名、时间、事件；把素材整理成"场次—场景头—动作—对白"的剧本格式；缺的细节标 [待考]，不要自己编。'
    },
    songwriter: {
      n: '音乐人',
      sys: '你是一位民谣词作者。规则：三段式（主歌 1 / 副歌 / 主歌 2 / 副歌 / 尾声）；每句 7 到 11 字；必须至少出现两个来自档案的真实地名或物件；禁止"岁月如歌""时光荏苒"这类套话；写具体的事，不写抽象的情。'
    },
    historian: {
      n: '史官',
      sys: '你是一位熟悉中国现当代社会生活的历史顾问。规则：结合年代背景提醒可以补充的细节（票证、工资、单位制度、服饰、交通）；对不确定的史实要明说"不确定"；不要替用户编造亲历细节。'
    }
  };

  var cur = { threadId: null, role: 'interviewer', streaming: null, archiveId: null };

  /* ---------------- 上下文 ---------------- */

  function grams(text) {
    var cleaned = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ');
    var parts = cleaned.split(/\s+/).filter(function (x) { return x.length >= 2; });
    parts.sort(function (a, b) { return b.length - a.length; });
    return parts.slice(0, 3);
  }

  function buildContext(archiveId, userText, includeRefs) {
    // 独立使用（没绑定档案）：不编造、不假装有资料
    if (!archiveId) {
      return Promise.resolve({
        system: '你没有绑定任何一本档案。你可以帮用户写作、改稿、构思、整理口述。' +
          '需要用到具体的人名、时间、事件时，请让用户先把相关段落贴进来；不要自己编。',
        refs: [],
      });
    }
    return API.query('SELECT * FROM archives WHERE id=?', [archiveId]).then(function (rows) {
      var a = rows[0];
      if (!a) return { system: '', refs: [] };
      var facts = '';
      try {
        var fj = JSON.parse(a.facts_json || '[]');
        facts = fj.map(function (x) { return x.k + '：' + x.v; }).join('；');
      } catch (e) { facts = ''; }
      var card = [
        '档案主角：' + a.subject_name,
        a.birth_year ? '出生：' + a.birth_year + ' 年' : '',
        a.death_year ? '离世：' + a.death_year + ' 年' : '',
        a.hometown ? '籍贯：' + a.hometown : '',
        a.intro ? '一句话：' + a.intro : '',
        facts ? '档案信息：' + facts : '',
      ].filter(Boolean).join('\n');

      var keys = includeRefs === false ? [] : grams(userText);
      var refs = [];
      var q = keys.length
        ? API.query('SELECT id, text FROM entries WHERE archive_id=? AND (' +
            keys.map(function () { return 'text LIKE ?'; }).join(' OR ') +
            ') ORDER BY sort_key DESC LIMIT 8',
            [archiveId].concat(keys.map(function (k) { return '%' + k + '%'; })))
        : Promise.resolve([]);

      return q.then(function (list) {
        refs = list || [];
        var refText = refs.map(function (r, i) { return '【档案片段 ' + (i + 1) + '】' + String(r.text || '').slice(0, 220); }).join('\n');
        var system = '你在帮用户整理一本人生档案。\n\n' + card +
          (refText ? '\n\n以下是档案里与本次提问相关的原文片段：\n' + refText : '') +
          '\n\n回答要求：依据上面的事实，不要编造档案里没有的人名与事件；不确定就说不确定。';
        return { system: system, refs: refs, cardChars: card.length, refChars: refText.length };
      });
    });
  }

  /* ---------------- 渲染 ---------------- */

  function render(host, archiveId) {
    archiveId = archiveId ? Number(archiveId) : null;
    cur.archiveId = archiveId;
    var ready = archiveId
      ? API.query('SELECT * FROM archives WHERE id=?', [archiveId]).then(function (rows) {
          if (!rows[0]) throw new Error('找不到这本档案');
          return rows[0];
        })
      : Promise.resolve(null);

    ready.then(function (a) {
      host.innerHTML = ML.topbar({ back: archiveId ? '#/a/' + archiveId : '#/', title: 'AI 助手' }) +
        '<main class="wrap chat-wrap">' +
        '<section class="chat-hd">' +
        '<div class="chat-who">' + (a
          ? ('和 ' + esc(a.subject_name) + ' 的档案对话')
          : 'AI 写作助手 <small>没绑档案也能用，写完可以插进任何一本</small>') + '</div>' +
        '<div class="chat-roles" id="chatRoles"></div>' +
        '</section>' +
        '<section class="chat-log" id="chatLog"></section>' +
        '<section class="chat-in">' +
        '<div class="chat-priv" id="chatPriv"></div>' +
        '<div class="chat-opt">' +
        (a ? '<label class="chk"><input type="checkbox" id="chatRefs" checked> 带上档案原文做参考</label>' : '') +
        '<input class="fi" id="chatExtra" placeholder="附加要求（可选），如：只写 300 字 / 保留方言 / 别用套话">' +
        '</div>' +
        '<textarea class="say mini" id="chatText" rows="2" placeholder="说点什么……（Ctrl+Enter 发送）"></textarea>' +
        '<div class="chat-acts">' +
        '<button class="btn tiny" id="chatVoice">🎙 说</button>' +
        '<button class="btn tiny" id="chatNew">新对话</button>' +
        '<button class="btn tiny primary" id="chatSend">发送</button>' +
        '</div></section></main>';

      renderRoles(host);
      bind(host, archiveId, a);
      loadThread(host);
    }).catch(function (e) { fail(e); });
  }

  function renderRoles(host) {
    var out = '';
    for (var k in ROLES) {
      if (!Object.prototype.hasOwnProperty.call(ROLES, k)) continue;
      out += '<button class="chip' + (cur.role === k ? ' on' : '') + '" data-role="' + k + '">' + ROLES[k].n + '</button>';
    }
    host.querySelector('#chatRoles').innerHTML = out;
  }

  function bubble(role, text, refs) {
    var refLine = '';
    if (refs && refs.length) {
      refLine = '<div class="msg-refs">引用了 ' + refs.length + ' 条档案原文</div>';
    }
    return '<div class="msg ' + (role === 'user' ? 'me' : 'ai') + '">' +
      '<div class="msg-t">' + esc(text) + '</div>' + refLine +
      (role === 'assistant' ? '<div class="msg-ops"><button class="linkbtn" data-msg-insert="1">插入档案</button></div>' : '') +
      '</div>';
  }

  function loadThread(host) {
    var log = host.querySelector('#chatLog');
    if (!cur.threadId) {
      log.innerHTML = '<div class="chat-empty">' +
        '<p>选一个角色，直接问就行。比如：</p>' +
        '<button class="chip" data-say="1962 年换车间那天，你还记得什么？">1962 年换车间那天，你还记得什么？</button>' +
        '<button class="chip" data-say="帮我把「进厂」那一段整理成剧本">帮我把「进厂」那一段整理成剧本</button>' +
        '</div>';
      return;
    }
    DB.messages(cur.threadId).then(function (list) {
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var refs = null;
        try { refs = list[i].refs_json ? JSON.parse(list[i].refs_json) : null; } catch (e) {}
        html += bubble(list[i].role === 'user' ? 'user' : 'assistant', list[i].content, refs);
      }
      log.innerHTML = html || '<div class="chat-empty"><p>这段对话还没开始。</p></div>';
      log.scrollTop = log.scrollHeight;
    });
  }

  function bind(host, archiveId, a) {
    var log = host.querySelector('#chatLog');
    var textEl = host.querySelector('#chatText');
    var privEl = host.querySelector('#chatPriv');

    host.querySelector('#chatRoles').addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-role]') : null;
      if (!t) return;
      cur.role = t.getAttribute('data-role');
      renderRoles(host);
      toast('角色：' + ROLES[cur.role].n);
    });

    host.querySelector('#chatNew').addEventListener('click', function () {
      cur.threadId = null;
      loadThread(host);
      toast('开一段新对话');
    });

    log.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      var ins = t.closest('[data-msg-insert]');
      if (ins) {
        var msg = ins.closest('.msg');
        var body = msg.querySelector('.msg-t').textContent;
        insertToArchive(archiveId, body, host);
        return;
      }
      var say = t.closest('[data-say]');
      if (say) { textEl.value = say.getAttribute('data-say'); send(); }
    });

    function updatePriv() {
      var n = (textEl.value || '').length;
      var refsChk = host.querySelector('#chatRefs');
      var on = refsChk ? !!refsChk.checked : true;
      privEl.textContent = n ? ('本次会带上：人物卡' + (on ? ' + 相关原文' : '（不带原文）') + '（约 ' + Math.min(1200, n * 3) + ' 字）') : '';
    }
    textEl.addEventListener('input', updatePriv);
    var rc = host.querySelector('#chatRefs');
    if (rc) rc.addEventListener('change', updatePriv);
    updatePriv();

    textEl.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); send(); }
    });

    host.querySelector('#chatSend').addEventListener('click', send);

    function send() {
      var text = String(textEl.value || '').trim();
      if (!text) return;
      if (cur.streaming) { toast('上一条还在写'); return; }

      var refsChk = host.querySelector('#chatRefs');
      var extraEl = host.querySelector('#chatExtra');
      var includeRefs = refsChk ? !!refsChk.checked : true;
      var extra = extraEl ? String(extraEl.value || '').trim() : '';

      textEl.value = '';
      updatePriv();

      var ensure = cur.threadId ? Promise.resolve(cur.threadId)
        : DB.createThread(archiveId, cur.role, text.slice(0, 18)).then(function (id) {
            cur.threadId = id; return id;
          });

      ensure.then(function (tid) {
        log.innerHTML += bubble('user', text);
        var node = document.createElement('div');
        node.innerHTML = bubble('assistant', '');
        var aiEl = node.firstChild;
        log.appendChild(aiEl);
        var tEl = aiEl.querySelector('.msg-t');
        tEl.innerHTML = '<span class="dots">…</span>';
        log.scrollTop = log.scrollHeight;

        return DB.addMessage(tid, 'user', text).then(function () {
          return buildContext(archiveId, text, includeRefs);
        }).then(function (ctx) {
          var sys = ROLES[cur.role].sys + '\n\n' + ctx.system + (extra ? '\n\n用户补充要求：' + extra : '');
          var msgs = [{ role: 'system', content: sys }];
          return DB.messages(tid).then(function (hist) {
            for (var i = 0; i < hist.length; i++) {
              if (hist[i].role === 'user' || hist[i].role === 'assistant') {
                msgs.push({ role: hist[i].role, content: hist[i].content });
              }
            }
            msgs.push({ role: 'user', content: text });

            var acc = '';
            var streamErr = null;
            cur.streaming = API.chatStream({ messages: msgs }, function (evt) {
              if (evt.t === 'd') {
                acc += evt.v;
                tEl.textContent = acc;
                log.scrollTop = log.scrollHeight;
              } else if (evt.t === 'retry') {
                tEl.textContent = acc + '\n（换一个模型再试……）';
              } else if (evt.t === 'err') {
                streamErr = evt.message || '调用失败';
              }
            });

            return cur.streaming.then(function (full) {
              cur.streaming = null;
              if (streamErr && !full) throw new Error(streamErr);
              var finalText = full || acc;
              tEl.textContent = finalText;
              aiEl.setAttribute('data-refs', String(ctx.refs.length));
              return DB.addMessage(tid, 'assistant', finalText, ctx.refs).then(function () {
                log.scrollTop = log.scrollHeight;
              });
            }, function (err) {
              cur.streaming = null;
              // 手机上还没有流式接口（安卓宿主）时，退回一次性回复——
              // 宁可"等一下整段出来"，也不能让手机端用不了助手
              tEl.textContent = acc || '……';
              if (acc) {
                return DB.addMessage(tid, 'assistant', acc, ctx.refs).catch(function () {});
              }
              return API.ai({ messages: msgs }).then(function (r) {
                if (!r.ok) throw new Error(r.message || '调用失败');
                tEl.textContent = r.text;
                return DB.addMessage(tid, 'assistant', r.text, ctx.refs);
              }).catch(function (e2) {
                tEl.textContent = '（没成：' + (e2.message || e2) + '）';
              });
            });
          });
        });
      }).catch(function (e) { fail(e); });
    }

    host.querySelector('#chatVoice').addEventListener('click', function () {
      voice(host, archiveId, textEl);
    });
  }

  /* ---------------- 回复插回档案 ---------------- */

  /** 独立对话时先问「插进哪一本」，不让人自己去找 */
  function pickArchive(onPick) {
    DB.listArchives().then(function (list) {
      var rows = '';
      for (var i = 0; i < list.length; i++) {
        rows += '<button class="pick-ch" data-pick-arc="' + list[i].id + '">' +
          '<b>' + esc(list[i].subject_name || '') + '</b> ' +
          esc(DB.yearLabel(list[i].birth_year, list[i].death_year)) +
          ' · ' + (list[i].chapter_count || 0) + ' 章</button>';
      }
      var ov = document.createElement('div');
      ov.className = 'ml-modal-ov';
      ov.innerHTML = '<div class="ml-modal pick-modal"><h3>插进哪一本档案</h3>' +
        '<div class="pick-chs">' + (rows || '<p class="muted">还没有档案，先去首页新建一本。</p>') + '</div>' +
        '<div class="ml-modal-acts"><button class="btn" data-pa-cancel="1">取消</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pa-cancel]'))) {
          if (ov.parentNode) document.body.removeChild(ov);
          return;
        }
        var b = ev.target.closest && ev.target.closest('[data-pick-arc]');
        if (b) {
          var aid = Number(b.getAttribute('data-pick-arc'));
          document.body.removeChild(ov);
          onPick(aid);
        }
      });
    }).catch(fail);
  }

  function insertToArchive(archiveId, text, host) {
    if (!archiveId) {
      return pickArchive(function (aid) { insertToArchive(aid, text, host); });
    }
    var ov = document.createElement('div');
    ov.className = 'ml-modal-ov';
    ov.innerHTML = '<div class="ml-modal ci-modal"><h3>插入前先看一眼</h3>' +
      '<p class="hint dim">下面这段可以改，改好再选放到哪里。</p>' +
      '<textarea id="ciText">' + esc(text) + '</textarea>' +
      '<div class="ml-modal-acts">' +
      '<button class="btn primary" data-ci-year="1">放进某一年</button>' +
      '<button class="btn" data-ci-after="1">插到某段后面</button>' +
      '<button class="btn" data-ci-cancel="1">取消</button></div></div>';
    document.body.appendChild(ov);
    var ta = ov.querySelector('#ciText');
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-ci-cancel]'))) {
        document.body.removeChild(ov); return;
      }
      var v = String(ta.value || '').trim();
      if (ev.target.closest && ev.target.closest('[data-ci-year]')) {
        if (!v) return toast('内容不能为空');
        var year = window.prompt('这段内容放在哪一年？（只填年份，比如 1962）', '');
        if (!year) return;
        document.body.removeChild(ov);
        DB.insertAt({ archiveId: archiveId, year: Number(year), kind: 'text', text: v })
          .then(function () { toast('已插入 ' + year + ' 年'); }).catch(fail);
        return;
      }
      if (ev.target.closest && ev.target.closest('[data-ci-after]')) {
        if (!v) return toast('内容不能为空');
        document.body.removeChild(ov);
        openParagraphPicker(archiveId, function (entryId) {
          DB.insertAfter(archiveId, { afterId: entryId, kind: 'text', text: v })
            .then(function () { toast('已插到那一段后面'); }).catch(fail);
        });
      }
    });
  }

  /** 选一段，插在它后面——人能自己决定放哪，不用靠"年份"猜 */
  function openParagraphPicker(archiveId, onPick) {
    API.query('SELECT id, text, at_year FROM entries WHERE archive_id=? AND kind IN (?,?) ' +
      'ORDER BY COALESCE(sort_key,seq,0), id LIMIT 300', [archiveId, 'text', 'quote'])
      .then(function (list) {
        var rows = '', i;
        for (i = 0; i < list.length; i++) {
          var e = list[i];
          rows += '<button class="pick-ch" data-pick-entry="' + e.id + '">' +
            '<b>' + (e.at_year ? esc(e.at_year + ' 年') : '未标年份') + '</b> ' +
            esc(String(e.text || '').slice(0, 60)) + '</button>';
        }
        var ov = document.createElement('div');
        ov.className = 'ml-modal-ov';
        ov.innerHTML = '<div class="ml-modal pick-modal"><h3>插到哪一段后面</h3>' +
          '<div class="pick-chs">' + (rows || '<p class="muted">还没有段落</p>') + '</div>' +
          '<div class="ml-modal-acts"><button class="btn" data-pe-cancel="1">取消</button></div></div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov || (ev.target.closest && ev.target.closest('[data-pe-cancel]'))) {
            document.body.removeChild(ov); return;
          }
          var pb = ev.target.closest && ev.target.closest('[data-pick-entry]');
          if (pb) {
            var eid = Number(pb.getAttribute('data-pick-entry'));
            document.body.removeChild(ov);
            onPick(eid);
          }
        });
      }).catch(fail);
  }

  /* ---------------- 语音输入 ---------------- */

  function voice(host, archiveId, textEl) {
    var btn = host.querySelector('#chatVoice');
    var N = window.NativeRec;
    if (N) {
      try {
        if (String(N.state() || '') !== 'recording') {
          N.ask();
          var r = String(N.start(API.auth.token(), 'chat-' + Date.now() + '.wav') || '');
          if (r.indexOf('ok') !== 0) { toast('录音开不了：' + r); return; }
          btn.textContent = '■ 停';
          btn.setAttribute('data-on', '1');
          return;
        }
        var out = {};
        try { out = JSON.parse(String(N.stop() || '{}')); } catch (e) { out = {}; }
        btn.textContent = '🎙 说';
        btn.removeAttribute('data-on');
        if (!out.ok) { toast('这段没录上'); return; }
        toast('转写中……');
        API.asr({ path: out.path }).then(function (r2) {
          if (!r2.ok) { toast(r2.message || '转不出来'); return; }
          textEl.value = (textEl.value ? textEl.value + ' ' : '') + r2.text;
        }, function (e) { fail(e); });
        return;
      } catch (e) { toast('录音出错：' + e.message); return; }
    }

    if (btn.getAttribute('data-on')) { btn.textContent = '🎙 说'; btn.removeAttribute('data-on'); if (window.__chatStop) window.__chatStop(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('这个浏览器不支持录音'); return; }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mr = new MediaRecorder(stream);
      var chunks = [];
      window.__chatStop = function () {
        try { mr.stop(); } catch (e) {}
        stream.getTracks().forEach(function (t) { t.stop(); });
      };
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        var blob = new Blob(chunks, { type: 'audio/webm' });
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result || '');
          API.file({ op: 'save', dir: 'audio', name: 'chat-' + Date.now() + '.webm', base64: b64 })
            .then(function (f) { return API.asr({ path: f.path }); })
            .then(function (r) {
              if (!r.ok) { toast(r.message || '转不出来'); return; }
              textEl.value = (textEl.value ? textEl.value + ' ' : '') + r.text;
            }, function (e) { fail(e); });
        };
        fr.readAsDataURL(blob);
      };
      mr.start();
      btn.textContent = '■ 停';
      btn.setAttribute('data-on', '1');
    }, function () { toast('麦克风没打开'); });
  }

  window.ChatUI = { render: render };
})();
