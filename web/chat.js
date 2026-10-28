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

  var cur = { threadId: null, role: 'interviewer', streaming: null, archiveId: null, atts: [] };

  /* ---------------- 用哪个模型干活 ----------------
   * 三个用途：聊天（文字/看图）、画图、生成视频。
   * 选中的模型跟着这条消息发出去，不再受「设置里绑了哪条」限制——
   * 想用贵一点的模型写一段悼词，不必先去设置里改全局绑定。
   */
  var MODES = {
    chat: { n: '聊天', kinds: ['text', 'vision'],
      ph: '说点什么……（Ctrl+Enter 发送）' },
    img: { n: '画图', kinds: ['t2i'],
      ph: '想要什么画面？比如：1962 年的车间，天窗漏下一道光，墙上贴着红纸标语' },
    vid: { n: '视频', kinds: ['t2v'],
      ph: '要一段什么画面？写清动作、场景、镜头，比如：老人坐在竹椅上摇蒲扇，镜头缓慢推近' }
  };

  var pick = { mode: 'chat', profileId: null, model: '' };
  var modelCache = [];      // [{ pid, pname, model, kind, free }]
  var pulledOnce = false;   // 自动拉模型清单只做一次，别每次进页面都打一遍服务商

  /* ---------------- 附件：图片走视觉模型，文本类文档直接读正文 ---------------- */

  var ATT_MAX = 4;

  function isTextFile(f) {
    return /^text\//i.test(f.type || '') ||
      /\.(txt|md|markdown|csv|json|log|ini|yml|yaml|html?|xml|js|css)$/i.test(f.name || '');
  }

  /** 大图先缩到 1024，服务商收不了几 MB 的 base64 */
  function shrinkImage(file, cb) {
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

  function renderAtts(host) {
    var wrap = host.querySelector('#chatAtt');
    if (!wrap) return;
    if (!cur.atts.length) { wrap.innerHTML = ''; wrap.className = 'chat-att'; return; }
    var html = '';
    for (var i = 0; i < cur.atts.length; i++) {
      var a = cur.atts[i];
      html += '<span class="att-chip">' +
        (a.kind === 'image' ? '<img src="' + a.dataUrl + '" alt="">' : '<em>文</em>') +
        '<b>' + esc(a.name) + '</b>' +
        '<button class="att-x" data-att-del="' + i + '" title="去掉">✕</button></span>';
    }
    wrap.className = 'chat-att on';
    wrap.innerHTML = html;
  }

  function pickAtts(host) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = 'image/*,.txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml';
    inp.onchange = function () {
      var files = inp.files ? Array.prototype.slice.call(inp.files) : [];
      if (!files.length) return;
      var room = ATT_MAX - cur.atts.length;
      if (room <= 0) { toast('最多带 ' + ATT_MAX + ' 个附件'); return; }
      files = files.slice(0, room);
      var i = 0;
      (function next() {
        if (i >= files.length) { renderAtts(host); return; }
        var f = files[i++];
        if (/^image\//i.test(f.type || '')) {
          if (f.size > 12 * 1024 * 1024) { toast(f.name + ' 超过 12MB，跳过了'); return next(); }
          shrinkImage(f, function (dataUrl) {
            cur.atts.push({ kind: 'image', name: f.name, dataUrl: dataUrl });
            next();
          });
          return;
        }
        if (!isTextFile(f)) { toast(f.name + ' 不是文本或图片，先转成 txt 再传'); return next(); }
        if (f.size > 2 * 1024 * 1024) { toast(f.name + ' 太大（>2MB），截一段再传'); return next(); }
        var fr = new FileReader();
        fr.onload = function () {
          var t = String(fr.result || '');
          cur.atts.push({ kind: 'text', name: f.name, text: t.slice(0, 8000) });
          next();
        };
        fr.onerror = function () { next(); };
        fr.readAsText(f, 'utf-8');
      })();
    };
    inp.click();
  }

  /** 把附件折成模型的 messages 内容：有图就给视觉模型送 image_url */
  function userContent(text, atts) {
    var imgs = [], docs = [], i;
    for (i = 0; i < atts.length; i++) {
      if (atts[i].kind === 'image') imgs.push(atts[i]); else docs.push(atts[i]);
    }
    var parts = [];
    if (text) parts.push(text);
    for (i = 0; i < docs.length; i++) {
      parts.push('【附件：' + docs[i].name + '】\n' + docs[i].text);
    }
    var flat = parts.join('\n\n');
    if (!imgs.length) return flat;
    var arr = [{ type: 'text', text: flat || '请看看这几张图。' }];
    for (i = 0; i < imgs.length; i++) {
      arr.push({ type: 'image_url', image_url: { url: imgs[i].dataUrl } });
    }
    return arr;
  }

  /* ---------------- 模型选择栏 ---------------- */

  function buildModelCache(profiles) {
    var out = [], seen = {}, i, j;
    for (i = 0; i < profiles.length; i++) {
      var pf = profiles[i];
      if (Number(pf.enabled) !== 1) continue;
      var ms = [];
      try { ms = JSON.parse(pf.models_json || '[]'); } catch (e) { ms = []; }
      if (pf.default_model) ms = [pf.default_model].concat(ms);
      for (j = 0; j < ms.length; j++) {
        var mid = String(ms[j] || '');
        if (!mid) continue;
        var key = pf.id + '|' + mid;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ pid: pf.id, pname: pf.name, model: mid,
          kind: DB.modelKind(mid), free: DB.isFreeModel(mid) });
      }
    }
    return out;
  }

  function savePick() {
    try { DB.saveSetting('chat.model', JSON.stringify(pick)); } catch (e) {}
  }

  function loadModels(host) {
    var after = function () {
      DB.getSettings().then(function (cfg) {
        try {
          var o = JSON.parse(cfg['chat.model'] || '{}');
          if (o && o.mode && MODES[o.mode]) pick.mode = o.mode;
          if (o && o.profileId) pick.profileId = o.profileId;
          if (o && o.model) pick.model = o.model;
        } catch (e) {}
        return DB.listProfiles();
      }).then(function (profiles) {
        modelCache = buildModelCache(profiles);
        renderModelBar(host);
      }).catch(function () {});
    };

    DB.listProfiles().then(function (profiles) {
      // 一条模型都没拉过的配置，顺手拉一次：不然下拉里空空，用户以为没得选
      var need = [], i;
      for (i = 0; i < profiles.length; i++) {
        var ms = [];
        try { ms = JSON.parse(profiles[i].models_json || '[]'); } catch (e) {}
        if (!ms.length && Number(profiles[i].enabled) === 1) need.push(profiles[i].id);
      }
      if (!need.length || pulledOnce) { after(); return; }
      pulledOnce = true;
      var chain = Promise.resolve();
      need.slice(0, 3).forEach(function (pid) {
        chain = chain.then(function () { return API.aiModels(pid).catch(function () {}); });
      });
      chain.then(after, after);
    }).catch(after);
  }

  function renderModelBar(host) {
    var bar = host.querySelector('#chatModel');
    if (!bar) return;
    var m = MODES[pick.mode] || MODES.chat;
    var list = [], i;
    for (i = 0; i < modelCache.length; i++) {
      if (m.kinds.indexOf(modelCache[i].kind) !== -1) list.push(modelCache[i]);
    }

    var tabs = '';
    for (var k in MODES) {
      if (!Object.prototype.hasOwnProperty.call(MODES, k)) continue;
      tabs += '<button class="cm-tab' + (pick.mode === k ? ' on' : '') +
        '" data-cm-mode="' + k + '">' + MODES[k].n + '</button>';
    }

    var selVal = pick.model ? (pick.profileId + '|' + pick.model) : '';
    var opts = '<option value=""' + (pick.model ? '' : ' selected') + '>自动（按设置里绑的）</option>';
    var hasSel = !pick.model;
    for (i = 0; i < list.length; i++) {
      var it = list[i], v = it.pid + '|' + it.model;
      if (v === selVal) hasSel = true;
      // 下拉里只写模型名最后一段（deepseek-ai/DeepSeek-V3.2 → DeepSeek-V3.2）：
      // 手机屏幕上全名会被截成半截，反而看不出是哪个
      var short = String(it.model).split('/').pop();
      opts += '<option value="' + esc(v) + '"' + (v === selVal ? ' selected' : '') + '>' +
        esc(short) + ' · ' + esc(it.pname) + (it.free ? ' · 免费' : ' · 付费') + '</option>';
    }
    // 存过的模型这次没在清单里（换过 Key、没拉到），也别悄悄丢掉
    if (!hasSel && pick.model) {
      opts += '<option value="' + esc(selVal) + '" selected>' + esc(pick.model) + ' · 已选</option>';
    }
    opts += '<option value="__custom">＋ 手填模型名……</option>';

    var note;
    if (pick.mode === 'chat') {
      note = pick.model
        ? ('用 ' + pick.model + '（' + (DB.isFreeModel(pick.model) ? '免费' : '按 token 计费，长对话会贵一些') + '）')
        : '用「设置 → 各环节用哪个模型」里绑的那条；想换更聪明的模型，在上面选一个';
    } else if (pick.mode === 'img') {
      note = (pick.model ? pick.model + ' · ' : '') +
        '画一张通常 4–10 秒。免费的只有 Kolors，付费的（FLUX、Qwen-Image 等）画质更好';
    } else {
      note = (pick.model ? pick.model + ' · ' : '') +
        '一条一般 1–4 分钟，按条计费。交出去后关掉页面也会继续跑，做完在档案首页「合成的片子」里';
    }

    bar.innerHTML =
      '<div class="cm-row">' +
      '<div class="cm-tabs">' + tabs + '</div>' +
      '<select class="fi cm-sel" id="cmSel">' + opts + '</select>' +
      '<button class="btn tiny ghost" id="cmRefresh" title="重新向服务商拉一次模型清单">刷新</button>' +
      '</div>' +
      '<div class="cm-note">' + esc(note) + '</div>' +
      (list.length ? '' : '<div class="cm-empty">这个用途还没有可用模型。' +
        '<a href="#/settings" class="linkbtn">去设置里加一条 →</a></div>');

    var ta = host.querySelector('#chatText');
    if (ta) ta.setAttribute('placeholder', m.ph);
  }

  function bindModelBar(host) {
    var bar = host.querySelector('#chatModel');
    if (!bar) return;

    bar.addEventListener('click', function (ev) {
      if (!ev.target.closest) return;
      var t = ev.target.closest('[data-cm-mode]');
      if (t) {
        var mode = t.getAttribute('data-cm-mode');
        if (!MODES[mode] || mode === pick.mode) return;
        pick.mode = mode;
        // 换了用途，原来那个模型多半不是这一类的，先清掉（同类就留着）
        if (pick.model && MODES[mode].kinds.indexOf(DB.modelKind(pick.model)) === -1) {
          pick.model = ''; pick.profileId = null;
        }
        savePick();
        renderModelBar(host);
        return;
      }
      var rf = ev.target.closest('#cmRefresh');
      if (rf) {
        rf.disabled = true;
        rf.textContent = '拉取中';
        DB.listProfiles().then(function (profiles) {
          var chain = Promise.resolve();
          profiles.forEach(function (pf) {
            if (Number(pf.enabled) !== 1) return;
            chain = chain.then(function () { return API.aiModels(pf.id).catch(function () {}); });
          });
          return chain;
        }).then(function () { return DB.listProfiles(); })
          .then(function (ps) {
            modelCache = buildModelCache(ps);
            renderModelBar(host);
            toast('模型清单已更新');
          }).catch(function () { renderModelBar(host); });
      }
    });

    bar.addEventListener('change', function (ev) {
      var s = ev.target;
      if (!s || s.id !== 'cmSel') return;
      var v = String(s.value || '');
      if (v === '__custom') {
        var name = String(window.prompt('填服务商那边的模型 ID（照模型广场上写的那样）', pick.model || '') || '').trim();
        if (!name) { renderModelBar(host); return; }
        var pid = pick.profileId;
        if (!pid && modelCache.length) pid = modelCache[0].pid;
        pick.profileId = pid;
        pick.model = name;
        // 手填的也放进候选，下次打开还能看见
        var kd = DB.modelKind(name);
        if (MODES[pick.mode].kinds.indexOf(kd) === -1) kd = MODES[pick.mode].kinds[0];
        modelCache.push({ pid: pid, pname: '手填', model: name, kind: kd, free: DB.isFreeModel(name) });
        savePick();
        renderModelBar(host);
        return;
      }
      if (!v) { pick.profileId = null; pick.model = ''; }
      else {
        var parts = v.split('|');
        pick.profileId = Number(parts[0]);
        pick.model = parts.slice(1).join('|');
      }
      savePick();
      renderModelBar(host);
    });

    loadModels(host);
  }

  /* ---------------- 画图 / 生成视频：同一个输入框，换个干活的模型 ---------------- */

  function pushAI(host, placeholder) {
    var log = host.querySelector('#chatLog');
    if (!log) return null;
    var node = document.createElement('div');
    node.innerHTML = bubble('assistant', '');
    var aiEl = node.firstChild;
    var ops = aiEl.querySelector('.msg-ops');
    if (ops) aiEl.removeChild(ops);      // 图/片子没法"插入档案"，给它一个真正的存进档案按钮
    log.appendChild(aiEl);
    var tEl = aiEl.querySelector('.msg-t');
    tEl.innerHTML = '<span class="dots">' + esc(placeholder || '……') + '</span>';
    log.scrollTop = log.scrollHeight;
    return { log: log, aiEl: aiEl, tEl: tEl };
  }

  /** 图/视频这类不走对话的消息，也在对话记录里留一笔，翻历史时不至于断片 */
  function logMedia(userText, aiText) {
    var ensure = cur.threadId ? Promise.resolve(cur.threadId)
      : DB.createThread(cur.archiveId, cur.role, String(userText || '生成').slice(0, 18))
        .then(function (id) { cur.threadId = id; return id; });
    ensure.then(function (tid) {
      return DB.addMessage(tid, 'user', userText || '（生成）');
    }).then(function () {
      return DB.addMessage(cur.threadId, 'assistant', aiText);
    }).catch(function () {});
  }

  function clearInput(host) {
    var te = host.querySelector('#chatText');
    if (te) te.value = '';
    cur.atts = [];
    renderAtts(host);
  }

  function doImage(host, text, atts, extra, again) {
    var prompt = text || '';
    if (extra) prompt = prompt ? (prompt + '\n' + extra) : extra;
    var ref = null, i;
    for (i = 0; i < atts.length; i++) if (atts[i].kind === 'image') { ref = atts[i]; break; }
    if (!prompt && ref) prompt = '照着这张照片画一幅';
    if (!prompt) { toast('写一句画面描述吧'); return; }

    clearInput(host);
    var ui = pushAI(host, '正在画……');
    if (!ui) return;
    ui.tEl.textContent = again ? '重新画一张……（大概 4–10 秒）' : '正在画……（一般 4–10 秒）';

    var o = { prompt: prompt, size: '1024x1024' };
    if (pick.profileId) o.profileId = pick.profileId;
    if (pick.model) o.model = pick.model;
    if (ref) o.refImage = ref.dataUrl;
    if (again) o.again = 1;      // 绕过缓存：同一句话也能再画一版

    API.image(o).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.message) || '没画出来');
      // 同一个描述缓存的是同一个文件名，加个时间戳免得浏览器拿旧图
      var url = ML.fsrc ? ML.fsrc(r.path) : ('/files/' + r.path);
      url += (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      ui.tEl.innerHTML =
        '<img class="chat-img" src="' + esc(url) + '" alt="AI 生成的图">' +
        '<div class="chat-media-ops">' +
        '<a class="linkbtn" href="' + esc(url) + '" download>下载</a>' +
        '<button class="linkbtn" data-save-media="1">存进档案</button>' +
        '<button class="linkbtn" data-redraw="1">重画一张</button></div>' +
        '<div class="chat-note">' +
        esc(r.note || (r.cached ? '这张是之前画过的，直接给你（没重复扣费）。想换个样子就点「重画一张」' : '')) + '</div>';
      var b = ui.tEl.querySelector('[data-save-media]');
      if (b) b.onclick = function () { saveToArchive('photo', r.path, r.bytes || 0, prompt, b); };
      var rd = ui.tEl.querySelector('[data-redraw]');
      if (rd) rd.onclick = function () { doImage(host, prompt, [], '', true); };
      logMedia(prompt, '（画了一张图：' + r.path + '）');
    }).catch(function (e) {
      ui.tEl.textContent = '（没画出来：' + ((e && e.message) || e) + '）';
    });
  }

  function doVideo(host, text, atts, extra) {
    var prompt = text || '';
    if (extra) prompt = prompt ? (prompt + '\n' + extra) : extra;
    var ref = null, i;
    for (i = 0; i < atts.length; i++) if (atts[i].kind === 'image') { ref = atts[i]; break; }
    if (!prompt && ref) prompt = '让这张照片里的人动起来，镜头缓慢推近';
    if (!prompt) { toast('写一句画面描述吧'); return; }

    clearInput(host);
    var ui = pushAI(host, '正在排任务……');
    if (!ui) return;

    var payload = { prompt: prompt, size: '720x1280' };
    if (pick.profileId) payload.profileId = pick.profileId;
    if (pick.model) payload.model = pick.model;
    if (cur.archiveId) payload.archiveId = cur.archiveId;

    var start = function () {
      ui.tEl.textContent = '已交给服务商，排队中……';
      API.job.create('aivideo', payload).then(function (r) {
        if (!r || !r.id) throw new Error((r && r.message) || '任务没排上');
        pollVideo(r.id, ui, prompt, redo);
      }).catch(function (e) {
        ui.tEl.textContent = '（没排上：' + ((e && e.message) || e) + '）';
      });
    };

    // 同一句描述默认复用上次的成片（不重复扣费）；想换个版本点「再来一版」
    var redo = function () {
      payload.again = 1;
      ui.tEl.textContent = '再来一版……';
      API.job.create('aivideo', payload).then(function (r) {
        if (!r || !r.id) throw new Error((r && r.message) || '任务没排上');
        pollVideo(r.id, ui, prompt, redo);
      }).catch(function (e) {
        ui.tEl.textContent = '（没排上：' + ((e && e.message) || e) + '）';
      });
    };

    if (ref) {
      var raw = String(ref.dataUrl || '');
      var comma = raw.indexOf(',');
      ui.tEl.textContent = '正在上传参考图……';
      API.file({ op: 'save', dir: 'video-src', name: 'v' + Date.now() + '.jpg',
        base64: comma > 0 ? raw.slice(comma + 1) : raw })
        .then(function (f) {
          if (!f || !f.ok) throw new Error((f && f.message) || '参考图没存下来');
          payload.imagePath = f.path;
          start();
        }).catch(function (e) {
          ui.tEl.textContent = '（参考图没传上去：' + ((e && e.message) || e) + '）';
        });
      return;
    }
    start();
  }

  function pollVideo(id, ui, prompt, redo) {
    var t0 = Date.now();
    var timer = setInterval(function () {
      API.job.get(id).then(function (r) {
        var j = r && r.job;
        if (!j) { clearInterval(timer); return; }
        var secs = Math.round((Date.now() - t0) / 1000);
        var pct = Math.round((Number(j.progress) || 0) * 100);
        // 兜底：万一是任务丢了状态，别无限轮询把页面拖住
        if (secs > 900) {
          clearInterval(timer);
          ui.tEl.textContent = '（等了 15 分钟还没出片，去「设置 → 用量与任务」看看这条任务）';
          return;
        }
        if (j.status === 'done' && j.result && j.result.path) {
          clearInterval(timer);
          var res = j.result;
          var url = ML.fsrc ? ML.fsrc(res.path) : ('/files/' + res.path);
          var size = ML.bytes ? ML.bytes(res.bytes) : (Math.round((res.bytes || 0) / 1024) + ' KB');
          ui.tEl.innerHTML =
            '<video class="chat-video" controls playsinline preload="metadata" src="' + esc(url) + '"></video>' +
            '<div class="chat-media-ops">' +
            '<a class="linkbtn" href="' + esc(url) + '" download>下载 mp4</a>' +
            (res.archiveId
              ? '<span class="chat-ok">已存进档案 · 档案首页「合成的片子」</span>'
              : '<button class="linkbtn" data-save-media="1">存进档案</button>') +
            '<button class="linkbtn" data-vid-again="1">再来一版（重新计费）</button></div>' +
            '<div class="chat-note">' + esc(String(res.model || '')) + ' · ' + size +
            (res.cached ? ' · 这段描述之前做过，直接给你（没重复扣费）' : '') + '</div>';
          var b = ui.tEl.querySelector('[data-save-media]');
          if (b) b.onclick = function () { saveToArchive('video', res.path, res.bytes || 0, prompt, b); };
          var ag = ui.tEl.querySelector('[data-vid-again]');
          if (ag && redo) ag.onclick = function () { redo(); };
          logMedia(prompt, '（生成了一段视频：' + res.path + '）');
          return;
        }
        if (j.status === 'failed' || j.status === 'canceled') {
          clearInterval(timer);
          ui.tEl.textContent = '（没做成：' + (j.error || (j.status === 'canceled' ? '已取消' : '失败')) + '）';
          return;
        }
        ui.tEl.innerHTML = '<span class="dots">' + esc(j.stage || '排队中') + ' · ' + pct + '% · ' +
          secs + ' 秒' + (secs > 60 ? '（一般 1–4 分钟，可以先干别的）' : '') + '</span>';
      }).catch(function () {});
    }, 2500);
  }

  /** 把 AI 产的图/片子落进档案：图进「待归档照片」，片子进「合成的片子」 */
  function saveToArchive(kind, filePath, bytes, caption, btn) {
    var doIt = function (aid) {
      var sql, params;
      if (kind === 'photo') {
        sql = 'INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)';
        params = [aid, filePath, null, 'AI 插图', String(caption || 'AI 插图').slice(0, 40)];
      } else {
        sql = 'INSERT INTO media (archive_id,kind,path,mime,bytes,caption) VALUES (?,?,?,?,?,?)';
        params = [aid, 'video', filePath, 'video/mp4', bytes || null, String(caption || 'AI 视频').slice(0, 120)];
      }
      API.exec(sql, params).then(function () {
        if (btn) { btn.textContent = '已存进档案'; btn.disabled = true; }
        toast(kind === 'photo'
          ? '存进档案了，在「待归档照片」里能看到'
          : '存进档案了，在档案首页「合成的片子」里');
      }).catch(fail);
    };
    if (cur.archiveId) { doIt(cur.archiveId); return; }
    pickArchive(function (aid) { doIt(aid); });
  }

  /** 上次没等完就走了：回来提一句它在后台继续跑 */
  function noticeRunningVideos(host) {
    API.job.list().then(function (r) {
      var n = 0, items = (r && r.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type === 'aivideo' && (items[i].status === 'queued' || items[i].status === 'running')) n++;
      }
      if (!n) return;
      var log = host.querySelector('#chatLog');
      if (log) log.innerHTML += '<div class="chat-sys">有 ' + n +
        ' 条视频还在后台生成。做完会出现在档案首页「合成的片子」里，不用守在这里。</div>';
    }).catch(function () {});
  }

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
        '<section class="chat-model" id="chatModel"></section>' +
        '<section class="chat-log" id="chatLog"></section>' +
        '<section class="chat-in">' +
        '<div class="chat-priv" id="chatPriv"></div>' +
        '<div class="chat-opt">' +
        (a ? '<label class="ckb chk"><input type="checkbox" id="chatRefs" checked><i></i>' +
          '<span>带上档案原文做参考</span></label>' : '') +
        '<input class="fi" id="chatExtra" placeholder="附加要求（可选），如：只写 300 字 / 保留方言 / 别用套话">' +
        '</div>' +
        '<div class="chat-att" id="chatAtt"></div>' +
        '<textarea class="say mini" id="chatText" rows="2" placeholder="说点什么……（Ctrl+Enter 发送）"></textarea>' +
        '<div class="chat-acts">' +
        '<button class="btn tiny" id="chatVoice">🎙 说</button>' +
        '<button class="btn tiny" id="chatFile">📎 附件</button>' +
        '<button class="btn tiny" id="chatNew">新对话</button>' +
        '<button class="btn tiny primary" id="chatSend">发送</button>' +
        '</div></section></main>';

      renderRoles(host);
      bind(host, archiveId, a);
      // 日志先渲染完再加提示，否则会被 loadThread 的 innerHTML 冲掉
      Promise.resolve(loadThread(host)).then(function () { noticeRunningVideos(host); });
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
      return Promise.resolve();
    }
    return DB.messages(cur.threadId).then(function (list) {
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
    var attWrap = host.querySelector('#chatAtt');

    host.querySelector('#chatFile').addEventListener('click', function () { pickAtts(host); });
    bindModelBar(host);
    if (attWrap) {
      attWrap.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-att-del]') : null;
        if (!b) return;
        cur.atts.splice(Number(b.getAttribute('data-att-del')), 1);
        renderAtts(host);
      });
    }

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
      var atts = cur.atts.slice();
      if (!text && !atts.length) return;
      if (cur.streaming) { toast('上一条还在写'); return; }

      var refsChk = host.querySelector('#chatRefs');
      var extraEl = host.querySelector('#chatExtra');
      var includeRefs = refsChk ? !!refsChk.checked : true;
      var extra = extraEl ? String(extraEl.value || '').trim() : '';
      var hasImg = false, i0;
      for (i0 = 0; i0 < atts.length; i0++) if (atts[i0].kind === 'image') hasImg = true;

      // 换个干活的模型：画图、做视频，都不走对话接口
      if (pick.mode === 'img') { doImage(host, text, atts, extra); return; }
      if (pick.mode === 'vid') { doVideo(host, text, atts, extra); return; }
      if (hasImg && pick.model && DB.modelKind(pick.model) === 'text') {
        toast('选中的这个模型不看图，换成「看图」类的更稳');
      }

      textEl.value = '';
      cur.atts = [];
      renderAtts(host);
      updatePriv();

      var shown = text || '（附件）';
      var stored = text + (atts.length ? '\n（附 ' + atts.length + ' 个文件：' +
        atts.map(function (x) { return x.name; }).join('、') + '）' : '');

      var ensure = cur.threadId ? Promise.resolve(cur.threadId)
        : DB.createThread(archiveId, cur.role, shown.slice(0, 18)).then(function (id) {
            cur.threadId = id; return id;
          });

      ensure.then(function (tid) {
        log.innerHTML += bubble('user', shown + (atts.length ? '　＋' + atts.length + ' 附件' : ''));
        var node = document.createElement('div');
        node.innerHTML = bubble('assistant', '');
        var aiEl = node.firstChild;
        log.appendChild(aiEl);
        var tEl = aiEl.querySelector('.msg-t');
        tEl.innerHTML = '<span class="dots">…</span>';
        log.scrollTop = log.scrollHeight;

        return DB.addMessage(tid, 'user', stored).then(function () {
          return buildContext(archiveId, text, includeRefs);
        }).then(function (ctx) {
          var sys = ROLES[cur.role].sys + '\n\n' + ctx.system + (extra ? '\n\n用户补充要求：' + extra : '') +
            (atts.length ? '\n\n用户这次还带了 ' + atts.length + ' 个附件（图片或文档），请直接依据附件内容回答，不要假装看不到。' : '');
          var msgs = [{ role: 'system', content: sys }];
          return DB.messages(tid).then(function (hist) {
            for (var i = 0; i < hist.length; i++) {
              if (hist[i].role === 'user' || hist[i].role === 'assistant') {
                msgs.push({ role: hist[i].role, content: hist[i].content });
              }
            }
            msgs.push({ role: 'user', content: userContent(text, atts) });

            var acc = '';
            var streamErr = null;
            var req = { messages: msgs };
            // 选定了模型就按它走；没选才回落到「看照片」那一环
            if (pick.profileId && pick.model) {
              req.profileId = pick.profileId;
              req.model = pick.model;
            } else if (hasImg) {
              req.slot = 'vision';
            }
            cur.streaming = API.chatStream(req, function (evt) {
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
              return API.ai((function () {
                var fb = { messages: msgs };
                if (pick.profileId && pick.model) { fb.profileId = pick.profileId; fb.model = pick.model; }
                else if (hasImg) { fb.slot = 'vision'; }
                return fb;
              })()).then(function (r) {
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
