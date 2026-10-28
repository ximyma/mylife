/**
 * 短片：把一章口述做成竖屏小片。
 *
 * 定位是「能发朋友圈、能发抖音的一分钟」，不是电影：
 *   · 画面 = 档案里的插图与照片 + 缓慢运镜，不调视频模型（一秒几块钱，不值）
 *   · 声音 = 配音（可选）+ 程序化和弦垫（不占体积、不涉版权）
 *   · 字幕烧进画面，发出去就能看，不用挂 srt
 *
 * 渲染在服务端做，走任务队列：几十秒到几分钟的活挂不住 HTTP 请求。
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
  function bytes(n) { return ML.bytes ? ML.bytes(n) : (n + ' B'); }

  var BGM = [
    { k: 'none', n: '不配乐' },
    { k: 'calm', n: '安静（C 和弦）' },
    { k: 'warm', n: '温暖（F 和弦）' },
    { k: 'old', n: '旧时光（D 小调）' },
    { k: 'bright', n: '明亮（A 和弦）' },
  ];

  var state = { archiveId: 0, plan: null, jobId: 0, ticker: null, ffmpeg: false };

  function render(host, archiveId) {
    state.archiveId = archiveId;

    Promise.all([
      API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
      API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [archiveId]),
      API.renderProbe().catch(function () { return { ok: false }; }),
    ]).then(function (r) {
      var a = r[0][0], chapters = r[1], probe = r[2];
      if (!a) throw new Error('找不到这本档案');
      state.ffmpeg = !!(probe && probe.ok);

      if (!chapters.length) {
        host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '短片' }) +
          '<main class="wrap"><p class="muted">这本档案还没有章节。先在档案页点「生成卷宗」。</p></main>';
        return;
      }

      var preCh = (window.ML && ML.qs) ? ML.qs('ch') : '';
      var opts = '<option value="">整本（全部章节）</option>' + chapters.map(function (c, i) {
        return '<option value="' + c.id + '"' +
          (String(c.id) === String(preCh) ? ' selected' : '') + '>' +
          esc(c.title || ('第 ' + (i + 1) + ' 章')) + '</option>';
      }).join('');

      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '短片' }) +
        '<main class="wrap">' +
        '<section class="tl-hd"><h1 class="h1">把档案做成竖屏小片</h1>' +
        '<p class="muted">片长由内容决定，不再卡在一分钟：一段口述可能拆成几格，字幕烧进画面，导出就是竖屏 mp4。' +
        '合成好的片子会存进这本档案——档案首页「合成的片子」和本页顶部「合成过的」都能找到。</p></section>' +

        (state.ffmpeg ? '' :
          '<p class="tip-warn">这个安装包里没有渲染引擎（ffmpeg），只能排分镜、不能合成。' +
          '桌面版已内置；安卓上做不到，请在电脑上合成。</p>') +

        '<section class="art-set">' +
        '<div class="art-row">' +
        '<select class="fi" id="mvCh" style="max-width:230px">' + opts + '</select>' +
        '<button class="btn" id="mvPlan">排分镜</button>' +
        '</div>' +
        '<p class="hint dim">选「整本」是全部章节按顺序排下来，格子多、合成久，建议先在电脑上做。</p>' +
        '</section>' +

        '<section id="mvHist"></section>' +
        '<section id="mvBody"></section>' +
        '</main>';

      host.querySelector('#mvPlan').onclick = function () {
        var sel = host.querySelector('#mvCh').value;
        var chId = sel ? Number(sel) : 0;
        var body = host.querySelector('#mvBody');
        body.innerHTML = '<div class="boot">正在排分镜……</div>';
        API.moviePlan({ archiveId: archiveId, chapterId: chId }).then(function (p) {
          state.plan = p;
          paint(body, p, a);
        }).catch(function (e) {
          body.innerHTML = '<p class="muted">' + esc(e.message || e) + '</p>';
        });
      };

      showHistory(host.querySelector('#mvHist'), archiveId);
    }).catch(function (e) {
      host.innerHTML = ML.topbar({ back: '#/a/' + archiveId, title: '短片' }) +
        '<main class="wrap"><p class="muted">' + esc(e.message || e) + '</p></main>';
    });
  }

  function paint(body, plan, a) {
    var frames = plan.frames || [];
    var total = frames.reduce(function (s, f) { return s + (Number(f.sec) || 3); }, 0);

    var rows = frames.map(function (f, i) {
      return '<div class="mv-frame" data-i="' + i + '">' +
        '<div class="mv-thumb">' +
        (f.image ? '<img src="' + esc(fsrc(f.image)) + '" alt="">' : '<span>缺图</span>') +
        '</div>' +
        '<div class="mv-meta">' +
        '<textarea class="mv-text" data-i="' + i + '" rows="2">' + esc(f.text || '') + '</textarea>' +
        '<div class="mv-line">' +
        '<label>时长 <input type="number" class="mv-sec" data-i="' + i + '" min="1" max="15" step="0.5" value="' +
        (Number(f.sec) || 3) + '"> 秒</label>' +
        (f.year ? '<span class="muted">' + esc(f.year) + ' 年</span>' : '') +
        '</div></div></div>';
    }).join('');

    body.innerHTML =
      '<section class="mv-bar">' +
      '<b>' + esc(plan.title) + '</b>' +
      '<span class="muted">' + frames.length + ' 格 · 约 ' + Math.round(total) + ' 秒（' +
      Math.max(1, Math.round(total / 60)) + ' 分钟）' +
      (plan.missing ? ' · ' + plan.missing + ' 格缺图' : '') + '</span>' +
      '</section>' +

      (plan.truncated ? '<p class="tip-warn">内容太多，只排了前 ' + frames.length +
        ' 格（约 ' + Math.round(total / 60) + ' 分钟）。想全做，分几次按章做，或多生成几条。' +
        (plan.truncated > 0 ? '' : '') + '</p>' : '') +

      '<section class="art-set">' +
      '<div class="art-row">' +
      '<label class="mv-ck"><input type="checkbox" id="mvVoice"><span>配音<span class="muted">按句合成，需先配朗读模型</span></span></label>' +
      '</div>' +
      '<div class="art-row">' +
      '<label class="mv-f"><span>配乐</span><select class="fi" id="mvBgm">' +
      BGM.map(function (b) { return '<option value="' + b.k + '">' + esc(b.n) + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mv-f short"><span>语速</span><input class="fi" type="number" id="mvSpeed" min="0.6" max="1.4" step="0.1" value="1"></label>' +
      '</div>' +
      '<div class="art-row"><button class="btn primary" id="mvGo"' + (state.ffmpeg ? '' : ' disabled') +
      '>开始合成</button>' +
      '<span class="muted" id="mvTip">合成期间可以关掉这个页面，任务在后台跑</span></div>' +
      '</section>' +

      (plan.missing ? '<p class="tip-warn">有 ' + plan.missing +
        ' 格没有图，会渲染成深色底 + 字幕。去「插图」补几张会好看很多。</p>' : '') +

      '<section class="mv-list">' + rows + '</section>' +
      '<section id="mvProg"></section>';

    // 改文字/时长直接改内存里的 plan，合成时一起提交
    var tas = body.querySelectorAll('.mv-text');
    for (var i = 0; i < tas.length; i++) {
      tas[i].oninput = function () {
        var k = Number(this.getAttribute('data-i'));
        frames[k].text = this.value;
      };
    }
    var secs = body.querySelectorAll('.mv-sec');
    for (var j = 0; j < secs.length; j++) {
      secs[j].oninput = function () {
        var k = Number(this.getAttribute('data-i'));
        frames[k].sec = Math.max(1, Number(this.value) || 3);
      };
    }

    body.querySelector('#mvGo').onclick = function () {
      if (!state.ffmpeg) { toast('这个包里没有 ffmpeg'); return; }
      var payload = {
        archiveId: state.archiveId,
        title: plan.title,
        frames: frames.map(function (f) {
          return { image: f.image, text: f.text, sec: Number(f.sec) || 3 };
        }),
        voice: !!body.querySelector('#mvVoice').checked,
        bgm: body.querySelector('#mvBgm').value,
        speed: Number(body.querySelector('#mvSpeed').value) || 1,
      };
      startJob(body, payload);
    };
  }

  function startJob(body, payload) {
    var prog = body.querySelector('#mvProg');
    body.querySelector('#mvGo').disabled = true;
    prog.innerHTML = '<div class="job-box"><div class="job-stage">排队中…</div>' +
      '<div class="job-bar"><i style="width:2%"></i></div>' +
      '<button class="linkbtn danger-t" id="mvCancel">取消</button></div>';

    API.job.create('movie', payload).then(function (r) {
      state.jobId = r.id;
      var bar = prog.querySelector('.job-bar i');
      var stage = prog.querySelector('.job-stage');

      prog.querySelector('#mvCancel').onclick = function () {
        API.job.cancel(state.jobId).then(function () { tick(); });
      };

      function tick() {
        API.job.get(state.jobId).then(function (res) {
          var j = res.job;
          if (!j) return;
          var pct = Math.round((Number(j.progress) || 0) * 100);
          bar.style.width = Math.max(2, pct) + '%';
          stage.textContent = (j.stage || '处理中') + ' · ' + pct + '%';

          if (j.status === 'done') {
            state.ticker && clearInterval(state.ticker);
            body.querySelector('#mvGo').disabled = false;
            var r2 = j.result || {};
            prog.innerHTML =
              '<div class="mv-done">' +
              '<video class="mv-video" controls playsinline src="' + esc(fsrc(r2.path)) + '"></video>' +
              '<div class="mv-line"><b>做好了</b><span class="muted">' +
              esc(r2.seconds || '') + ' 秒 · ' + bytes(r2.bytes) + '</span></div>' +
              '<div class="art-row"><a class="btn tiny" href="' + esc(fsrc(r2.path)) +
              '" download>下载 mp4</a>' +
              '<button class="btn tiny" id="mvAgain">再合成一次</button></div>' +
              '<p class="hint dim">成片存在这本档案里：档案首页 →「合成的片子」，或本页顶部「合成过的」。' +
              '关掉网页、换个设备回来都还在，随档案一起备份。</p>' +
              '</div>';
            prog.querySelector('#mvAgain').onclick = function () {
              prog.innerHTML = '';
              startJob(body, payload);
            };
            // 刚出来的这条立刻进「合成过的」，不用刷新页面
            var hist = document.querySelector('#mvHist');
            if (hist) showHistory(hist, state.archiveId);
            return;
          }
          if (j.status === 'failed' || j.status === 'canceled') {
            state.ticker && clearInterval(state.ticker);
            body.querySelector('#mvGo').disabled = false;
            prog.innerHTML = '<p class="tip-warn">' +
              (j.status === 'canceled' ? '已取消。' : '没合成成功：' + esc(j.error || '未知原因')) +
              '</p>';
            return;
          }
        }).catch(function () {});
      }

      state.ticker && clearInterval(state.ticker);
      state.ticker = setInterval(tick, 900);
      tick();
    }).catch(function (e) {
      body.querySelector('#mvGo').disabled = false;
      prog.innerHTML = '<p class="tip-warn">' + esc(e.message || e) + '</p>';
    });
  }

  /**
   * 合成过的片子从哪儿来：
   *   ① 档案的 media 表（v0.9.5 起，成片登记成档案资产，关掉页面、换设备回来都在）；
   *   ② 老版本合成的只留在任务记录里，按 jobs 兜底补上，别让人以为丢了。
   */
  function showHistory(body, archiveId) {
    Promise.all([
      API.query("SELECT path, bytes, duration_ms, caption FROM media WHERE archive_id=? AND kind='movie' ORDER BY id DESC", [archiveId])
        .catch(function () { return []; }),
      API.job.list().catch(function () { return { items: [] }; }),
    ]).then(function (r) {
      var list = [], seen = {}, i;
      var rows = r[0] || [];
      for (i = 0; i < rows.length; i++) {
        seen[rows[i].path] = 1;
        list.push({
          path: rows[i].path,
          seconds: Math.round((Number(rows[i].duration_ms) || 0) / 1000) || '',
          bytes: rows[i].bytes,
          caption: rows[i].caption || '',
        });
      }
      var items = (r[1] && r[1].items) || [];
      for (i = 0; i < items.length; i++) {
        var j = items[i];
        if (j.type !== 'movie' || j.status !== 'done' || !j.result || !j.result.path) continue;
        if (seen[j.result.path]) continue;
        seen[j.result.path] = 1;
        list.push({
          path: j.result.path, seconds: j.result.seconds || '',
          bytes: j.result.bytes, caption: '早先合成的',
        });
      }
      list = list.slice(0, 12);
      if (!list.length) return;

      var html = '<section class="mv-hist"><div class="mv-line" style="justify-content:space-between">' +
        '<h2 class="sec-label" style="margin:0">合 成 过 的</h2>' +
        '<span class="muted">存在这本档案里，点下载能存到手机</span></div><div class="mv-hist-list">';
      list.forEach(function (x) {
        html += '<div class="mv-hist-item"><video preload="metadata" playsinline controls src="' +
          esc(fsrc(x.path)) + '"></video><div class="mv-line"><span class="muted">' +
          esc(x.seconds || '') + (x.seconds ? ' 秒' : '') +
          (x.bytes ? ' · ' + bytes(x.bytes) : '') + '</span>' +
          '<a class="linkbtn" href="' + esc(fsrc(x.path)) + '" download>下载</a></div>' +
          (x.caption ? '<div class="mv-cap">' + esc(String(x.caption).slice(0, 40)) + '</div>' : '') +
          '</div>';
      });
      html += '</div></section>';
      body.innerHTML = html;
    }).catch(function () {});
  }

  window.MovieUI = { render: render };
})();
