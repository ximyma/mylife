/**
 * v0.9.18 AI 访谈模式 + 问题库。
 * 对标 Remento / 慰康的「追问式访谈」：AI 扮演采访者，从问题库出题、
 * 把问题具体到档案主角身上，每个问题至少追问两层细节；
 * 结束后出「访谈纪要」并建议拆成哪几条档案条目，一键批量收进档案。
 * 语音回答复用素材箱的录音链路（原生壳 NativeRec 优先，浏览器兜底）。
 * 刻意 ES5——安卓 5/6 的 WebView 内核老。
 */
(function () {
  'use strict';

  var esc = function (s) { return window.ML.esc(s); };
  var toast = function (m) { window.ML.toast(m); };
  var fail = function (e) { window.ML.fail(e); };
  var fsrc = function (p) { return window.ML.fsrc(p); };

  /** 每个问题固定追问两轮（原问题 + 回答 + 追问1 + 回答 + 追问2 + 回答 → 下一题） */
  var FOLLOW = 2;

  /** 进行中的访谈状态（问题与回答都持久在 thread 里，这里只存进度） */
  var S = { on: false, archiveId: null, topic: 0, q: 0, round: 0,
            threadId: null, question: '', started: '', log: [] };

  function Q() { return window.MLQ; }
  function topic(i) { return Q().topics[i] || Q().topics[0]; }
  function bankQ(t, i) { return topic(t).qs[i] || null; }
  function topicDone(t) { return S.q >= topic(t).qs.length; }

  /* ---------------- 状态持久化（settings 表） ---------------- */

  function saveState() {
    var s = { on: S.on, archiveId: S.archiveId, topic: S.topic, q: S.q,
              round: S.round, threadId: S.threadId, question: S.question, started: S.started };
    try { window.DB.saveSetting('interview.state', JSON.stringify(s)); } catch (e) {}
  }

  function loadState() {
    return window.DB.getSettings().then(function (cfg) {
      try {
        var s = JSON.parse(cfg['interview.state'] || 'null');
        if (s && s.on && s.threadId) return s;
      } catch (e) {}
      return null;
    }).catch(function () { return null; });
  }

  function clearState() {
    try { window.DB.saveSetting('interview.state', ''); } catch (e) {}
  }

  /* ---------------- 档案卡（给 AI 的主角背景） ---------------- */

  function archiveCard(archiveId) {
    return window.API.query('SELECT * FROM archives WHERE id=?', [archiveId]).then(function (rows) {
      var a = rows[0];
      if (!a) return '';
      var facts = '';
      try {
        var fj = JSON.parse(a.facts_json || '[]');
        facts = fj.map(function (x) { return x.k + '：' + x.v; }).join('；');
      } catch (e) { facts = ''; }
      return [
        '档案主角：' + a.subject_name,
        a.birth_year ? '出生：' + a.birth_year + ' 年' : '',
        a.death_year ? '离世：' + a.death_year + ' 年' : '',
        a.hometown ? '籍贯：' + a.hometown : '',
        a.intro ? '简介：' + a.intro : '',
        facts ? '已知信息：' + facts : ''
      ].filter(Boolean).join('\n');
    }).catch(function () { return ''; });
  }

  /** 取最近写过的几条档案原文，帮 AI 接着话头问（不多带，省 token） */
  function recentEntries(archiveId) {
    return window.API.query(
      'SELECT text, at_year FROM entries WHERE archive_id=? AND kind IN (?,?) ' +
      'ORDER BY id DESC LIMIT 5', [archiveId, 'text', 'quote'])
      .then(function (rows) {
        return (rows || []).map(function (r) {
          return (r.at_year ? r.at_year + ' 年：' : '') + String(r.text || '').slice(0, 120);
        }).join('\n');
      }).catch(function () { return ''; });
  }

  /* ---------------- AI 出题 ---------------- */

  /**
   * 让 AI 把题库问题改造成「具体到这位主角」的一句口语提问。
   * 没配模型 / 调用失败时，念题库原题（追问时念追问提示）——访谈照样能做，只是不个性化。
   */
  function askAI(bank, fallback, isFollowUp) {
    var card = '';
    var refs = '';
    return (S.archiveId ? archiveCard(S.archiveId).then(function (c) {
      card = c;
      return recentEntries(S.archiveId);
    }).then(function (r) { refs = r; }) : Promise.resolve())
      .then(function () {
        var sys =
          '你是一位面对老人做口述史访谈的采访者。一次只说一句话——就是你的下一个问题，' +
          '不要寒暄、不要总结、不要点评对方的回答、不要输出任何别的内容。\n' +
          (card ? '这位主角的背景：\n' + card + '\n' : '') +
          (refs ? '他/她最近讲过的内容：\n' + refs + '\n' : '') +
          (isFollowUp
            ? '现在就上面最后一个回答追问一层细节：时间、地点、人物、动作、气味、价钱，挑一样追。'
            : '把下面这道题库问题改写成问这位主角的口语问题（带上他/她的具体情况，比如年份、地名），意思不变。\n题库问题：' + bank);
        var msgs = [{ role: 'system', content: sys }];
        // 带上最近两轮原话，追问才接得住话头
        var tail = S.log.slice(-4);
        for (var i = 0; i < tail.length; i++) {
          msgs.push({ role: tail[i].role === 'user' ? 'user' : 'assistant', content: tail[i].text });
        }
        if (!isFollowUp) msgs.push({ role: 'user', content: '请直接输出改写后的问题，只输出问题本身。' });
        return window.API.ai({ messages: msgs, maxTokens: 160, temperature: 0.7 });
      })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.message) || '没回话');
        var t = String(r.text || '').replace(/^\s*[「"']|[」"']\s*$/g, '').trim();
        if (!t || t.length > 120) throw new Error('回复不像一个问题');
        return t;
      })
      .catch(function () { return fallback; });   // 兜底：念原题 / 追问提示
  }

  function pushMsg(role, text) {
    S.log.push({ role: role, text: text });
    if (S.threadId) {
      window.DB.addMessage(S.threadId, role === 'user' ? 'user' : 'assistant', text)
        .catch(function () {});
    }
  }

  /* ---------------- 页面渲染 ---------------- */

  function render(appEl, pre) {
    pre = pre || {};
    loadState().then(function (saved) {
      if (saved) {
        S.on = true; S.archiveId = saved.archiveId; S.topic = saved.topic || 0;
        S.q = saved.q || 0; S.round = saved.round || 0; S.threadId = saved.threadId;
        S.question = saved.question || ''; S.started = saved.started || '';
        return window.DB.messages(S.threadId).then(function (list) {
          S.log = [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].role === 'user' || list[i].role === 'assistant') {
              S.log.push({ role: list[i].role === 'user' ? 'user' : 'ai', text: list[i].content });
            }
          }
          if (S.log.length >= 2) { renderSession(appEl, true); return; }
          S.on = false; clearState();
          renderSetup(appEl, pre);
        });
      }
      renderSetup(appEl, pre);
    }).catch(fail);
  }

  /** 开场：选档案、选主题 */
  function renderSetup(appEl, pre) {
    var arcs = [];
    window.DB.listArchives().then(function (list) {
      arcs = list;
      var arcOpts = '<option value="">（不选档案，直接按题库问）</option>';
      for (var i = 0; i < arcs.length; i++) {
        arcOpts += '<option value="' + arcs[i].id + '"' +
          (pre.archiveId === arcs[i].id ? ' selected' : '') + '>' +
          esc(arcs[i].subject_name) + '</option>';
      }
      var chips = '';
      for (i = 0; i < Q().topics.length; i++) {
        chips += '<button class="chip' + (i === (pre.topic || 0) ? ' on' : '') +
          '" data-iv-topic="' + i + '">' + topic(i).icon + ' ' + esc(topic(i).n) +
          ' <small>' + topic(i).qs.length + ' 题</small></button>';
      }
      var preview = topic(pre.topic || 0).qs.slice(0, 3).map(function (p) {
        return '<li>' + esc(p[0]) + '</li>';
      }).join('');

      appEl.innerHTML = window.ML.topbar({ back: '#/', title: 'AI 访谈' }) +
        '<main class="wrap narrow iv-setup">' +
        '<p class="muted iv-lead">像聊天一样，把一生的故事问出来。AI 扮演采访者，每个问题都会' +
        '<b>追问至少两层细节</b>；全程的文字就是档案素材，结束自动整理成<b>访谈纪要</b>，一键收进档案。</p>' +
        '<div class="fld"><label>访谈谁<select class="fi" id="ivArc">' + arcOpts + '</select></label></div>' +
        '<div class="fld"><label>从哪类聊起<div class="pick-chs iv-topics">' + chips + '</div></label></div>' +
        '<div class="iv-preview"><b>这个主题的开头三问：</b><ol>' + preview + '</ol></div>' +
        '<div class="row"><button class="btn primary" id="ivStart">开始访谈</button></div>' +
        '<p class="muted small">一共 ' + Q().topics.length + ' 个主题、' + totalQs() +
        ' 道题。不用一次问完，随时可以停，进度会记住。</p>' +
        '</main>';

      var cur = pre.topic || 0;
      appEl.addEventListener('click', function (ev) {
        var c = ev.target.closest ? ev.target.closest('[data-iv-topic]') : null;
        if (!c) return;
        cur = Number(c.getAttribute('data-iv-topic')) || 0;
        var all = appEl.querySelectorAll('[data-iv-topic]');
        for (var j = 0; j < all.length; j++) all[j].className = 'chip';
        c.className = 'chip on';
        var pv = appEl.querySelector('.iv-preview ol');
        if (pv) pv.innerHTML = topic(cur).qs.slice(0, 3).map(function (p) {
          return '<li>' + esc(p[0]) + '</li>';
        }).join('');
      });

      document.getElementById('ivStart').onclick = function () {
        var sel = document.getElementById('ivArc');
        var aid = sel && sel.value ? Number(sel.value) : null;
        start(appEl, aid, cur);
      };
    }).catch(fail);
  }

  function totalQs() {
    var n = 0;
    for (var i = 0; i < Q().topics.length; i++) n += Q().topics[i].qs.length;
    return n;
  }

  function start(appEl, archiveId, topicIdx) {
    S.on = true; S.archiveId = archiveId; S.topic = topicIdx; S.q = 0; S.round = 0;
    S.question = ''; S.log = [];
    S.started = new Date().toISOString().slice(0, 10);
    var title = 'AI 访谈·' + topic(S.topic).n;
    window.DB.createThread(archiveId, 'interview', title).then(function (tid) {
      S.threadId = tid;
      saveState();
      renderSession(appEl, false);
      askNext(appEl);
    }).catch(fail);
  }

  /** 会话视图：进度条 + 问答流 + 回答框 */
  function renderSession(appEl, resuming) {
    var t = topic(S.topic);
    appEl.innerHTML = window.ML.topbar({ back: '#/', title: 'AI 访谈' }) +
      '<main class="wrap narrow iv-page">' +
      '<div class="iv-progress" id="ivProg"></div>' +
      '<div class="iv-log" id="ivLog"></div>' +
      '<div class="iv-in">' +
      '<textarea class="say mini" id="ivText" rows="2" ' +
      'placeholder="回答（打字，或点 🎙 说完再发）"></textarea>' +
      '<div class="chat-acts">' +
      '<button class="btn tiny" id="ivVoice">🎙 说</button>' +
      '<button class="btn tiny ghost" id="ivSkip">换个问题</button>' +
      '<button class="btn tiny ghost" id="ivEnd">结束并整理</button>' +
      '<button class="btn tiny primary" id="ivSend">发送</button>' +
      '</div></div>' +
      '<div id="ivRec" class="muted small rec-state"></div>' +
      '</main>';

    if (resuming) {
      drawLog();
      toast('接上上次的访谈，继续');
    }
    document.getElementById('ivSend').onclick = function () { sendAnswer(appEl); };
    document.getElementById('ivSkip').onclick = function () { skipQuestion(appEl); };
    document.getElementById('ivEnd').onclick = function () { endInterview(appEl); };
    bindVoice(appEl);
    updateProgress();
    var ta = document.getElementById('ivText');
    if (ta) ta.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); sendAnswer(appEl); }
    });
  }

  function updateProgress() {
    var el = document.getElementById('ivProg');
    if (!el) return;
    var t = topic(S.topic);
    var pos = topicDone(S.topic) ? '本题库问完了，可以换个主题或结束' :
      ('第 ' + (S.q + 1) + '/' + t.qs.length + ' 题 · ' + t.icon + ' ' + t.n +
        (S.round > 0 ? ' · 追问第 ' + S.round + ' 层' : ''));
    el.innerHTML = '<span>' + esc(pos) + '</span>' +
      '<span class="muted small">' + esc(S.started || '') + ' 开始</span>';
  }

  function drawLog(typing) {
    var log = document.getElementById('ivLog');
    if (!log) return;
    var html = '';
    for (var i = 0; i < S.log.length; i++) {
      var m = S.log[i];
      html += '<div class="msg ' + (m.role === 'user' ? 'me' : 'ai') + '">' +
        '<div class="msg-t">' + esc(m.text) + '</div></div>';
    }
    if (typing) html += '<div class="msg ai" id="ivTyping"><div class="msg-t"><span class="dots">……</span></div></div>';
    log.innerHTML = html;
    log.scrollTop = log.scrollHeight;
  }

  /** 出下一问：追问 or 下一题（AI 具体化，失败念原题） */
  function askNext(appEl) {
    var t = topic(S.topic);
    var isFollow = S.round > 0 && !topicDone(S.topic);
    var b = bankQ(S.topic, S.q);
    var bank = isFollow
      ? (b ? (b[0] + '（追问提示：' + b[1] + '）') : '顺着刚才的回答追问一层细节。')
      : (b ? b[0] : '顺着刚才聊的再问一个这个主题里的问题。');
    // AI 不在时的兜底问题：追问轮直接用追问提示（它本身就是一句具体的追问）
    var fallback = isFollow
      ? (b ? b[1] : '这件事还有哪些细节？比如时间、地点、当时的人。')
      : (b ? b[0] : '再给我讲一段这个主题里的事吧。');
    drawLog(true);
    updateProgress();
    askAI(bank, fallback, isFollow).then(function (q) {
      S.question = q;
      if (!isFollow) S.round = 0;
      pushMsg('ai', q);
      saveState();
      drawLog();
      updateProgress();
    }).catch(function () {
      drawLog();
    });
  }

  function sendAnswer(appEl) {
    var ta = document.getElementById('ivText');
    var text = ta ? String(ta.value || '').trim() : '';
    if (!text) { toast('先回答一句（打字或点 🎙 说）'); return; }
    if (text.length > 2000) { toast('一段太长（' + text.length + ' 字），拆成两段说'); return; }
    ta.value = '';
    pushMsg('user', text);
    S.round += 1;
    drawLog();
    saveState();
    // 本题已经追问满两轮 → 走下一题
    if (S.round > FOLLOW) { S.q += 1; S.round = 0; }
    if (topicDone(S.topic)) {
      var t = topic(S.topic);
      var allTopics = Q().topics;
      if (S.topic < allTopics.length - 1) {
        S.topic += 1; S.q = 0;
        toast('「' + t.n + '」问完了，进入「' + topic(S.topic).n + '」');
      } else {
        pushMsg('ai', '这一轮访谈到这里就很完整了，辛苦您讲这么多。点「结束并整理」，我把它整理成纪要。');
        drawLog();
        updateProgress();
        return;
      }
    }
    askNext(appEl);
  }

  function skipQuestion(appEl) {
    S.q += 1; S.round = 0;
    if (topicDone(S.topic)) {
      if (S.topic < Q().topics.length - 1) { S.topic += 1; S.q = 0; }
      else { toast('题库问完了，结束整理吧'); return; }
    }
    saveState();
    pushMsg('user', '（这个问题先跳过）');
    drawLog();
    askNext(appEl);
  }

  /* ---------------- 结束：纪要 + 拆条 + 批量收录 ---------------- */

  function transcript() {
    var lines = [];
    for (var i = 0; i < S.log.length; i++) {
      lines.push((S.log[i].role === 'user' ? '答：' : '问：') + S.log[i].text);
    }
    return lines.join('\n');
  }

  function endInterview(appEl) {
    if (S.log.length < 2) {
      toast('还没问几句，先聊一会儿再整理');
      return;
    }
    appEl.innerHTML = window.ML.topbar({ back: '#/', title: '访谈纪要' }) +
      '<main class="wrap narrow iv-sum-page">' +
      '<div class="boot" id="ivSumWait">正在把这段访谈整理成纪要……（说得多就多等一会儿）</div>' +
      '<div id="ivSumBody"></div></main>';

    var tr = transcript();
    window.API.ai({
      messages: [{ role: 'user', content:
        '下面是一段口述史访谈记录（问：采访者，答：讲述人）。请输出两部分，用固定分隔行隔开：\n' +
        '第一部分：访谈纪要——分主题整理，保留讲述人的原话与方言用词，不要书面腔，不要添加没有的细节，600 字以内。\n' +
        '第二部分：一行「=====」之后，输出一个 JSON 数组，把访谈里值得单独收进人生档案的内容拆成条目，' +
        '每条 {"year": 年份数字或null, "text": "以讲述人第一人称写的独立一段话（80-150字），把追问补的细节融进去"}。' +
        '只拆确实讲了的事，宁少勿滥，最多 8 条。\n\n' + tr }],
      maxTokens: 2400
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.message) || '模型没回话');
      renderSummary(appEl, String(r.text || ''));
    }).catch(function (e) {
      var box = document.getElementById('ivSumWait');
      if (box) box.textContent = '（整理没成：' + ((e && e.message) || e) + '）。' +
        '访谈原话都在档案对话记录里，可以直接复制，或点返回再试。';
      var back = document.createElement('div');
      back.className = 'row';
      back.innerHTML = '<button class="btn" id="ivSumRetry">回访谈继续</button>';
      box.parentNode.insertBefore(back, box.nextSibling);
      document.getElementById('ivSumRetry').onclick = function () {
        S.on = true; saveState(); renderSession(appEl, true);
      };
    });
  }

  function parseEntries(text) {
    var out = [];
    var sep = text.indexOf('=====');
    var jsonPart = sep >= 0 ? text.slice(sep + 5) : text;
    var m = jsonPart.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        var arr = JSON.parse(m[0]);
        if (arr && arr.length) {
          for (var i = 0; i < arr.length && i < 8; i++) {
            var it = arr[i] || {};
            var tx = String(it.text || '').trim();
            if (tx) out.push({ year: parseInt(it.year, 10) || null, text: tx });
          }
        }
      } catch (e) { /* JSON 坏了就走兜底 */ }
    }
    if (!out.length) {
      // 兜底：纪要里成段的非空行按条目算
      var body = sep >= 0 ? text.slice(0, sep) : text;
      var lines = body.split(/\n+/);
      for (var j = 0; j < lines.length && out.length < 6; j++) {
        var ln = String(lines[j] || '').replace(/^[-•\d.、\s]+/, '').trim();
        var ym = ln.match(/(1[89]\d{2}|20\d{2})\s*年/);
        if (ln.length >= 20) out.push({ year: ym ? parseInt(ym[1], 10) : null, text: ln });
      }
    }
    return out;
  }

  function renderSummary(appEl, text) {
    var sep = text.indexOf('=====');
    var minutes = (sep >= 0 ? text.slice(0, sep) : text).trim();
    var entries = parseEntries(text);
    // 访谈整理完，会话收摊
    S.on = false; clearState();

    var items = '';
    for (var i = 0; i < entries.length; i++) {
      items += '<div class="iv-item" data-i="' + i + '">' +
        '<label class="ckb chk"><input type="checkbox" class="ivCk" checked><i></i>' +
        '<span>收进档案</span></label>' +
        '<label class="iv-year">年份<input class="fi" inputmode="numeric" value="' +
        (entries[i].year || '') + '" placeholder="1975"></label>' +
        '<textarea class="fi iv-txt" rows="4">' + esc(entries[i].text) + '</textarea>' +
        '</div>';
    }

    appEl.innerHTML = window.ML.topbar({ back: '#/', title: '访谈纪要' }) +
      '<main class="wrap narrow iv-sum-page">' +
      '<div class="iv-sum"><h3>✨ 访谈纪要</h3>' +
      '<div class="iv-sum-text">' + esc(minutes).replace(/\n/g, '<br>') + '</div>' +
      '<div class="row"><button class="btn tiny" id="ivCopy">复制纪要</button></div></div>' +
      (entries.length
        ? '<h3 class="iv-split-title">拆条收进档案（<b id="ivCnt">' + entries.length + '</b> 条，可改可去）</h3>' +
          items +
          '<div class="row"><button class="btn primary" id="ivAdopt">把勾选的收进档案</button></div>'
        : '<p class="muted">这次没拆出可收录的条目，纪要可以直接复制收着。</p>') +
      '<div class="row"><button class="btn ghost" id="ivAgain">再开一场访谈</button></div>' +
      '</main>';

    document.getElementById('ivCopy').onclick = function () { copyText(minutes); };
    var again = document.getElementById('ivAgain');
    if (again) again.onclick = function () { renderSetup(appEl, {}); };

    var adoptBtn = document.getElementById('ivAdopt');
    if (adoptBtn) adoptBtn.onclick = function () {
      var boxes = appEl.querySelectorAll('.iv-item');
      var jobs = [];
      for (var k = 0; k < boxes.length; k++) {
        var ck = boxes[k].querySelector('.ivCk');
        if (!ck || !ck.checked) continue;
        var yr = parseInt(boxes[k].querySelector('.iv-year input').value, 10) || null;
        var tx = String(boxes[k].querySelector('.iv-txt').value || '').trim();
        if (!tx) continue;
        jobs.push({ archiveId: S.archiveId, year: yr, text: tx });
      }
      if (!jobs.length) { toast('先勾上要收录的条目'); return; }
      if (!jobs[0].archiveId) {
        toast('这场访谈没绑档案。回首页后用素材箱的「收进档案」选一本');
        return;
      }
      adoptBtn.disabled = true;
      adoptBtn.textContent = '收录中……';
      var chain = Promise.resolve(), done = 0;
      jobs.forEach(function (job) {
        chain = chain.then(function () {
          return window.DB.addEntryText(job.archiveId, job.year, job.text)
            .then(function () { done += 1; });
        });
      });
      chain.then(function () {
        adoptBtn.textContent = '已收录 ' + done + ' 条';
        toast('收进档案了，在待归档里排好队');
      }).catch(function (e) {
        adoptBtn.disabled = false;
        adoptBtn.textContent = '把勾选的收进档案';
        fail(e);
      });
    };
  }

  function copyText(text) {
    var done = function () { toast('已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文字'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 语音回答：原生壳优先，浏览器兜底 ---------------- */

  var R = { on: false, native: false, chunks: [], ctx: null, src: null, proc: null,
            mute: null, stream: null, started: 0, peak: 0 };

  function bindVoice(appEl) {
    var b = document.getElementById('ivVoice');
    if (!b) return;
    var can = !!(window.NativeRec || (typeof MediaRecorder !== 'undefined' &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    if (!can) {
      b.disabled = true;
      b.title = '这台设备不支持录音';
      return;
    }
    b.onclick = function () { R.on ? stopRec() : startRec(); };
  }

  function recState(t) {
    var el = document.getElementById('ivRec');
    if (el) el.textContent = t || '';
  }

  function recBtn(on) {
    var b = document.getElementById('ivVoice');
    if (!b) return;
    if (on) { b.className = 'btn tiny on'; b.textContent = '■ 停'; }
    else { b.className = 'btn tiny'; b.textContent = '🎙 说'; }
  }

  function startRec() {
    var NATIVE = window.NativeRec;
    if (NATIVE) {
      var st = '';
      try { st = String(NATIVE.state() || ''); } catch (e) { st = ''; }
      if (st.indexOf('granted') < 0) {
        window.__micPerm = function (r) {
          window.__micPerm = null;
          if (String(r) === 'granted') startRec();
          else recState('系统没放行麦克风（' + r + '），到设置里打开');
        };
        try { NATIVE.ask(); } catch (e) { window.__micPerm = null; recState('要不了权限：' + e.message); }
        return;
      }
      var name = 'iv-' + Date.now() + '.wav';
      var r = '';
      try { r = String(NATIVE.start(window.API.auth.token(), name) || ''); } catch (e) { r = 'err:' + e.message; }
      if (r.indexOf('ok') !== 0) { recState('录音开不了（' + r.replace(/^err:/, '') + '）'); return; }
      R.on = true; R.native = true; R.started = Date.now(); R.peak = 0;
      recBtn(true);
      R.tick = setInterval(function () {
        if (!R.on) return;
        var sec = 0;
        try { sec = Number(NATIVE.seconds()) || 0; } catch (e) {}
        recState('正在听…… 已录 ' + sec + ' 秒，说完点停');
      }, 500);
      return;
    }
    // 浏览器兜底（与素材箱同款链路：PCM → 16k WAV）
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { recState('这个浏览器内核太老，录不了音'); return; }
    var ctx;
    try { ctx = new AC(); } catch (e) { recState('音频通道打不开（' + e.name + '）'); return; }
    var kick = (ctx.state === 'suspended') ? ctx.resume() : Promise.resolve();
    kick.then(function () { return navigator.mediaDevices.getUserMedia({ audio: true }); })
      .then(function (stream) {
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
          recState('正在听…' + (pk < 0.01 ? '（几乎没有声音，检查麦克风）' : ''));
          if (R.chunks.length * 4096 / ctx.sampleRate > 600) stopRec();
        };
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);
        R.ctx = ctx; R.src = src; R.proc = proc; R.stream = stream; R.mute = mute;
        R.on = true;
        recBtn(true);
        recState('正在听……');
      }).catch(function () { recState('麦克风没打开'); });
  }

  function stopRec() {
    if (!R.on) return;
    R.on = false;
    recBtn(false);
    if (R.native) return stopRecNative();
    try { if (R.proc) R.proc.disconnect(); } catch (e) {}
    try { if (R.src) R.src.disconnect(); } catch (e) {}
    try { if (R.mute) R.mute.disconnect(); } catch (e) {}
    try { if (R.stream) R.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (R.ctx) R.ctx.close(); } catch (e) {}
    if (R.peak < 0.01) { recState('这段全是静音，没存。再试一次'); return; }
    var rate = R.ctx ? R.ctx.sampleRate : 48000;
    var buf = window.ML.buildWav(R.chunks, rate, 16000);
    var bytes = new Uint8Array(buf);
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    transcribeB64(btoa(bin));
  }

  function stopRecNative() {
    var NATIVE = window.NativeRec;
    if (R.tick) { clearInterval(R.tick); R.tick = 0; }
    var out = null;
    try { out = JSON.parse(String(NATIVE.stop() || '{}')); } catch (e) { out = null; }
    if (!out || !out.ok) { recState('这段没存下来：' + ((out && out.err) || '没录到')); return; }
    if (Number(out.peak) < 0.01) {
      try { NATIVE.cancel(); } catch (e) {}
      recState('这段全是静音。再录一次');
      return;
    }
    transcribePath(out.path);
  }

  function transcribeB64(b64) {
    recState('正在保存并转写……');
    window.API.file({ op: 'save', kind: 'audio', name: 'iv-' + R.started + '.wav', base64: b64 })
      .then(function (f) {
        if (!f || !f.path) throw new Error('录音没存下来');
        return window.API.asr({ path: f.path });
      })
      .then(applyAsr)
      .catch(function (e) { recState('转写没成：' + ((e && e.message) || e)); });
  }

  function transcribePath(p) {
    recState('正在转写……');
    window.API.asr({ path: p }).then(applyAsr)
      .catch(function (e) { recState('转写没成：' + ((e && e.message) || e)); });
  }

  function applyAsr(r) {
    recState('');
    if (!r || !r.ok || !r.text) { toast((r && r.message) || '没转出来'); return; }
    var ta = document.getElementById('ivText');
    if (ta) {
      ta.value = (ta.value ? ta.value + ' ' : '') + String(r.text).trim();
      ta.focus();
    }
    toast('转好了，看一眼再发送');
  }

  window.InterviewUI = { render: render };
})();
