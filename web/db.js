/**
 * 全部业务：SQL 与生成规则都在这里，只此一份。
 * 后端（Java / Node）只负责把 SQL 丢给 SQLite，不懂业务。
 */
(function () {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function nowSql() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 从一段话里找年份：19xx / 20xx，取第一个 */
  var CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  /** 四位中文数字 -> 年份。「一九五八」-> 1958 */
  function cnYear(s) {
    if (s.length !== 4) return null;
    var v = 0;
    for (var i = 0; i < 4; i++) {
      var d = CN_DIGIT[s.charAt(i)];
      if (typeof d !== 'number') return null;
      v = v * 10 + d;
    }
    return (v >= 1800 && v <= 2099) ? v : null;
  }

  /**
   * 从一句话里找年份。
   * 语音转写出来的往往是「一九五八年」而不是「1958年」，
   * 只认阿拉伯数字的话，整段回忆就编不上年、进不了时间轴。
   */
  function findYear(text) {
    var s = String(text || '');
    var m = s.match(/(1[89]\d{2}|20\d{2})\s*年?/);
    if (m) return parseInt(m[1], 10);

    var c = s.match(/[零〇一二两三四五六七八九]{4}\s*年/);
    if (c) {
      var v = cnYear(c[0].replace(/[年\s]/g, ''));
      if (v) return v;
    }
    return null;
  }

  /** 「1921 · 江西石城 · 父亲李前裕」-> {year, place, event}（Word 图注就这个写法） */
  function docxCaption(cap) {
    var out = { year: 0, place: '', event: '' };
    var s = String(cap || '').trim();
    if (!s) return out;
    var parts = s.split('·');
    var i = 0;
    var m = /^\s*([0-9]{4})\s*$/.exec(parts[0] || '');
    if (m) { out.year = parseInt(m[1], 10); i = 1; }
    if (parts.length > i + 1) { out.place = String(parts[i] || '').trim(); i++; }
    out.event = parts.slice(i).join('·').trim();
    return out;
  }

  /** 去掉口头语与重复标点，只做清理，不改写 */
  function clean(t) {
    return String(t || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/嗯+|啊+|呃+|那个那个/g, '')
      .replace(/[。！？]{2,}/g, function (m) { return m[0]; })
      .trim();
  }

  /** 按句末标点切句。不用 lookbehind——老 WebView 不认 /(?<=)/ */
  function splitSentences(text) {
    var s = String(text || ''), out = [], cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      cur += ch;
      if ('。！？'.indexOf(ch) >= 0) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 长段落切成条目：按句号/问号/感叹号分，凑够 40 字合成一条 */
  function splitEntries(text) {
    var parts = splitSentences(text);
    var out = [], buf = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      buf += p;
      if (buf.length >= 40 || i === parts.length - 1) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf) out.push(buf);
    return out.length ? out : [String(text || '')];
  }

  /** 从一章的原话里挑一句当引语：有数字/引号/具体名词的优先，且不与首条重复 */
  function pickQuote(texts) {
    var cands = [];
    for (var i = 0; i < texts.length; i++) {
      var sents = splitSentences(texts[i]);
      for (var j = 0; j < sents.length; j++) {
        var t = sents[j].trim();
        if (t.length < 9 || t.length > 42) continue;
        var score = 0;
        if (/\d/.test(t)) score += 3;
        if (/[「「"]/.test(t)) score += 2;
        cands.push({ t: t, s: score, first: i === 0 && j === 0 });
      }
    }
    cands.sort(function (a, b) { return b.s - a.s; });
    for (var k = 0; k < cands.length; k++) {
      if (!cands[k].first) return cands[k].t;
    }
    // 整章只有一句话时，唯一的候选就是首句——宁可用它也不让金句空着
    return cands.length ? cands[0].t : '';
  }

  /** 章名：取首个有画面感的短句。年份已经在章名前面了，这里要去掉，否则会「1958年 · 1958年我九岁」 */
  function titleHint(text) {
    var s = clean(text).split(/[。！？；]/)[0].split(/[，、]/)[0];
    s = s.replace(/^(1[89]\d{2}|20\d{2})\s*年?\s*/, '');   // 去开头年份
    s = s.replace(/^(我|我们|那时候|当时|后来|然后|后来呢)/, '');
    s = s.replace(/^[的了是在]/, '');
    if (s.length > 16) s = s.slice(0, 16);
    return s || '这一段';
  }

  /** 按出生年给阶段 */
  function stageOf(year, birth) {
    if (!year || !birth) return '';
    var age = year - birth;
    if (age < 7) return '幼年';
    if (age < 13) return '童年';
    if (age < 19) return '求学';
    if (age < 28) return '青年';
    if (age < 40) return '成家';
    if (age < 60) return '中年';
    return '晚年';
  }

  /**
   * 人生阶段骨架——档案目录的默认结构。
   * 年龄区间以出生年为基准（不含出生年就靠关键词判断），
   * 顺序就是一个人一生的顺序：出生 → 童年 → 求学 → 工作 → 婚姻 → 子女 → 事业 → 晚年。
   */
  var LIFE_STAGES = [
    { key: 'origin', title: '出生与家世', ageFrom: -1, ageTo: 2, stage: '幼年',
      kw: ['出生', '老家', '祖', '宗族', '祠堂', '族谱', '爷爷', '奶奶', '父亲', '母亲',
        '外公', '外婆', '几口人', '村子', '乡下', '老屋'] },
    { key: 'child', title: '童年', ageFrom: 3, ageTo: 12, stage: '童年',
      kw: ['小时候', '童年', '小学', '贪玩', '院子', '放牛', '割草', '邻居', '河边', '过年', '玩伴'] },
    { key: 'school', title: '求学', ageFrom: 13, ageTo: 19, stage: '求学',
      kw: ['上学', '初中', '中学', '高中', '老师', '同学', '毕业', '考试', '大学', '读书', '住校', '学费'] },
    { key: 'work', title: '工作与闯荡', ageFrom: 20, ageTo: 29, stage: '青年',
      kw: ['工作', '上班', '厂', '参军', '当兵', '进城', '学徒', '第一份', '挣', '工地', '单位', '打工'] },
    { key: 'marry', title: '婚姻与家庭', ageFrom: 30, ageTo: 39, stage: '成家',
      kw: ['结婚', '成家', '媳妇', '丈夫', '婚礼', '爱人', '分家', '盖房', '嫁', '娶', '办酒'] },
    { key: 'kids', title: '子女', ageFrom: 40, ageTo: 49, stage: '成家',
      kw: ['孩子', '儿子', '女儿', '满月', '带娃', '兄弟', '姐妹', '上学', '嫁人', '成亲'] },
    { key: 'career', title: '事业与成就', ageFrom: 50, ageTo: 59, stage: '中年',
      kw: ['事业', '生意', '升', '调', '厂子', '公司', '开店', '获奖', '带头', '承包', '入党', '荣誉'] },
    { key: 'late', title: '晚年与回望', ageFrom: 60, ageTo: 200, stage: '晚年',
      kw: ['退休', '孙子', '孙女', '晚年', '现在', '这些年', '回头看', '养老', '身体', '老友'] }
  ];

  /** 这一段属于哪个阶段：有年份按年龄，没年份按关键词打分；都不沾就返回 null */
  function stageOfText(text, year, birth) {
    var i, j;
    if (year && birth) {
      var age = year - birth;
      for (i = 0; i < LIFE_STAGES.length; i++) {
        if (age >= LIFE_STAGES[i].ageFrom && age <= LIFE_STAGES[i].ageTo) return LIFE_STAGES[i];
      }
    }
    var s = String(text || '');
    var best = null, bestScore = 0;
    for (i = 0; i < LIFE_STAGES.length; i++) {
      var hit = 0;
      for (j = 0; j < LIFE_STAGES[i].kw.length; j++) {
        if (s.indexOf(LIFE_STAGES[i].kw[j]) >= 0) hit++;
      }
      if (hit > bestScore) { bestScore = hit; best = LIFE_STAGES[i]; }
    }
    return bestScore > 0 ? best : null;
  }

  /** 照片归位打分：时间 0.45 + 地点 0.30 + 事件 0.25 */
  function scorePhoto(photo, chapter, chapterText) {
    var score = 0, why = [];
    var y = photo.taken_year;
    if (chapter.year_from && y) {
      var to = chapter.year_to || chapter.year_from;
      if (y >= chapter.year_from && y <= to) { score += 0.45; why.push('时间落在本章区间'); }
      else {
        var d = Math.min(Math.abs(y - chapter.year_from), Math.abs(y - to));
        if (d <= 2) { score += 0.45 * (1 - d / 3); why.push('时间相差 ' + d + ' 年'); }
      }
    }
    if (photo.place && chapterText.indexOf(photo.place) >= 0) {
      score += 0.30; why.push('本章提到「' + photo.place + '」');
    }
    if (photo.event) {
      var same = 0;
      for (var i = 0; i < photo.event.length - 1; i++) {
        if (chapterText.indexOf(photo.event.substr(i, 2)) >= 0) same++;
      }
      var ratio = same / Math.max(1, photo.event.length - 1);
      if (ratio > 0.12) { score += 0.25 * Math.min(1, ratio * 2.2); why.push('事件相关'); }
    }
    return { score: score, reason: why.join('；') };
  }

  /* ---------------- 语音转文字：模型可用性判断 ---------------- */

  /**
   * 转写接口不认这个模型（硅基流动的 Qwen3-ASR 就是这种：
   * 模型列表里有，但它只在别的接口上；/audio/transcriptions 只收
   * FunAudioLLM/SenseVoiceSmall 和 TeleAI/TeleSpeechASR）。
   */
  function isModelMissing(r) {
    var s = String((r && (r.message || r.text)) || '');
    return /20012|does not exist|model[_ ]?not[_ ]?found|invalid model|不存在的模型|模型不存在/i.test(s);
  }

  /** 转写模型优先级：免费的、实测能走 /audio/transcriptions 的排前面 */
  var ASR_RANK = [
    /sensevoice/i,
    /teleaaisr|telespeech/i,
    /whisper-large-v3-turbo/i,
    /whisper/i,
    /glm-asr/i,
    /paraformer|funasr/i,
    /qwen3-asr/i
  ];

  function asrScore(id) {
    var s = String(id || '');
    for (var i = 0; i < ASR_RANK.length; i++) if (ASR_RANK[i].test(s)) return i;
    return 99;
  }

  /** 从一串候选里挑最可能能用的转写模型（排除当前失败的那个） */
  function asrFallbackOf(models, current) {
    var best = null, bestScore = 999;
    for (var i = 0; i < models.length; i++) {
      var id = String(models[i] || '');
      if (!id || id === current) continue;
      if (!/asr|whisper|sensevoice|teleai|telespeech|paraformer|funasr/i.test(id)) continue;
      var sc = asrScore(id);
      if (sc < bestScore) { bestScore = sc; best = id; }
    }
    return best;
  }

  /** 短哈希：给派生文件起名用，避免中文路径进文件名 */
  function shortHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
    return h.toString(36);
  }

  var DB = {

    /* ---------------- 档案 ---------------- */

    listArchives: function () {
      // 不用 json_group_array/json_object：安卓系统 SQLite 没编译 JSON1 扩展
      //（no such function），编辑档案时需要的照片清单改为打开编辑态时按需查询
      // cover_path 之前漏查了，首页档案卡一直显示占位文字「档案」；
      // 优先用用户指定的封面照，没指定就退回最早的那张。
      return API.query(
        'SELECT a.*, ' +
        '(SELECT COUNT(*) FROM chapters c WHERE c.archive_id=a.id) AS chapter_count, ' +
        '(SELECT COUNT(*) FROM entries e WHERE e.archive_id=a.id) AS entry_count, ' +
        '(SELECT COUNT(*) FROM photos p WHERE p.archive_id=a.id) AS photo_count, ' +
        '(SELECT p.path FROM photos p WHERE p.id=a.portrait_photo_id) AS portrait_path, ' +
        '(SELECT p.path FROM photos p WHERE p.id=a.cover_photo_id) AS cover_photo_path, ' +
        'COALESCE(' +
        '(SELECT p.path FROM photos p WHERE p.id=a.cover_photo_id), ' +
        '(SELECT p.path FROM photos p WHERE p.archive_id=a.id ORDER BY p.taken_year LIMIT 1)' +
        ') AS cover_path ' +
        'FROM archives a WHERE a.deleted_at IS NULL ORDER BY a.updated_at DESC', []);
    },

    nextNo: function () {
      return API.query("SELECT archive_no FROM archives WHERE archive_no LIKE 'MS-%'", [])
        .then(function (rows) {
          var y = new Date().getFullYear(), max = 0;
          for (var i = 0; i < rows.length; i++) {
            var n = parseInt(String(rows[i].archive_no).replace('MS-' + y + '-', ''), 10);
            if (!isNaN(n) && n > max) max = n;
          }
          var s = String(max + 1);
          while (s.length < 4) s = '0' + s;
          return 'MS-' + y + '-' + s;
        });
    },

    createArchive: function (name, birthYear, hometown) {
      var self = this;
      if (!name || !name.trim()) return Promise.reject(new Error('先写下这部档案是谁的'));
      return self.nextNo().then(function (no) {
        return API.exec(
          'INSERT INTO archives (user_id, archive_no, subject_name, birth_year, hometown) VALUES (1,?,?,?,?)',
          [no, name.trim(), birthYear || null, (hometown || '').trim() || null]);
      }).then(function (r) {
        return r.lastId;
      });
    },

    getArchive: function (id) {
      return Promise.all([
        API.query('SELECT * FROM archives WHERE id=?', [id]),
        API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq, id', [id]),
        // 照片/媒体条目要把真实路径一并带出来，否则档案页里是空 src（破图）；
        // 排序统一走 sort_key（手动顺序），没有就退回 seq，再退回 id —— 三处视图用同一口径。
        API.query(
          'SELECT e.*, p.path AS photo_path, p.taken_year AS taken_year, p.place AS place, ' +
          'p.match_reason AS match_reason, ' +
          'm.path AS media_path, m.kind AS media_kind, m.poster AS media_poster ' +
          'FROM entries e ' +
          'LEFT JOIN photos p ON p.id = e.photo_id ' +
          'LEFT JOIN media m ON m.id = e.media_id ' +
          'WHERE e.archive_id=? ORDER BY COALESCE(e.sort_key, e.seq, 0), e.id', [id]),
        API.query('SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year, id', [id]),
        API.query('SELECT * FROM segments WHERE archive_id=? ORDER BY id', [id]),
        // 成片（短片）也在这本档案里：档案页要能直接看到「合成过的片子」
        API.query('SELECT * FROM media WHERE archive_id=? ORDER BY id DESC', [id])
      ]).then(function (r) {
        var media = r[5] || [];
        return {
          archive: r[0][0] || null,
          chapters: r[1],
          entries: r[2],
          photos: r[3],
          segments: r[4],
          media: media,
          movies: media.filter(function (m) { return String(m.kind) === 'movie'; }),
          // AI 直接生成的片子（聊天里选的视频模型）：同一个展示区，来源不同
          videos: media.filter(function (m) { return String(m.kind) === 'video'; })
        };
      });
    },

    updateArchive: function (id, f) {
      var sets = [], vals = [];
      var map = ['subject_name', 'birth_year', 'death_year', 'hometown', 'intro', 'cover_photo_id', 'visibility'];
      for (var i = 0; i < map.length; i++) {
        var k = map[i];
        if (typeof f[k] !== 'undefined') {
          sets.push(k + '=?');
          vals.push(f[k] === '' ? null : f[k]);
        }
      }
      if (!sets.length) return Promise.resolve();
      sets.push('updated_at=?');
      vals.push(nowSql());
      vals.push(id);
      return API.exec('UPDATE archives SET ' + sets.join(',') + ' WHERE id=?', vals);
    },

    /* ---------------- 讲述 ---------------- */

    addSegment: function (archiveId, text, audioPath) {
      var t = String(text || '').trim();
      if (!t && !audioPath) return Promise.reject(new Error('还没有内容可以保存'));
      return API.exec(
        'INSERT INTO segments (archive_id, raw_text, audio_path, year_hint) VALUES (?,?,?,?)',
        [archiveId, t || '（录音已保存，待转写）', audioPath || null, findYear(t)]).then(function (r) {
        return r.lastId;
      });
    },

    /* ---------------- 导出 / 导入（档案随身带走） ---------------- */

    /**
     * 导出一本档案：所有文字 + 照片/录音（base64）打包成一个 JSON。
     * 媒体读失败不拦着——文字先保住，缺图会在导入时如实留空。
     */
    exportArchive: function (id) {
      return Promise.all([
        API.query('SELECT * FROM archives WHERE id=?', [id]),
        API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [id]),
        API.query('SELECT * FROM entries WHERE archive_id=? ORDER BY seq', [id]),
        API.query('SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year', [id]),
        API.query('SELECT * FROM segments WHERE archive_id=? ORDER BY id', [id]),
        API.query('SELECT * FROM media WHERE archive_id=?', [id])
      ]).then(function (r) {
        var pack = {
          format: 'mylife-archive', version: 1,
          exported_at: new Date().toISOString(),
          archive: r[0][0] || null,
          chapters: r[1], entries: r[2], photos: r[3], segments: r[4], media: r[5]
        };
        if (!pack.archive) return Promise.reject(new Error('找不到这本档案'));

        function readB64(path) {
          return API.file({ op: 'read', path: path }).then(function (f) { return f.base64; },
            function () { return null; });
        }
        var reads = [];
        for (var i = 0; i < pack.photos.length; i++) {
          (function (p) {
            reads.push(readB64(p.path).then(function (b) { p.b64 = b; }));
          })(pack.photos[i]);
        }
        for (var j = 0; j < pack.segments.length; j++) {
          (function (s) {
            if (s.audio_path) reads.push(readB64(s.audio_path).then(function (b) { s.b64 = b; }));
          })(pack.segments[j]);
        }
        for (var k = 0; k < pack.media.length; k++) {
          (function (m) {
            reads.push(readB64(m.path).then(function (b) { m.b64 = b; }));
            if (m.poster) reads.push(readB64(m.poster).then(function (b) { m.poster_b64 = b; }));
          })(pack.media[k]);
        }
        return Promise.all(reads).then(function () { return pack; });
      });
    },

    /**
     * 导入前先看看库里是不是已经有同一本：编号相同，或名字相同，都算「同一本」。
     * 以前不看这个，导一次多一本一模一样的（编号名字全一样），用户根本分不清哪本是哪本。
     */
    findImportTargets: function (pack) {
      var a = (pack && pack.archive) || {};
      var no = String(a.archive_no || '').trim();
      var name = String(a.subject_name || '').trim();
      if (!no && !name) return Promise.resolve([]);
      var where = [], args = [];
      if (no) { where.push('archive_no=?'); args.push(no); }
      if (name) { where.push('subject_name=?'); args.push(name); }
      return API.query(
        'SELECT a.id, a.subject_name, a.archive_no, a.updated_at, ' +
        '(SELECT COUNT(*) FROM chapters c WHERE c.archive_id=a.id) AS chapter_count, ' +
        '(SELECT COUNT(*) FROM entries e WHERE e.archive_id=a.id) AS entry_count, ' +
        '(SELECT COUNT(*) FROM photos p WHERE p.archive_id=a.id) AS photo_count ' +
        'FROM archives a WHERE a.deleted_at IS NULL AND (' + where.join(' OR ') + ') ' +
        'ORDER BY a.updated_at DESC', args);
    },

    /** 同名就给个不重复的名字：王家（副本）、王家（副本 2）… */
    uniqueCopyName: function (name) {
      var base = String(name || '未命名').trim().replace(/（副本(\s*\d+)?）$/, '');
      return API.query('SELECT subject_name FROM archives WHERE deleted_at IS NULL', []).then(function (rows) {
        var used = {};
        for (var i = 0; i < rows.length; i++) used[String(rows[i].subject_name)] = 1;
        if (!used[base]) return base;
        for (var n = 1; n < 500; n++) {
          var cand = base + '（副本' + (n === 1 ? '' : ' ' + n) + '）';
          if (!used[cand]) return cand;
        }
        return base + '（副本 ' + Date.now() + '）';
      });
    },

    /** 编号被占了就重新发一个，不硬抢 */
    takeFreeNo: function (no) {
      var self = this;
      var s = String(no || '').trim();
      if (!s) return self.nextNo();
      return API.query('SELECT id FROM archives WHERE archive_no=? AND deleted_at IS NULL', [s])
        .then(function (rows) { return rows.length ? self.nextNo() : s; });
    },

    /**
     * 清空一本档案的正文（保留档案本身、id、编号、名字）。
     * 覆盖导入用：先腾空，再按文件重建，照片/录音文件顺手删掉。
     */
    clearArchiveContent: function (id) {
      return Promise.all([
        API.query('SELECT path FROM photos WHERE archive_id=?', [id]),
        API.query('SELECT audio_path FROM segments WHERE archive_id=? AND audio_path IS NOT NULL', [id]),
        API.query('SELECT path, poster FROM media WHERE archive_id=?', [id])
      ]).then(function (r) {
        var paths = [], i;
        for (i = 0; i < r[0].length; i++) if (r[0][i].path) paths.push(r[0][i].path);
        for (i = 0; i < r[1].length; i++) if (r[1][i].audio_path) paths.push(r[1][i].audio_path);
        for (i = 0; i < r[2].length; i++) {
          if (r[2][i].path) paths.push(r[2][i].path);
          if (r[2][i].poster) paths.push(r[2][i].poster);
        }
        // 顺序有讲究：先删引用方（条目），再删被引用方，否则外键会拦
        return API.exec('DELETE FROM entries WHERE archive_id=?', [id])
          .then(function () { return API.exec('DELETE FROM photos WHERE archive_id=?', [id]); })
          .then(function () { return API.exec('DELETE FROM segments WHERE archive_id=?', [id]); })
          .then(function () { return API.exec('DELETE FROM media WHERE archive_id=?', [id]); })
          .then(function () { return API.exec('DELETE FROM chapters WHERE archive_id=?', [id]); })
          .then(function () {
            var chain = Promise.resolve();
            paths.forEach(function (p) {
              chain = chain.then(function () { return API.file({ op: 'del', path: p }).catch(function () {}); });
            });
            return chain;
          });
      });
    },

    /**
     * 导入一本档案：所有 id 重新分配，媒体落成新文件。
     * 引用关系（条目→照片/媒体、封面、章）按导出时的旧 id 一一映射回去。
     *
     * opts.mode = 'copy'（默认，存成另一本：名字加「（副本）」、编号重发）
     *            | 'replace'（覆盖 opts.intoId 那本：内容全换，id/编号/名字不动）
     */
    importArchive: function (pack, opts) {
      if (!pack || pack.format !== 'mylife-archive' || !pack.archive) {
        return Promise.reject(new Error('这不是本程序导出的档案文件'));
      }
      opts = opts || {};
      var self = this;
      var a = pack.archive;
      var replaceId = opts.mode === 'replace' ? (Number(opts.intoId) || 0) : 0;
      var stamp = Date.now();
      var seq = 0;
      function newName(ext) {
        seq++;
        return 'imp-' + stamp + '-' + seq + '.' + (ext || 'bin');
      }

      // dataURL 或裸 base64 -> 存盘，返回新 path
      function saveMedia(b64, kind, ext) {
        if (!b64) return Promise.resolve(null);
        var raw = String(b64);
        var comma = raw.indexOf(',');
        if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
        return API.file({ op: 'save', kind: kind, name: newName(ext), base64: raw })
          .then(function (r) { return r.path; }, function () { return null; });
      }
      function extOf(path, fallback) {
        var m = /\.([a-z0-9]{2,5})$/i.exec(String(path || ''));
        return m ? m[1] : fallback;
      }

      // 先决定这本要落成什么样：覆盖就在原地重建，另存就换名字、换编号
      var head;
      if (replaceId) {
        head = self.clearArchiveContent(replaceId).then(function () {
          return API.exec(
            'UPDATE archives SET subject_name=?, birth_year=?, death_year=?, hometown=?, intro=?, ' +
            'status=?, archive_no=?, updated_at=? WHERE id=?',
            [a.subject_name || '未命名', a.birth_year || null, a.death_year || null,
             a.hometown || null, a.intro || null, 'ready',
             a.archive_no || null, nowSql(), replaceId]);
        }).then(function () { return { lastId: replaceId }; });
      } else {
        head = self.uniqueCopyName(a.subject_name || '未命名').then(function (nm) {
          return self.takeFreeNo(a.archive_no).then(function (no) {
            return API.exec(
              'INSERT INTO archives (subject_name,birth_year,death_year,hometown,intro,status,archive_no,created_at,updated_at) ' +
              'VALUES (?,?,?,?,?,?,?,?,?)',
              [nm, a.birth_year || null, a.death_year || null,
               a.hometown || null, a.intro || null, 'ready', no, nowSql(), nowSql()]);
          });
        });
      }

      return head.then(function (ar) {
        var newAid = ar.lastId;
        var chapterMap = {}, photoMap = {}, mediaMap = {}, segmentMap = {};

        // 章
        var chapterChain = Promise.resolve();
        for (var ci = 0; ci < (pack.chapters || []).length; ci++) {
          (function (c) {
            chapterChain = chapterChain.then(function () {
              return API.exec(
                'INSERT INTO chapters (archive_id,seq,title,year_from,year_to,stage,quote,summary) VALUES (?,?,?,?,?,?,?,?)',
                [newAid, c.seq || 10, c.title || null, c.year_from || null, c.year_to || null,
                 c.stage || null, c.quote || null, c.summary || null]
              ).then(function (r) { chapterMap[c.id] = r.lastId; });
            });
          })(pack.chapters[ci]);
        }

        return chapterChain.then(function () {
          // 照片。导出时就没读到内容的（文件丢了），跳过而不是插一条空壳
          var photoChain = Promise.resolve();
          for (var pi = 0; pi < (pack.photos || []).length; pi++) {
            (function (p) {
              photoChain = photoChain.then(function () {
                return saveMedia(p.b64, 'photo', extOf(p.path, 'jpg')).then(function (np) {
                  if (!np) return null;
                  return API.exec(
                    'INSERT INTO photos (archive_id,path,taken_year,taken_month,taken_day,place,event,chapter_id,match_score,match_reason) VALUES (?,?,?,?,?,?,?,?,?,?)',
                    [newAid, np, p.taken_year || null, p.taken_month || null, p.taken_day || null,
                     p.place || '', p.event || '', p.chapter_id ? (chapterMap[p.chapter_id] || null) : null,
                     p.match_score || null, p.match_reason || null]
                  ).then(function (r) { photoMap[p.id] = r.lastId; });
                });
              });
            })(pack.photos[pi]);
          }

          return photoChain.then(function () {
            // 讲述（含录音）
            var segChain = Promise.resolve();
            for (var si = 0; si < (pack.segments || []).length; si++) {
              (function (s) {
                segChain = segChain.then(function () {
                  return saveMedia(s.b64, 'audio', extOf(s.audio_path, 'wav')).then(function (np) {
                    return API.exec(
                      'INSERT INTO segments (archive_id,raw_text,audio_path,year_hint) VALUES (?,?,?,?)',
                      [newAid, s.raw_text || '', np, s.year_hint || null]
                    ).then(function (r) { segmentMap[s.id] = r.lastId; });
                  });
                });
              })(pack.segments[si]);
            }

            return segChain.then(function () {
              // 随文媒体
              var mediaChain = Promise.resolve();
              for (var mi = 0; mi < (pack.media || []).length; mi++) {
                (function (m) {
                  mediaChain = mediaChain.then(function () {
                    return saveMedia(m.b64, m.kind || 'photo', extOf(m.path, 'bin')).then(function (np) {
                      if (!np) return;
                      return saveMedia(m.poster_b64, 'photo', 'jpg').then(function (nposter) {
                        return API.exec(
                          'INSERT INTO media (archive_id,kind,path,mime,bytes,caption,duration_ms,poster) VALUES (?,?,?,?,?,?,?,?)',
                          [newAid, m.kind || 'photo', np, m.mime || null, m.bytes || null,
                           m.caption || null, m.duration_ms || null, nposter]
                        ).then(function (r) { mediaMap[m.id] = r.lastId; });
                      });
                    });
                  });
                })(pack.media[mi]);
              }

              return mediaChain.then(function () {
                // 条目：引用全部重映射
                var entryChain = Promise.resolve();
                for (var ei = 0; ei < (pack.entries || []).length; ei++) {
                  (function (e) {
                    entryChain = entryChain.then(function () {
                      return API.exec(
                        'INSERT INTO entries (archive_id,chapter_id,seq,kind,text,photo_id,media_id,segment_id,origin,edited) VALUES (?,?,?,?,?,?,?,?,?,?)',
                        [newAid,
                         e.chapter_id ? (chapterMap[e.chapter_id] || null) : null,
                         e.seq || 10, e.kind || 'text', e.text || null,
                         e.photo_id ? (photoMap[e.photo_id] || null) : null,
                         e.media_id ? (mediaMap[e.media_id] || null) : null,
                         e.segment_id ? (segmentMap[e.segment_id] || null) : null,
                         e.origin || 'ai', e.edited || 0]
                      );
                    });
                  })(pack.entries[ei]);
                }

                return entryChain.then(function () {
                  // 封面照片重映射
                  var cover = a.cover_photo_id ? (photoMap[a.cover_photo_id] || null) : null;
                  return API.exec('UPDATE archives SET cover_photo_id=? WHERE id=?', [cover, newAid])
                    .then(function () { return { archiveId: newAid }; });
                });
              });
            });
          });
        });
      });
    },

    /**
     * Word 解析结果 → 档案包（和导出的 JSON 同一个形状），后面直接走 importArchive。
     * 这样覆盖/另存、id 重映射、媒体落盘全都不用再写第二遍。
     */
    docxToPack: function (draft) {
      if (!draft || draft.format !== 'mylife-docx' || !draft.chapters) return null;
      var a = draft.archive || {};
      var pack = {
        format: 'mylife-archive', version: 2,
        exported_at: new Date().toISOString(),
        source: 'docx',
        archive: {
          subject_name: a.subject_name || draft.suggest_name || '未命名',
          birth_year: a.birth_year || null,
          death_year: null,
          hometown: a.hometown || null,
          intro: a.intro || null,
          archive_no: a.archive_no || null,
          cover_photo_id: null
        },
        chapters: [], entries: [], photos: [], segments: [], media: []
      };

      var chId = 0, entryId = 0, photoId = 0, seqNo = 0;
      for (var ci = 0; ci < draft.chapters.length; ci++) {
        var c = draft.chapters[ci] || {};
        chId++;
        var yFrom = c.years ? (parseInt(String(c.years), 10) || null) : null;
        var yTo = null;
        var mY = /([0-9]{4})\s*[-—–~至]\s*([0-9]{4})/.exec(String(c.years || ''));
        if (mY) { yFrom = parseInt(mY[1], 10); yTo = parseInt(mY[2], 10); }
        pack.chapters.push({
          id: chId, seq: chId * 10, title: c.title || ('第 ' + chId + ' 章'),
          year_from: yFrom, year_to: yTo, stage: c.stage || null,
          quote: c.quote || null, summary: null
        });

        var blocks = c.blocks || [];
        for (var bi = 0; bi < blocks.length; bi++) {
          var b = blocks[bi] || {};
          seqNo += 10;
          if (b.type === 'photo') {
            if (!b.b64) continue;
            photoId++;
            var cap = docxCaption(b.caption);
            pack.photos.push({
              id: photoId,
              path: b.name || ('import-' + photoId + '.jpg'),
              taken_year: cap.year || yFrom || 0,
              place: cap.place, event: cap.event,
              chapter_id: chId, b64: b.b64
            });
            entryId++;
            pack.entries.push({
              id: entryId, chapter_id: chId, seq: seqNo, kind: 'photo',
              text: null, photo_id: photoId, origin: 'import', edited: 0
            });
            // 第一张照片当封面，省得用户还要自己设一次
            if (!pack.archive.cover_photo_id) pack.archive.cover_photo_id = photoId;
            continue;
          }
          var txt = String(b.text || '').trim();
          if (!txt) continue;
          entryId++;
          pack.entries.push({
            id: entryId, chapter_id: chId, seq: seqNo,
            kind: b.type === 'quote' ? 'quote' : 'text',
            text: txt, origin: 'import', edited: 0
          });
        }
      }
      return pack;
    },

    /* ---------------- 导出 / 导入结束 ---------------- */

    /* ---------------- 模型能力分类（防止给"看照片"绑一个文本模型） ---------------- */

    /** 模型 ID -> 用途类别。看名字猜，各家命名虽乱但关键词稳定 */
    modelKind: function (id) {
      var s = String(id || '').toLowerCase();
      if (/embedding|reranker/.test(s)) return 'embed';
      if (/asr|whisper|sensevoice/.test(s)) return 'asr';
      if (/tts|cosyvoice|speech/.test(s)) return 'tts';
      if (/ocr|vl|vision/.test(s)) return 'vision';
      if (/kolors|flux|cogview|qwen-image|z-image/.test(s)) return 't2i';
      // Wan 系列的 t2v/i2v、CogVideo、Seedance 都是视频；关键词里 t2v/i2v 要在 text 兜底之前
      if (/cogvideo|seedance|video|t2v|i2v|wan2/.test(s)) return 't2v';
      return 'text';
    },

    /** 2026-10 实测的免费档模型。不在名单里的按付费提示 */
    isFreeModel: function (id) {
      var s = String(id || '');
      if (/^Pro\//.test(s)) return false;          // Pro 前缀是付费加速版
      return /hunyuan-mt|qwen3-8b$|qwen3\.5-4b$|deepseek-ocr|qwen3-asr|glm-4-9b|kolors|cosyvoice|sensevoice|teleai|telespeech|whisper|glm-asr|bge-|r1-0528-qwen3-8b/i.test(s);
    },

    /**
     * 有了 Key 就不用再选模型：按环节把推荐模型自动绑上。
     * 只绑「还空着」的环节，用户自己选过的一律不碰。
     * 返回自动绑了哪些（用来提示用户）。
     */
    autoSetupSlots: function (profileId) {
      var self = this;
      return API.query('SELECT * FROM ai_profiles WHERE id=?', [profileId]).then(function (rows) {
        if (!rows.length) return [];
        var models = [];
        try { models = JSON.parse(rows[0].models_json || '[]'); } catch (e) { models = []; }
        if (!models.length) return [];

        // 每个环节的推荐顺序：先挑实测过的免费款，再退而求其次挑同类的
        var WANT = {
          title: ['tencent/Hunyuan-MT-7B', 'Qwen/Qwen3-8B'],
          vision: ['deepseek-ai/DeepSeek-OCR'],
          // 转写接口能收的模型很少：硅基流动只有 SenseVoiceSmall / TeleSpeechASR。
          // Qwen3-ASR 虽然挂在模型列表里，但 /audio/transcriptions 会报
          // "Model does not exist"（v0.3.4 实测），所以排到最后。
          asr: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR',
                'whisper-large-v3-turbo', 'whisper-large-v3', 'glm-asr-2512',
                'Qwen/Qwen3-ASR-1.7B'],
          // 图片生成：硅基流动免费款 Kolors。加好配置、拉到模型后自动绑上，
          // 免得「图片生成」停在「默认 / 按规则」，回退到文本默认模型去调图像接口被 403。
          img: ['Kwai-Kolors/Kolors']
        };
        var KIND = { title: 'text', vision: 'vision', asr: 'asr', img: 't2i' };
        var done = [];

        return self.getSlots().then(function (slots) {
          var map = {};
          for (var i = 0; i < slots.length; i++) map[slots[i].slot] = slots[i];

          var chain = Promise.resolve();
          Object.keys(WANT).forEach(function (slot) {
            var cur = map[slot];
            if (cur && cur.profile_id) return;   // 用户已经配过，不动
            var pick = null;
            for (var w = 0; w < WANT[slot].length && !pick; w++) {
              for (var m = 0; m < models.length; m++) {
                if (String(models[m]).toLowerCase() === WANT[slot][w].toLowerCase()) { pick = models[m]; break; }
              }
            }
            if (!pick) {
              for (var m2 = 0; m2 < models.length && !pick; m2++) {
                if (self.modelKind(models[m2]) === KIND[slot]) pick = models[m2];
              }
            }
            if (pick) {
              chain = chain.then(function () {
                return self.setSlot(slot, profileId, pick).then(function () {
                  done.push(slot);
                });
              });
            }
          });
          return chain.then(function () { return done; });
        });
      });
    },

    /* ---------------- 改动 / 删除（内容全可改可删） ---------------- */

    updateSegment: function (id, text) {
      var t = String(text || '').trim();
      if (!t) return Promise.reject(new Error('内容不能是空的'));
      return API.exec('UPDATE segments SET raw_text=?, year_hint=? WHERE id=?',
        [t, findYear(t), id]);
    },

    /** 删讲述。同时清掉它的录音文件，免得留垃圾 */
    deleteSegment: function (id) {
      return API.query('SELECT audio_path FROM segments WHERE id=?', [id]).then(function (rows) {
        var p = rows.length ? rows[0].audio_path : null;
        var chain = API.exec('DELETE FROM segments WHERE id=?', [id]);
        if (p) {
          chain = chain.then(function (r) {
            return API.file({ op: 'del', path: p }).then(function () { return r; },
              function () { return r; });
          });
        }
        return chain;
      });
    },

    updatePhoto: function (id, f) {
      if (!f.year) return Promise.reject(new Error('这张是哪一年的？'));
      if (!f.place) return Promise.reject(new Error('这张照片是在哪儿拍的？'));
      return API.exec(
        'UPDATE photos SET taken_year=?, place=?, event=?, note=? WHERE id=?',
        [parseInt(f.year, 10), String(f.place).trim(),
         String(f.event || '').trim(), String(f.note || '').trim(), id]);
    },

    deletePhoto: function (id) {
      return API.query('SELECT path FROM photos WHERE id=?', [id]).then(function (rows) {
        var p = rows.length ? rows[0].path : null;
        var chain = API.exec('DELETE FROM photos WHERE id=?', [id]);
        if (p) {
          chain = chain.then(function (r) {
            return API.file({ op: 'del', path: p }).then(function () { return r; },
              function () { return r; });
          });
        }
        return chain;
      });
    },

    /** 改档案封面上的几项 */
    updateArchive: function (id, f) {
      return API.exec(
        'UPDATE archives SET subject_name=?, birth_year=?, death_year=?, hometown=?, intro=?, cover_photo_id=?, updated_at=? WHERE id=?',
        [String(f.name || '').trim(), f.birth || null, f.death || null,
         String(f.hometown || '').trim(), String(f.intro || '').trim(),
         f.cover_photo_id || null, nowSql(), id]);
    },

    /**
     * 删整本档案：章/条目/照片/讲述/媒体随外键级联清掉，
     * 照片和录音的文件也要一起删，否则磁盘上留一堆孤儿。
     */
    deleteArchive: function (id) {
      return Promise.all([
        API.query('SELECT path FROM photos WHERE archive_id=?', [id]),
        API.query('SELECT audio_path FROM segments WHERE archive_id=? AND audio_path IS NOT NULL', [id]),
        API.query('SELECT path, poster FROM media WHERE archive_id=?', [id])
      ]).then(function (r) {
        // 必须 ES5：安卓 5/6 的 WebView 内核不认 const/let/for...of，用了整个文件会语法报错
        var paths = [];
        var i;
        for (i = 0; i < r[0].length; i++) if (r[0][i].path) paths.push(r[0][i].path);
        for (i = 0; i < r[1].length; i++) if (r[1][i].audio_path) paths.push(r[1][i].audio_path);
        for (i = 0; i < r[2].length; i++) {
          if (r[2][i].path) paths.push(r[2][i].path);
          if (r[2][i].poster) paths.push(r[2][i].poster);
        }

        return API.exec('DELETE FROM archives WHERE id=?', [id]).then(function (res) {
          // 库记录已级联删除，文件慢慢清，失败不拦着
          var chain = Promise.resolve();
          paths.forEach(function (p) {
            chain = chain.then(function () {
              return API.file({ op: 'del', path: p }).catch(function () {});
            });
          });
          return chain.then(function () { return res; });
        });
      });
    },

    updateChapter: function (id, title, summary) {
      return API.exec('UPDATE chapters SET title=?, summary=? WHERE id=?',
        [String(title || '').trim(), String(summary || '').trim(), id]);
    },

    /** 新增一章：默认排在最后。返回新章 id，便于建完直接跳进去写 */
    addChapter: function (archiveId, title, yearFrom, yearTo, stage) {
      var t = String(title || '').trim() || '新的一章';
      return API.query('SELECT COALESCE(MAX(seq),0) m FROM chapters WHERE archive_id=?', [archiveId])
        .then(function (rows) {
          var seq = (Number(rows[0] && rows[0].m) || 0) + 10;
          return API.exec(
            'INSERT INTO chapters (archive_id,seq,title,year_from,year_to,stage) VALUES (?,?,?,?,?,?)',
            [archiveId, seq, t, yearFrom || null, yearTo || null, stage || null]);
        })
        .then(function (r) { return { id: r.lastId, title: t, seq: seq }; });
    },

    /**
     * 删一章：章里的段落、照片**退回待归档**，不跟着消失。
     * 让人敢点——删错了还能从「待归档」里找回来。
     */
    deleteChapter: function (chapterId) {
      return API.query('SELECT id, archive_id FROM chapters WHERE id=?', [chapterId]).then(function (rows) {
        if (!rows.length) return { ok: false };
        return API.exec('UPDATE entries SET chapter_id=NULL WHERE chapter_id=?', [chapterId])
          .then(function () {
            return API.exec('UPDATE photos SET chapter_id=NULL WHERE chapter_id=?', [chapterId]);
          })
          .then(function () { return API.exec('DELETE FROM chapters WHERE id=?', [chapterId]); })
          .then(function (r) { return { ok: true, changes: Number(r.changes) || 0 }; });
      });
    },

    /** 把「讲述」材料转成可排版的段落（只转有文字的；已经转过的按内容前缀跳过，不重复生成） */
    segmentsToEntries: function (archiveId, d) {
      var seen = {};
      for (var i = 0; i < d.entries.length; i++) {
        var k0 = String(d.entries[i].text || '').replace(/\s+/g, '');
        if (k0) seen[k0.slice(0, 24)] = 1;
      }
      var rows = [];
      for (i = 0; i < d.segments.length; i++) {
        var s = d.segments[i];
        var txt = String(s.raw_text || '');
        if (!txt || txt.indexOf('待转写') >= 0 || txt.indexOf('录音已保存') >= 0) continue;
        txt = clean(txt);
        var key = txt.replace(/\s+/g, '').slice(0, 24);
        if (key && seen[key]) continue;
        var year = Number(s.year_hint) || findYear(txt) || null;
        var lines = splitEntries(txt);
        for (var j = 0; j < lines.length; j++) {
          if (String(lines[j] || '').trim()) rows.push({ text: lines[j], year: year });
        }
      }
      var chain = Promise.resolve(), n = 0;
      for (var k = 0; k < rows.length; k++) {
        (function (row) {
          chain = chain.then(function () {
            return API.exec(
              'INSERT INTO entries (archive_id,seq,kind,text,at_year,origin) VALUES (?,?,?,?,?,?)',
              [archiveId, (n + 1) * 10, 'text', row.text, row.year, 'ai']).then(function () { n++; });
          });
        })(rows[k]);
      }
      return chain.then(function () { return n; });
    },

    /**
     * 按人生阶段排目录。
     *
     * - 档案还没有目录：直接生成「出生与家世 → 童年 → 求学 → 工作与闯荡 →
     *   婚姻与家庭 → 子女 → 事业与成就 → 晚年与回望」八章，把现有文字和照片按年份/关键词归位。
     * - 已经有目录：默认只把「待归档」的内容补进合适的章，不动你排好的结构；
     *   传 { force: true } 才会按年份重排（旧章节拆掉，内容一条不丢）。
     * - 一个字都没有：也把八章骨架建出来，让人一进来就有地方写。
     */
    buildOutline: function (archiveId, opts) {
      opts = opts || {};
      var self = this;
      return self.getArchive(archiveId).then(function (d) {
        var birth = parseInt(d.archive && d.archive.birth_year, 10) || 0;
        // 录音（讲述材料）先转成段落；已经转过的按内容前缀跳过，不会重复
        if (d.segments.length && (opts.force || !d.chapters.length)) {
          return self.segmentsToEntries(archiveId, d).then(function () {
            return self.getArchive(archiveId);
          });
        }
        return d;
      }).then(function (d) {
        var birth = parseInt(d.archive && d.archive.birth_year, 10) || 0;
        var hasCh = d.chapters.length > 0;

        if (hasCh && !opts.force) {
          return self.homeOrphans(archiveId, d, birth).then(function (n) {
            return { created: 0, homed: n, kept: true, total: d.chapters.length };
          });
        }

        var units = [], u;
        for (u = 0; u < d.entries.length; u++) {
          var e = d.entries[u];
          if (e.kind !== 'text' && e.kind !== 'quote') continue;
          var txt = String(e.text || '').trim();
          if (!txt) continue;
          units.push({
            id: e.id, text: txt,
            year: Number(e.at_year) || findYear(txt) || null,
          });
        }

        var byStage = {}, orphan = 0;
        for (u = 0; u < units.length; u++) {
          var st = stageOfText(units[u].text, units[u].year, birth);
          if (!st) { orphan++; continue; }
          if (!byStage[st.key]) byStage[st.key] = { stage: st, list: [] };
          byStage[st.key].list.push(units[u]);
        }

        var createAll = units.length === 0 || !Object.keys(byStage).length;
        var used = [];
        for (var s1 = 0; s1 < LIFE_STAGES.length; s1++) {
          if (createAll || byStage[LIFE_STAGES[s1].key]) used.push(LIFE_STAGES[s1]);
        }

        var chain = Promise.resolve();
        if (hasCh) {
          chain = chain
            .then(function () { return API.exec('UPDATE entries SET chapter_id=NULL WHERE archive_id=?', [archiveId]); })
            .then(function () { return API.exec('UPDATE photos SET chapter_id=NULL WHERE archive_id=?', [archiveId]); })
            .then(function () { return API.exec('DELETE FROM chapters WHERE archive_id=?', [archiveId]); });
        }

        var made = {}, created = 0;
        used.forEach(function (st) {
          chain = chain.then(function () {
            var ys = [];
            if (byStage[st.key]) {
              byStage[st.key].list.forEach(function (x) { if (x.year) ys.push(x.year); });
            }
            ys.sort(function (a, b) { return a - b; });
            var yf = ys.length ? ys[0] : null;
            var yt = ys.length ? ys[ys.length - 1] : null;
            if (!ys.length && birth) {
              yf = birth + (st.ageFrom > 0 ? st.ageFrom : 0);
              yt = birth + st.ageTo;
            }
            created++;
            return API.exec(
              'INSERT INTO chapters (archive_id,seq,title,year_from,year_to,stage) VALUES (?,?,?,?,?,?)',
              [archiveId, created * 10, st.title, yf, yt, st.stage]
            ).then(function (r) { made[st.key] = r.lastId; });
          });
        });

        /* 段落归位：同一章内按年份先后排，年份不详的排后面 */
        chain = chain.then(function () {
          var sub = Promise.resolve();
          LIFE_STAGES.forEach(function (st) {
            var box = byStage[st.key], cid = made[st.key];
            if (!box || !cid) return;
            box.list.sort(function (a, b) {
              return ((a.year || 9999) - (b.year || 9999)) || (a.id - b.id);
            });
            box.list.forEach(function (unit, idx) {
              sub = sub.then(function () {
                return API.exec('UPDATE entries SET chapter_id=?, sort_key=? WHERE id=?',
                  [cid, (idx + 1) * 10, unit.id]);
              });
            });
          });
          return sub;
        });

        /* 照片也按年份跟着进章，没年份的留在「待归档照片」里让人自己放 */
        chain = chain.then(function () {
          var sub = Promise.resolve();
          for (var k = 0; k < d.photos.length; k++) {
            (function (ph) {
              var st = stageOfText(ph.event || '', Number(ph.taken_year) || 0, birth);
              if (!st || !made[st.key]) return;
              sub = sub.then(function () {
                return API.exec('UPDATE photos SET chapter_id=?, match_reason=? WHERE id=?',
                  [made[st.key], '按年份自动归入「' + st.title + '」', ph.id]);
              });
            })(d.photos[k]);
          }
          return sub;
        });

        return chain.then(function () {
          return API.exec("UPDATE archives SET status='ready', updated_at=? WHERE id=?", [nowSql(), archiveId]);
        }).then(function () {
          return { created: created, homed: units.length - orphan, orphan: orphan, kept: false };
        });
      });
    },

    /** 已有目录时：只把没归章的段落按年份/关键词塞进现成的章 */
    homeOrphans: function (archiveId, d, birth) {
      var chs = d.chapters.slice();
      var chain = Promise.resolve(), n = 0;
      for (var i = 0; i < d.entries.length; i++) {
        (function (e) {
          if (e.chapter_id) return;
          if (e.kind !== 'text' && e.kind !== 'quote') return;
          var txt = String(e.text || '').trim();
          if (!txt) return;
          var year = Number(e.at_year) || findYear(txt) || null;
          var target = null;
          if (year) {
            for (var c = 0; c < chs.length; c++) {
              var yf = Number(chs[c].year_from) || 0;
              var yt = Number(chs[c].year_to) || yf;
              if (yf && year >= yf && year <= yt) { target = chs[c]; break; }
            }
          }
          if (!target) {
            var st = stageOfText(txt, 0, 0);
            if (st) {
              for (var c2 = 0; c2 < chs.length; c2++) {
                if (String(chs[c2].title || '').indexOf(st.title) >= 0) { target = chs[c2]; break; }
              }
            }
          }
          if (!target) return;
          chain = chain.then(function () {
            return API.query('SELECT COALESCE(MAX(sort_key),MAX(seq),0)+10 s FROM entries WHERE chapter_id=?',
              [target.id]).then(function (r) {
              return API.exec('UPDATE entries SET chapter_id=?, sort_key=? WHERE id=?',
                [target.id, Number(r[0] && r[0].s) || 10, e.id]);
            }).then(function () { n++; });
          });
        })(d.entries[i]);
      }
      return chain.then(function () { return n; });
    },

    updateEntry: function (id, text) {
      var t = String(text || '').trim();
      if (!t) return Promise.reject(new Error('内容不能是空的'));
      // 必须同时把归属改成 user：生成时只清 origin='ai' 的条目，
      // 不改这个标记，用户手改过的段落下一次生成会被静默冲掉
      return API.exec('UPDATE entries SET text=?, origin=\'user\', edited=1 WHERE id=?', [t, id]);
    },

    /** 删条目。章留着——目录是骨架，空章让人继续往里写，不要突然消失 */
    deleteEntry: function (id) {
      return API.exec('DELETE FROM entries WHERE id=?', [id]);
    },

    deleteMedia: function (id) {
      return API.query('SELECT path, poster FROM media WHERE id=?', [id]).then(function (rows) {
        if (!rows.length) return { changes: 0 };
        var row = rows[0];
        var chain = API.exec('DELETE FROM media WHERE id=?', [id]);
        var paths = [row.path, row.poster];
        for (var i = 0; i < paths.length; i++) {
          if (!paths[i]) continue;
          chain = chain.then((function (p) {
            return function (r) {
              return API.file({ op: 'del', path: p }).then(function () { return r; },
                function () { return r; });
            };
          })(paths[i]));
        }
        return chain;
      });
    },

    /**
     * 「传」：往某一段后面塞一张图 / 一段视频 / 一条录音。
     * 存文件 -> 记 media -> 建一个 kind='media' 的条目排在卷宗里。
     * chapterId 为 null 时先进「待归档」，下次生成会尝试归位。
     */
    addMediaEntry: function (archiveId, chapterId, kind, base64, mime, caption, ext, afterId) {
      if (!base64) return Promise.reject(new Error('没有收到内容'));
      var raw = String(base64);
      var comma = raw.indexOf(',');
      if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
      var name = 'up-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + (ext || 'bin');

      return API.file({ op: 'save', kind: kind, name: name, base64: raw }).then(function (saved) {
        return API.exec(
          'INSERT INTO media (archive_id,kind,path,mime,bytes,caption) VALUES (?,?,?,?,?,?)',
          [archiveId, kind, saved.path, mime || null, saved.bytes || null, caption || null]
        ).then(function (mr) {
          var mid = mr.lastId;
          // 点哪一段就在它的正后方插入（人的预期）；没有锚点才排到章末
          if (afterId) {
            return DB.insertAfter(archiveId, {
              afterId: afterId, chapterId: chapterId, kind: 'media', mediaId: mid, text: caption || '',
            });
          }
          var seqQ = chapterId
            ? API.query('SELECT coalesce(max(seq),0)+10 s FROM entries WHERE chapter_id=?', [chapterId])
            : Promise.resolve([{ s: 10 }]);
          return seqQ.then(function (r) {
            return API.exec(
              'INSERT INTO entries (archive_id,chapter_id,seq,kind,text,media_id,origin,edited) VALUES (?,?,?,?,?,?,?,1)',
              [archiveId, chapterId || null, r[0].s, 'media', caption || null, mid, 'user']
            );
          });
        });
      });
    },

    /** 删一个媒体型条目：条目和它引用的媒体一起清掉 */
    deleteMediaEntry: function (entryId) {
      var self = this;
      return API.query('SELECT media_id FROM entries WHERE id=?', [entryId]).then(function (rows) {
        var mid = rows.length ? rows[0].media_id : null;
        var chain = API.exec('DELETE FROM entries WHERE id=?', [entryId]);
        if (mid) chain = chain.then(function (r) {
          return self.deleteMedia(mid).then(function () { return r; });
        });
        return chain;
      });
    },

    /* ---------------- 语音转文字 ---------------- */

    /**
     * 把一段录音转成文字，回填到这条讲述里。
     * 原来存放的占位文本（"待转写"）会被替换掉；已经有字的则拼在后面。
     */
    transcribe: function (segId, opts) {
      var o = opts || {};
      return API.query('SELECT * FROM segments WHERE id=?', [segId]).then(function (rows) {
        if (!rows.length) return Promise.reject(new Error('找不到这段讲述'));
        var seg = rows[0];
        if (!seg.audio_path) return Promise.reject(new Error('这段没有录音可以转'));

        function call(model, pid) {
          return API.asr({
            path: seg.audio_path,
            slot: 'asr',      // 默认用「语音转文字」绑的那条；显式 model/profileId 时以它们为准
            profileId: pid || o.profileId || null,
            model: model || o.model || null,
            language: o.language || null,
          });
        }

        /** 同一家配置里换一个转写模型：硅基流动的 Qwen3-ASR 在转写接口上不存在 */
        function fallback() {
          return API.query(
            'SELECT p.id, p.name, p.base_url, p.models_json FROM ai_slots s ' +
            'JOIN ai_profiles p ON p.id = s.profile_id WHERE s.slot=?', ['asr'])
            .then(function (ps) {
              if (!ps.length) return null;
              var ms = [];
              try { ms = JSON.parse(ps[0].models_json || '[]'); } catch (e) { ms = []; }
              var fb = asrFallbackOf(ms, o.model || '');
              // 拉过模型清单就按清单挑；没拉过（或清单里没语音模型）时，
              // 硅基流动就认准这一个——它家的免费转写一直是 SenseVoiceSmall
              if (!fb && /siliconflow/i.test(String(ps[0].base_url || ''))) {
                fb = 'FunAudioLLM/SenseVoiceSmall';
              }
              return fb ? { model: fb, profileId: ps[0].id, name: ps[0].name } : null;
            });
        }

        return call(null).then(function (r) {
          if (r && r.ok) return r;
          if (!isModelMissing(r)) return r;
          return fallback().then(function (fb) {
            if (!fb) return r;
            return call(fb.model, fb.profileId).then(function (r2) {
              if (r2 && r2.ok) { r2.switched = fb.model; return r2; }
              return r;      // 换了也不行，报原来的错更有参考价值
            });
          });
        }).then(function (r) {
          if (!r.ok) return r;
          var old = String(seg.raw_text || '');
          var isPlaceholder = !old || old.indexOf('待转写') >= 0 || old.indexOf('录音已保存') >= 0;
          var merged = isPlaceholder ? r.text : old + '\n' + r.text;
          return API.exec('UPDATE segments SET raw_text=?, year_hint=? WHERE id=?',
            [merged, findYear(merged) || seg.year_hint, segId]).then(function () {
            return { ok: true, ms: r.ms, model: r.model, text: r.text, merged: merged, switched: r.switched || null };
          });
        });
      });
    },

    /* ---------------- 照片 ---------------- */

    addPhoto: function (archiveId, dataUrl, year, place, event, name) {
      if (!year) return Promise.reject(new Error('这张是哪一年的？'));
      if (!place) return Promise.reject(new Error('这张照片是在哪儿拍的？'));
      if (!event) return Promise.reject(new Error('这张照片是什么事？'));
      var self = this;
      return API.file({ op: 'save', kind: 'photo', name: name || ('p' + Date.now() + '.jpg'), base64: dataUrl })
        .then(function (f) {
          if (!f.ok) throw new Error(f.message || '照片没存下来');
          return API.exec(
            'INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)',
            [archiveId, f.path, year, place, event]);
        });
    },

    photoUrl: function (p) {
      return '/files/' + p;
    },

    /* ---------------- 生成（纯规则，同步，毫秒级） ---------------- */

    generate: function (archiveId) {
      var self = this;
      return self.getArchive(archiveId).then(function (d) {
        if (!d.segments.length) throw new Error('还没有讲述内容，先说一段吧');

        var birth = parseInt(d.archive.birth_year, 10) || 0;

        // 1) 按年份分组，没有年份的归「未编年」
        var groups = [], byYear = {};
        for (var i = 0; i < d.segments.length; i++) {
          var s = d.segments[i];
          var y = s.year_hint || findYear(s.raw_text);
          var key = y || 0;
          if (!byYear[key]) {
            byYear[key] = { year: y, segs: [] };
            groups.push(byYear[key]);
          }
          byYear[key].segs.push(s);
        }
        groups.sort(function (a, b) { return (a.year || 9999) - (b.year || 9999); });

        // 2) 只清 AI 生成的条目和章节，用户手写的不动
        return API.exec("DELETE FROM entries WHERE archive_id=? AND origin='ai'", [archiveId])
          .then(function () {
            return API.exec('DELETE FROM chapters WHERE archive_id=?', [archiveId]);
          })
          .then(function () {
            var chain = Promise.resolve();
            var chapters = [];
            var seq = 0;

            groups.forEach(function (g) {
              chain = chain.then(function () {
                seq++;
                var texts = g.segs.map(function (s) { return clean(s.raw_text); });
                var title = (g.year ? g.year + '年' : '未编年') + ' · ' + titleHint(texts[0]);
                var stage = stageOf(g.year, birth);
                var quote = pickQuote(texts);
                return API.exec(
                  'INSERT INTO chapters (archive_id, seq, title, year_from, year_to, stage, quote) VALUES (?,?,?,?,?,?,?)',
                  [archiveId, seq, title, g.year || null, g.year || null, stage || null, quote || null]
                ).then(function (r) {
                  var ch = { id: r.lastId, year_from: g.year, year_to: g.year, text: texts.join('') };
                  chapters.push(ch);
                  // 条目
                  var sub = Promise.resolve(), n = 0;
                  texts.forEach(function (t) {
                    splitEntries(t).forEach(function (line) {
                      n++;
                      (function (line, n) {
                        sub = sub.then(function () {
                          return API.exec(
                            'INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin) VALUES (?,?,?,?,?,?)',
                            [archiveId, ch.id, n * 10, 'text', line, 'ai']);
                        });
                      })(line, n);
                    });
                  });
                  return sub;
                });
              });
            });

            return chain.then(function () {
              // 3) 照片归位
              var pending = d.photos.filter(function () { return true; });
              return chapters.reduce(function (p, ch) {
                return p.then(function () {
                  var mine = pending.filter(function (ph) { return !ph.__done && ph.taken_year; });
                  var best = null;
                  mine.forEach(function (ph) {
                    var r = scorePhoto(ph, ch, ch.text || '');
                    if (!best || r.score > best.score) best = { ph: ph, score: r.score, reason: r.reason, ch: ch };
                  });
                  if (!best || best.score < 0.30) return null;
                  best.ph.__done = true;
                  return API.exec(
                    'UPDATE photos SET chapter_id=?, match_score=?, match_reason=? WHERE id=?',
                    [ch.id, best.score, best.reason, best.ph.id]).then(function () {
                    return API.exec(
                      'INSERT INTO entries (archive_id, chapter_id, seq, kind, text, photo_id, origin) VALUES (?,?,?,?,?,?,?)',
                      [archiveId, ch.id, 999, 'photo', best.ph.event, best.ph.id, 'ai']);
                  });
                });
              }, Promise.resolve()).then(function () {
                // 没归位的写清楚理由
                return Promise.all(d.photos.filter(function (ph) { return !ph.__done; }).map(function (ph) {
                  return API.exec(
                    'UPDATE photos SET chapter_id=NULL, match_reason=? WHERE id=?',
                    ['时间或地点对不上，先放在待归档', ph.id]);
                }));
              });
            }).then(function () {
              // 4) 手写内容按年份重新归位：重建章节会把它们的 chapter_id 变成孤儿
              return self.rehomeUserEntries(archiveId);
            }).then(function () {
              return API.exec("UPDATE archives SET status='ready', updated_at=? WHERE id=?", [nowSql(), archiveId]);
            });
          });
      });
    },

    /** 生成卷宗会重建章节：用户手写的条目要按年份重新归位，不能落成孤儿 */
    rehomeUserEntries: function (archiveId) {
      return API.query("SELECT id, text, at_year FROM entries WHERE archive_id=? AND origin='user'", [archiveId])
        .then(function (rows) {
          var chain = Promise.resolve();
          for (var i = 0; i < rows.length; i++) {
            (function (r) {
              var y = r.at_year || findYear(r.text || '');
              chain = chain.then(function () {
                return DB.chapterForYear(archiveId, y).then(function (chId) {
                  return API.exec('UPDATE entries SET chapter_id=?, at_year=COALESCE(at_year,?) WHERE id=?',
                    [chId || null, y || null, r.id]);
                });
              });
            })(rows[i]);
          }
          return chain;
        });
    },

    /* ---------------- AI 配置（可无限添加） ---------------- */

    listProfiles: function () {
      return API.query('SELECT * FROM ai_profiles ORDER BY sort, id', []);
    },

    getProfile: function (id) {
      return API.query('SELECT * FROM ai_profiles WHERE id=?', [id]).then(function (r) {
        return r[0] || null;
      });
    },

    /** p: {id?, name, kind, base_url, api_key, default_model, vision_model, enabled} */
    saveProfile: function (p) {
      if (!p.name || !String(p.name).trim()) return Promise.reject(new Error('给这条配置起个名字'));
      if (!p.base_url || !String(p.base_url).trim()) return Promise.reject(new Error('接口地址不能空'));
      var name = String(p.name).trim();
      var kind = p.kind || 'openai';
      var base = String(p.base_url).trim().replace(/\/+$/, '');
      var key = p.api_key === null || typeof p.api_key === 'undefined' ? null : String(p.api_key);
      var dm = p.default_model || null;
      var vm = p.vision_model || null;
      var en = p.enabled === 0 || p.enabled === false ? 0 : 1;

      if (p.id) {
        return API.exec(
          'UPDATE ai_profiles SET name=?, kind=?, base_url=?, api_key=?, default_model=?, vision_model=?, enabled=? WHERE id=?',
          [name, kind, base, key, dm, vm, en, p.id]);
      }
      return API.exec(
        'INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, vision_model, enabled, sort) ' +
        'VALUES (?,?,?,?,?,?,?,100)', [name, kind, base, key, dm, vm, en]);
    },

    deleteProfile: function (id) {
      return API.exec('UPDATE ai_slots SET profile_id=NULL, model=NULL WHERE profile_id=?', [id])
        .then(function () {
          return API.exec('DELETE FROM ai_profiles WHERE id=?', [id]);
        });
    },

    /** 启用 / 停用一条配置（停用的不参与自动挑选） */
    toggleProfile: function (id, on) {
      return API.exec('UPDATE ai_profiles SET enabled=? WHERE id=?', [on ? 1 : 0, id]);
    },

    getSlots: function () {
      return API.query('SELECT * FROM ai_slots', []);
    },

    setSlot: function (slot, profileId, model) {
      return API.exec(
        'UPDATE ai_slots SET profile_id=?, model=? WHERE slot=?',
        [profileId || null, model || null, slot]).then(function (r) {
        if (r.changes) return r;
        return API.exec('INSERT INTO ai_slots (slot, profile_id, model) VALUES (?,?,?)',
          [slot, profileId || null, model || null]);
      });
    },

    pullModels: function (id) {
      return API.aiModels(id);
    },

    testProfile: function (id, model) {
      return API.aiTest({ profileId: id, model: model || null });
    },

    /** 用某个用途（slot）问一句，验证绑定是否可用 */
    testSlot: function (slot) {
      return API.aiTest({ slot: slot });
    },

    /* ---------------- 设置 ---------------- */

    getSettings: function () {
      return API.query('SELECT k, v FROM settings', []).then(function (rows) {
        var o = {};
        for (var i = 0; i < rows.length; i++) o[rows[i].k] = rows[i].v;
        return o;
      });
    },

    saveSetting: function (k, v) {
      return API.exec('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]);
    },

    /** 阅读偏好：字号、夜间、语速 */
    getPref: function (k, def) {
      return API.query('SELECT v FROM settings WHERE k=?', ['pref.' + k]).then(function (r) {
        return r.length ? r[0].v : def;
      });
    },

    setPref: function (k, v) {
      return DB.saveSetting('pref.' + k, String(v));
    },

    /* ================= v0.5：封面与头像 ================= */

    setCoverPhoto: function (archiveId, photoId) {
      return API.exec('UPDATE archives SET cover_photo_id=?, updated_at=? WHERE id=?',
        [photoId || null, nowSql(), archiveId]);
    },

    setPortrait: function (archiveId, photoId) {
      return API.exec('UPDATE archives SET portrait_photo_id=?, updated_at=? WHERE id=?',
        [photoId || null, nowSql(), archiveId]);
    },

    saveCoverConfig: function (archiveId, cfg) {
      return API.exec('UPDATE archives SET cover_config_json=?, updated_at=? WHERE id=?',
        [JSON.stringify(cfg || {}), nowSql(), archiveId]);
    },

    /** 封面参数：缺什么补什么，旧档案没这字段也能直接用 */
    coverConfig: function (a) {
      var def = { style: 'paper', font: 'song', accent: '#8B5E3C', pos: '50% 35%', zoom: 1 };
      var o = {};
      try { o = JSON.parse((a && a.cover_config_json) || '{}') || {}; } catch (e) { o = {}; }
      for (var k in def) {
        if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
        if (typeof o[k] === 'undefined' || o[k] === null || o[k] === '') o[k] = def[k];
      }
      return o;
    },

    listPhotos: function (archiveId) {
      return API.query('SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year, id', [archiveId]);
    },

    /** 这张照片正被谁当封面/头像用——删之前必须问一句 */
    photoUsage: function (photoId) {
      return API.query(
        'SELECT id, subject_name, cover_photo_id, portrait_photo_id FROM archives WHERE cover_photo_id=? OR portrait_photo_id=?',
        [photoId, photoId]).then(function (rows) {
        var asCover = [], asPortrait = [];
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].cover_photo_id) === String(photoId)) asCover.push(rows[i]);
          if (String(rows[i].portrait_photo_id) === String(photoId)) asPortrait.push(rows[i]);
        }
        return { cover: asCover, portrait: asPortrait, blocked: rows.length > 0 };
      });
    },

    deletePhotoSafe: function (id) {
      return DB.photoUsage(id).then(function (u) {
        if (u.blocked) {
          var names = [];
          for (var i = 0; i < u.cover.length; i++) names.push(u.cover[i].subject_name);
          for (var j = 0; j < u.portrait.length; j++) names.push(u.portrait[j].subject_name);
          throw new Error('这张正在当封面或头像（' + names.join('、') + '），先换一张再删');
        }
        return DB.deletePhoto(id);
      });
    },

    /** 缩略图：前端 canvas 生成后落到 derived/thumbs/，同一源+尺寸只生成一次 */
    saveThumb: function (sourcePath, dataUrl, size) {
      var params = 'thumb' + size;
      return API.query('SELECT out_path FROM derivations WHERE source_path=? AND params_hash=?',
        [String(sourcePath), params]).then(function (rows) {
        if (rows.length) return rows[0].out_path;
        var name = 't' + size + '-' + shortHash(String(sourcePath) + params) + '.jpg';
        return API.file({ op: 'save', dir: 'derived/thumbs', name: name, base64: dataUrl })
          .then(function (f) {
            return API.exec(
              'INSERT OR IGNORE INTO derivations (source_path, params_hash, out_path, bytes) VALUES (?,?,?,?)',
              [String(sourcePath), params, f.path, f.bytes]).then(function () { return f.path; });
          });
      });
    },

    /* ================= v0.5：时间轴与插叙 ================= */

    timeline: function (archiveId) {
      return API.query(
        'SELECT * FROM v_timeline WHERE archive_id=? ' +
        'ORDER BY (at_year IS NULL), at_year, COALESCE(at_month,0), COALESCE(at_day,0), sort_key, id',
        [archiveId]);
    },

    /** 某一年落在哪一章（生成卷宗用的是同一套范围判断） */
    chapterForYear: function (archiveId, year) {
      if (!year) return Promise.resolve(null);
      return API.query(
        'SELECT id FROM chapters WHERE archive_id=? AND year_from<=? AND (year_to IS NULL OR year_to>=?) ORDER BY seq LIMIT 1',
        [archiveId, year, year]).then(function (r) { return r.length ? r[0].id : null; });
    },

    /**
     * 在任意时间点插入内容。kind: text / photo / audio / video
     * opts: { archiveId, year, month, day, precision, label, chapterId, text, dataUrl, mime, ext }
     */
    insertAt: function (opts) {
      var o = opts || {};
      var aid = Number(o.archiveId);
      if (!aid) return Promise.reject(new Error('没有指定档案'));
      var year = o.year ? Number(o.year) : null;
      var month = o.month ? Number(o.month) : null;
      var day = o.day ? Number(o.day) : null;
      var precision = o.precision || (day ? 'day' : (month ? 'month' : 'year'));
      var kind = o.kind || 'text';

      function locate() {
        var chP = (typeof o.chapterId !== 'undefined' && o.chapterId !== '' && o.chapterId !== null)
          ? Promise.resolve(Number(o.chapterId))
          : DB.chapterForYear(aid, year);
        return chP.then(function (chId) {
          var q = chId
            ? API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE chapter_id=?', [chId])
            : API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE archive_id=?', [aid]);
          return q.then(function (r) {
            return { chapterId: chId || null, sortKey: Number(r[0].k || 0) + 10 };
          });
        });
      }

      function addEntry(loc, extra) {
        return API.exec(
          'INSERT INTO entries (archive_id,chapter_id,seq,kind,text,photo_id,media_id,origin,edited,' +
          'at_year,at_month,at_day,at_precision,at_label,sort_key) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)',
          [aid, loc.chapterId, Math.round(loc.sortKey), kind, o.text || null,
            extra && extra.photoId || null, extra && extra.mediaId || null, 'user',
            year, month, day, precision, o.label || null, loc.sortKey]);
      }

      if (kind === 'text') {
        if (!String(o.text || '').trim()) return Promise.reject(new Error('写点什么再存'));
        return locate().then(function (loc) { return addEntry(loc); });
      }

      // 插图：图片已经在 ai/img 里了，直接登记，不再复制一份字节
      if (kind === 'photo' && o.photoPath) {
        return locate().then(function (loc) {
          return API.exec(
            'INSERT INTO photos (archive_id,path,taken_year,taken_month,taken_day,place,event,chapter_id,role) VALUES (?,?,?,?,?,?,?,?,?)',
            [aid, o.photoPath, year || 0, month, day, o.place || 'AI 插图', o.text || 'AI 插图', loc.chapterId, 'inline']
          ).then(function (r) { return addEntry(loc, { photoId: r.lastId }); });
        });
      }

      if (!o.dataUrl) return Promise.reject(new Error('没有收到文件'));
      var raw = String(o.dataUrl);
      var comma = raw.indexOf(',');
      if (raw.indexOf('data:') === 0 && comma > 0) raw = raw.slice(comma + 1);
      var ext = o.ext || (kind === 'photo' ? 'jpg' : (kind === 'audio' ? 'wav' : 'mp4'));
      var name = 't' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext;
      var dir = kind === 'photo' ? 'photo' : kind;

      return locate().then(function (loc) {
        return API.file({ op: 'save', dir: dir, name: name, base64: raw }).then(function (f) {
          if (!f.ok) throw new Error(f.message || '文件没存下来');
          if (kind === 'photo') {
            return API.exec(
              'INSERT INTO photos (archive_id,path,taken_year,taken_month,taken_day,place,event,chapter_id) VALUES (?,?,?,?,?,?,?,?)',
              [aid, f.path, year || 0, month, day, o.place || '未标地点', o.text || '未标事件', loc.chapterId]
            ).then(function (r) { return addEntry(loc, { photoId: r.lastId }); });
          }
          return API.exec(
            'INSERT INTO media (archive_id,kind,path,mime,bytes,caption,at_year,at_month,at_day,at_precision,at_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [aid, kind, f.path, o.mime || null, f.bytes || null, o.text || null,
              year, month, day, precision, o.label || null]
          ).then(function (r) { return addEntry(loc, { mediaId: r.lastId }); });
        });
      });
    },

    /**
     * 整个档案的显示顺序：先按章节 seq，再按章内 sort_key（没有就退回 seq、id），
     * 没归章的碎片排最后。所有"上移/下移"都基于这一条顺序，所以能跨越章节移动。
     */
    _orderedEntries: function (archiveId) {
      return API.query(
        'SELECT e.id, e.chapter_id, COALESCE(c.seq, 1000000000) cseq, COALESCE(e.sort_key, e.seq, 0) k ' +
        'FROM entries e LEFT JOIN chapters c ON c.id = e.chapter_id ' +
        'WHERE e.archive_id=? ' +
        'ORDER BY (e.chapter_id IS NULL), COALESCE(c.seq, 1000000000), COALESCE(e.sort_key, e.seq, 0), e.id',
        [archiveId]);
    },

    /**
     * 上下移动一条。跨章也能移：挪到相邻位置后，那条属于哪一章，这一条就跟着归到哪一章，
     * 所以章节边界不再是"墙"。移完把整个档案的 sort_key 归一成 10/20/30……，顺序显式稳定。
     * dir < 0 上移，dir > 0 下移。
     */
    moveEntry: function (entryId, dir) {
      var self = this;
      return API.query('SELECT archive_id FROM entries WHERE id=?', [entryId]).then(function (r0) {
        if (!r0.length) return { moved: false };
        return self._orderedEntries(r0[0].archive_id).then(function (list) {
          var idx = -1, i;
          for (i = 0; i < list.length; i++) if (String(list[i].id) === String(entryId)) { idx = i; break; }
          if (idx < 0) return { moved: false };
          var j = dir < 0 ? idx - 1 : idx + 1;
          if (j < 0 || j >= list.length) return { moved: false };
          var newChapter = list[j].chapter_id;
          var ids = [];
          for (i = 0; i < list.length; i++) ids.push(list[i].id);
          var movedId = ids.splice(idx, 1)[0];
          ids.splice(j, 0, movedId);
          var chain = Promise.resolve();
          ids.forEach(function (id2, k) {
            chain = chain.then(function () {
              return API.exec('UPDATE entries SET sort_key=? WHERE id=?', [(k + 1) * 10, id2]);
            });
          });
          chain = chain.then(function () {
            return API.exec('UPDATE entries SET chapter_id=? WHERE id=?', [newChapter, entryId]);
          });
          return chain.then(function () { return { moved: true, chapter: newChapter }; });
        });
      });
    },

    /** 批量上下移动：选中的几条作为一个整体各挪一格（逐条挪，整块一起走） */
    moveEntries: function (ids, dir) {
      var self = this;
      var list = (ids || []).slice();
      if (!list.length) return Promise.resolve({ moved: false, count: 0 });
      return API.query('SELECT archive_id FROM entries WHERE id=?', [list[0]]).then(function (r0) {
        if (!r0.length) return { moved: false, count: 0 };
        return self._orderedEntries(r0[0].archive_id).then(function (order) {
          var pos = {}, i;
          for (i = 0; i < order.length; i++) pos[order[i].id] = i;
          var sel = [];
          for (i = 0; i < list.length; i++) if (pos.hasOwnProperty(list[i])) sel.push(list[i]);
          // 上移按从上到下、下移按从下到上，保证整块一起挪，不会互相顶住
          sel.sort(function (a, b) { return dir < 0 ? pos[a] - pos[b] : pos[b] - pos[a]; });
          var chain = Promise.resolve(), moved = 0;
          sel.forEach(function (id) {
            chain = chain.then(function () {
              return self.moveEntry(id, dir).then(function (r) { if (r && r.moved) moved++; });
            });
          });
          return chain.then(function () { return { moved: moved > 0, count: moved }; });
        });
      });
    },

    /** 把一条归到某章（chapterId 传 0/null 即退回「待归档」），排到该章末尾 */
    setEntryChapter: function (entryId, chapterId) {
      var cid = chapterId ? Number(chapterId) : null;
      return API.query('SELECT archive_id FROM entries WHERE id=?', [entryId]).then(function (r) {
        if (!r.length) return { ok: false };
        var aid = r[0].archive_id;
        var q = cid
          ? API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE archive_id=? AND chapter_id=?', [aid, cid])
          : API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE archive_id=? AND chapter_id IS NULL', [aid]);
        return q.then(function (kk) {
          var k = Number(kk[0].k || 0) + 10;
          return API.exec('UPDATE entries SET chapter_id=?, sort_key=? WHERE id=?', [cid, k, entryId])
            .then(function () { return { ok: true }; });
        });
      });
    },

    /**
     * 在指定位置插入一条（人类用法：正文里点「＋」，就在那儿出现，不再统一甩到章末）。
     * o: { afterId | chapterId, kind: 'text'|'quote'|'photo'|'media', text, photoId, mediaId }
     * afterId 有值 → 插在那条正后面（同章、sort_key 取中点）；
     * afterId 为空 → 放进 chapterId 这一章的末尾（章节为空也能插）。
     */
    insertAfter: function (archiveId, o) {
      o = o || {};
      var kind = o.kind || 'text';
      function loc() {
        if (o.afterId) {
          return API.query('SELECT chapter_id, sort_key, seq FROM entries WHERE id=?', [o.afterId]).then(function (r) {
            if (!r.length) return { ch: o.chapterId || null, k: 0 };
            return { ch: r[0].chapter_id, k: Number(r[0].sort_key || r[0].seq || 0) + 0.5 };
          });
        }
        var ch = o.chapterId || null;
        var q = ch
          ? API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE archive_id=? AND chapter_id=?', [archiveId, ch])
          : API.query('SELECT COALESCE(MAX(sort_key),0) k FROM entries WHERE archive_id=? AND chapter_id IS NULL', [archiveId]);
        return q.then(function (r) { return { ch: ch, k: Number(r[0].k || 0) + 10 }; });
      }
      return loc().then(function (L) {
        return API.exec(
          'INSERT INTO entries (archive_id,chapter_id,seq,kind,text,photo_id,media_id,origin,edited,sort_key) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [archiveId, L.ch, Math.round(L.k), kind, o.text || '', o.photoId || null, o.mediaId || null, 'user', 1, L.k]
        ).then(function (r) {
          if (kind === 'photo' && o.photoId) {
            return API.exec('UPDATE photos SET chapter_id=? WHERE id=?', [L.ch, o.photoId]).then(function () { return r; });
          }
          return r;
        });
      });
    },

    /** 章节上下移动：交换 seq，同样归一成 10/20/30…… */
    moveChapter: function (chapterId, dir) {
      return API.query('SELECT id, archive_id FROM chapters WHERE id=?', [chapterId]).then(function (rows) {
        if (!rows.length) return { moved: false };
        var aid = rows[0].archive_id;
        return API.query('SELECT id FROM chapters WHERE archive_id=? ORDER BY seq, id', [aid]).then(function (list) {
          var idx = -1, i;
          for (i = 0; i < list.length; i++) if (String(list[i].id) === String(chapterId)) { idx = i; break; }
          if (idx < 0) return { moved: false };
          var j = dir < 0 ? idx - 1 : idx + 1;
          if (j < 0 || j >= list.length) return { moved: false };
          var ids = [];
          for (i = 0; i < list.length; i++) ids.push(list[i].id);
          var tmp = ids[idx]; ids[idx] = ids[j]; ids[j] = tmp;
          var chain = Promise.resolve();
          ids.forEach(function (id2, k) {
            chain = chain.then(function () {
              return API.exec('UPDATE chapters SET seq=? WHERE id=?', [(k + 1) * 10, id2]);
            });
          });
          return chain.then(function () { return { moved: true }; });
        });
      });
    },

    /** 给一条文字/引用配一张照片（传 null 就是去掉配图） */
    setEntryPhoto: function (entryId, photoId) {
      return API.exec('UPDATE entries SET photo_id=? WHERE id=?', [photoId || null, entryId]);
    },

    /**
     * 改一条内容的时间。时间轴上四种内容都用它。
     * kind: entry | photo | segment | media；t: { year, month, day, label }
     */
    setTime: function (kind, id, t) {
      t = t || {};
      var y = t.year ? Number(t.year) : null;
      var m = t.month ? Number(t.month) : null;
      var d = t.day ? Number(t.day) : null;
      var label = t.label ? String(t.label) : null;
      var prec = y ? (d ? 'day' : (m ? 'month' : 'year')) : null;
      if (kind === 'photo') {
        return API.exec('UPDATE photos SET taken_year=?, taken_month=?, taken_day=? WHERE id=?',
          [y || 0, m, d, id]);
      }
      if (kind === 'segment') {
        return API.exec('UPDATE segments SET at_year=?, at_month=?, at_day=?, at_precision=?, at_label=? WHERE id=?',
          [y, m, d, prec, label, id]);
      }
      if (kind === 'media') {
        return API.exec('UPDATE media SET at_year=?, at_month=?, at_day=?, at_precision=?, at_label=? WHERE id=?',
          [y, m, d, prec, label, id]);
      }
      return API.exec('UPDATE entries SET at_year=?, at_month=?, at_day=?, at_precision=?, at_label=? WHERE id=?',
        [y, m, d, prec, label, id]);
    },

    /** 段落还没归章时，按年份找一章归进去；找不到就留在待归档 */
    placeEntryByYear: function (entryId, year) {
      if (!year) return Promise.resolve({ ok: false, chapterId: null });
      return API.query('SELECT archive_id, chapter_id FROM entries WHERE id=?', [entryId]).then(function (r) {
        if (!r.length) return { ok: false, chapterId: null };
        if (r[0].chapter_id) return { ok: false, chapterId: r[0].chapter_id };
        return DB.chapterForYear(r[0].archive_id, year).then(function (chId) {
          if (!chId) return { ok: false, chapterId: null };
          return DB.setEntryChapter(entryId, chId).then(function () {
            return { ok: true, chapterId: chId };
          });
        });
      });
    },

    /** 把一张照片挪到另一章：照片自己的章号 + 引用它的条目一起挪到那章末尾 */
    movePhotoChapter: function (photoId, chapterId) {
      var cid = chapterId ? Number(chapterId) : null;
      return API.exec('UPDATE photos SET chapter_id=? WHERE id=?', [cid, photoId]).then(function () {
        return API.query('SELECT id FROM entries WHERE photo_id=?', [photoId]);
      }).then(function (rows) {
        var chain = Promise.resolve();
        (rows || []).forEach(function (row) {
          chain = chain.then(function () { return DB.setEntryChapter(row.id, cid); });
        });
        return chain;
      }).then(function () { return { ok: true }; });
    },

    /* ================= v0.5：版本（原文只读） ================= */

    listVersions: function (entryId) {
      return API.query('SELECT * FROM entry_versions WHERE entry_id=? ORDER BY id DESC', [entryId]);
    },

    addVersion: function (entryId, archiveId, kind, style, text, model) {
      return API.exec(
        'INSERT INTO entry_versions (entry_id, archive_id, kind, style, text, status, model) VALUES (?,?,?,?,?,?,?)',
        [entryId, archiveId || null, kind || 'polish', style || null, String(text || ''), 'proposal', model || null]);
    },

    /**
     * 采纳一条版本：先把当前原文存成一条 kind='original'，再覆盖。
     * 顺序不能反——反了就把原文弄丢了，这本档案也就毁了。
     */
    acceptVersion: function (versionId) {
      return API.query('SELECT * FROM entry_versions WHERE id=?', [versionId]).then(function (rows) {
        if (!rows.length) throw new Error('找不到这条版本');
        var v = rows[0];
        return API.query('SELECT * FROM entries WHERE id=?', [v.entry_id]).then(function (er) {
          if (!er.length) throw new Error('原条目已不存在');
          var e = er[0];
          return API.exec(
            "INSERT INTO entry_versions (entry_id, archive_id, kind, style, text, status, model) VALUES (?,?,?,?,?,?,?)",
            [e.id, e.archive_id, 'original', null, String(e.text || ''), 'kept', null]
          ).then(function () {
            return API.exec('UPDATE entries SET text=?, edited=1 WHERE id=?', [String(v.text || ''), e.id]);
          }).then(function () {
            return API.exec("UPDATE entry_versions SET status='accepted' WHERE id=?", [versionId]);
          });
        });
      });
    },

    /* ================= v0.5：AI 对话 ================= */

    threads: function (archiveId) {
      return API.query(
        'SELECT * FROM ai_threads WHERE archive_id IS NULL OR archive_id=? ORDER BY updated_at DESC, id DESC LIMIT 50',
        [archiveId || null]);
    },

    createThread: function (archiveId, role, title) {
      return API.exec('INSERT INTO ai_threads (archive_id, role, title) VALUES (?,?,?)',
        [archiveId || null, role || 'interviewer', title || '新对话']).then(function (r) { return r.lastId; });
    },

    messages: function (threadId) {
      return API.query('SELECT * FROM ai_messages WHERE thread_id=? ORDER BY id', [threadId]);
    },

    addMessage: function (threadId, role, content, refs) {
      return API.exec('INSERT INTO ai_messages (thread_id, role, content, refs_json) VALUES (?,?,?,?)',
        [threadId, role, String(content || ''), refs ? JSON.stringify(refs) : null]).then(function (r) {
        return API.exec('UPDATE ai_threads SET updated_at=? WHERE id=?', [nowSql(), threadId]).then(function () { return r.lastId; });
      });
    },

    deleteThread: function (threadId) {
      return API.exec('DELETE FROM ai_messages WHERE thread_id=?', [threadId])
        .then(function () { return API.exec('DELETE FROM ai_threads WHERE id=?', [threadId]); });
    },


    /* ================= v0.7：润色（原文只读） ================= */

    POLISH_STYLES: {
      keep: { n: '保留口语', tip: '只修重复、口误和跑题，句子还是她自己的话' },
      written: { n: '书面化', tip: '改成通顺的书面语，仍保留原意与细节' },
      literary: { n: '文学化', tip: '稍微讲究一点用词，但不添加原文没有的东西' },
      dialect: { n: '保留方言', tip: '保留方言词与说法，只把听不清的地方理顺' },
      short: { n: '精简', tip: '压掉重复，留下信息，篇幅约减三分之一' },
    },

    /**
     * 润色一段原文。铁律：**不覆盖原文**，结果只进 entry_versions，
     * 采纳与否由人点。这是这本档案能活几十年的前提。
     */
    polishEntry: function (entryId, style) {
      var st = DB.POLISH_STYLES[style] || DB.POLISH_STYLES.keep;
      return API.query('SELECT * FROM entries WHERE id=?', [entryId]).then(function (rows) {
        if (!rows.length) throw new Error('找不到这段内容');
        var e = rows[0];
        var text = String(e.text || '').trim();
        if (text.length < 8) throw new Error('这段太短了，不值得润色');

        var sys = '你是一位资深口述史编辑。规则：' +
          '① 只修重复、口误、跑题，不添加原文没有的事实、人名、地名、数字；' +
          '② 保留说话人的语气与用词习惯，不把口语改成公文；' +
          '③ 不抒情、不总结、不加评论；' +
          '④ 直接输出润色后的正文，不要任何解释、标题或引号。' +
          '本次风格：' + st.n + '——' + st.tip + '。';

        return API.ai({
          messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
          temperature: 0.3,
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.message) || '模型没回话');
          var out = String(r.text || '').trim();
          if (!out) throw new Error('模型回了空内容');
          return DB.addVersion(entryId, e.archive_id, 'polish', style, out, r.model).then(function (res) {
            return { id: res.lastId, text: out, model: r.model, profile: r.profile };
          });
        });
      });
    },

    rejectVersion: function (versionId) {
      return API.exec("UPDATE entry_versions SET status='rejected' WHERE id=?", [versionId]);
    },

    /** 把这条条目退回某个版本（通常是 original） */
    restoreVersion: function (versionId) {
      return API.query('SELECT * FROM entry_versions WHERE id=?', [versionId]).then(function (rows) {
        if (!rows.length) throw new Error('找不到这个版本');
        var v = rows[0];
        return API.exec('UPDATE entries SET text=?, edited=1 WHERE id=?', [String(v.text || ''), v.entry_id])
          .then(function () { return API.exec("UPDATE entry_versions SET status='restored' WHERE id=?", [versionId]); });
      });
    },

    /* ================= v0.7：剧本 ================= */

    SCRIPT_SYS: '你是一位写实风格的编剧，正在把一位老人的口述整理成分场剧本。\n' +
      '规则：只能使用用户给的材料，不得虚构人名、时间、地点、事件；缺的细节写 [待考]，不要自己编。\n' +
      '必须把材料里的每一件事都排进戏里，按时间顺序推进，不许只挑开头几段写；材料多就多写几场，场次不设上限。\n' +
      '严格按下面的格式输出，不要任何额外说明：\n' +
      '【场 1】内景 · 〔地点〕 · 日 / 〔哪一年〕\n' +
      '人物：〔人名〕、〔人名〕\n' +
      '△ 一句话写动作或环境。\n' +
      '〔人名〕：台词写在这里。\n' +
      '〔人名〕：（小声）带情绪的台词这样写。\n' +
      '（每场之间空一行；对白一行一句；旁白用「旁白：」开头。）\n' +
      '注意：上面只是格式样板，括号里的〔地点〕〔人名〕〔哪一年〕是占位符。' +
      '真实写作时必须换成材料里出现的地点和人名，绝对不许把样板里的字样写进剧本。',

    generateScript: function (archiveId, chapterId, extra) {
      var chP = chapterId
        ? API.query('SELECT * FROM chapters WHERE id=?', [chapterId])
        : Promise.resolve([]);
      return Promise.all([chP, API.query('SELECT * FROM archives WHERE id=?', [archiveId])]).then(function (r) {
        var ch = r[0][0] || null;
        var a = r[1][0];
        if (!a) throw new Error('找不到这本档案');

        var q = chapterId
          ? API.query("SELECT text FROM entries WHERE chapter_id=? AND kind IN ('text','quote') ORDER BY COALESCE(sort_key,seq,0), id", [chapterId])
          : API.query("SELECT text FROM entries WHERE archive_id=? AND kind IN ('text','quote') ORDER BY COALESCE(sort_key,seq,0), id", [archiveId]);

        return q.then(function (rows) {
          var material = rows.map(function (x) { return String(x.text || '').trim(); })
            .filter(function (t) { return t.length > 4; }).join('\n');
          if (!material) throw new Error('这一章还没有内容，先讲几段再来');

          var head = '档案主角：' + a.subject_name + (a.birth_year ? '，' + a.birth_year + ' 年生' : '') +
            (a.hometown ? '，' + a.hometown + '人' : '') + '。\n' +
            (ch ? '本剧取材自：' + (ch.title || '') + (ch.year_from ? '（' + ch.year_from + '—' + (ch.year_to || ch.year_from) + '）' : '') + '\n'
              : '本剧取材自整本档案，共 ' + rows.length + ' 段口述。\n');

          return API.ai({
            messages: [
              { role: 'system', content: DB.SCRIPT_SYS },
              { role: 'user', content: head + '\n材料（原话，按人生顺序）：\n' + material + '\n\n' +
                (extra ? '这次的要求：' + extra + '\n\n' : '') +
                '请把这些材料全部排成戏，一场接一场按时间往下走；材料多就多分几场，不要只写开头。' },
            ],
            temperature: 0.5,
          }).then(function (out) {
            if (!out || !out.ok) throw new Error((out && out.message) || '模型没回话');
            var raw = String(out.text || '').trim();
            if (!raw) throw new Error('模型回了空内容');
            var parsed = DB.parseScript(raw);
            if (!parsed.length) throw new Error('这次没排成场次，换个模型再试');
            return API.exec(
              'INSERT INTO scripts (archive_id, chapter_id, title, json) VALUES (?,?,?,?)',
              [archiveId, chapterId || null, (ch && ch.title) || a.subject_name + ' · 剧本',
                JSON.stringify({ raw: raw, scenes: parsed })]
            ).then(function (res) {
              return { id: res.lastId, scenes: parsed, raw: raw };
            });
          });
        });
      });
    },

    /** 把模型输出的剧本文本拆成场次。模型偶尔不守格式，所以解析要宽进严出 */
    parseScript: function (raw) {
      var lines = String(raw || '').replace(/\r/g, '').split('\n');
      var scenes = [], cur = null;

      function push() {
        if (cur && (cur.dialogue.length || cur.action.length || cur.slug)) scenes.push(cur);
        cur = null;
      }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var head = /^【?\s*场\s*(\d+)\s*】?\s*(.*)$/.exec(line);
        if (head) {
          push();
          cur = { no: Number(head[1]) || scenes.length + 1, slug: head[2] || '', time: '', place: '',
            chars: [], action: [], dialogue: [] };
          continue;
        }
        if (!cur) {
          cur = { no: scenes.length + 1, slug: line, time: '', place: '', chars: [], action: [], dialogue: [] };
          continue;
        }
        var who = /^人物[：:]\s*(.+)$/.exec(line);
        if (who) {
          cur.chars = who[1].split(/[、,，\s]+/).filter(Boolean);
          continue;
        }
        if (line.charAt(0) === '△' || line.charAt(0) === '▲') {
          cur.action.push(line.slice(1).trim());
          continue;
        }
        var say = /^([^：:]{1,12})[：:]\s*(.+)$/.exec(line);
        if (say && cur.chars.length && cur.chars.indexOf(say[1].trim()) < 0 && say[1].length <= 12) {
          cur.dialogue.push({ who: say[1].trim(), line: say[2].trim() });
          continue;
        }
        if (say) {
          cur.dialogue.push({ who: say[1].trim(), line: say[2].trim() });
          continue;
        }
        cur.action.push(line);
      }
      push();
      return scenes;
    },

    listScripts: function (archiveId) {
      return API.query('SELECT * FROM scripts WHERE archive_id=? ORDER BY id DESC', [archiveId]);
    },

    getScript: function (id) {
      return API.query('SELECT * FROM scripts WHERE id=?', [id]).then(function (rows) {
        if (!rows.length) throw new Error('找不到这份剧本');
        var row = rows[0];
        var obj = {};
        try { obj = JSON.parse(row.json || '{}'); } catch (e) { obj = {}; }
        row.parsed = obj;
        return row;
      });
    },

    deleteScript: function (id) {
      return API.exec('DELETE FROM scripts WHERE id=?', [id]);
    },

    /** 剧本导出成纯文本：这是编剧与演员真正会用的格式 */
    scriptToText: function (row) {
      var obj = row.parsed || {};
      var scenes = obj.scenes || [];
      var out = [];
      out.push((row.title || '剧本'));
      out.push('');
      for (var i = 0; i < scenes.length; i++) {
        var s = scenes[i];
        out.push('【场 ' + (s.no || i + 1) + '】' + (s.slug || ''));
        if (s.chars && s.chars.length) out.push('人物：' + s.chars.join('、'));
        for (var a = 0; a < (s.action || []).length; a++) out.push('△ ' + s.action[a]);
        for (var d = 0; d < (s.dialogue || []).length; d++) {
          out.push(s.dialogue[d].who + '：' + s.dialogue[d].line);
        }
        out.push('');
      }
      return out.join('\n');
    },


    /* ================= v0.8：漫画（P6-T66~T68） ================= */

    /**
     * 把一个章节排成漫画分镜。
     *
     * 刻意不用模型：分镜是结构活，规则能做到「可预期、可重排、不花钱」。
     * 文字来自己有的讲述，图来自已有的插图或照片；缺图的格子留白，
     * 页面上标出来，让用户自己去补——这比让模型瞎编画面诚实得多。
     */
    buildComic: function (archiveId, chapterId, perPage) {
      var pp = Number(perPage) || 4;
      var qa = [
        API.query('SELECT * FROM archives WHERE id=?', [archiveId]),
        API.query('SELECT * FROM chapters WHERE id=?', [chapterId]),
        API.query('SELECT * FROM entries WHERE chapter_id=? ORDER BY sort_key, seq', [chapterId]),
        API.query('SELECT * FROM photos WHERE chapter_id=? ORDER BY taken_year, taken_month, id', [chapterId]),
        API.query("SELECT v FROM settings WHERE k=?", ['art.persona.' + archiveId]),
      ];
      return Promise.all(qa).then(function (r) {
        var a = r[0][0], ch = r[1][0], entries = r[2], photos = r[3];
        if (!a) throw new Error('找不到这本档案');
        if (!entries.length) throw new Error('这一章还没有讲述，先攒几段再来排漫画');

        // 图池：先按条目自带的 photo_id 精准匹配，剩下的按年份顺序轮着用
        var byId = {};
        for (var i = 0; i < photos.length; i++) byId[photos[i].id] = photos[i];
        var pool = photos.slice();
        var used = {};

        var panels = [];
        for (var e = 0; e < entries.length; e++) {
          var en = entries[e];
          var text = String(en.text || '').trim();
          if (!text) continue;

          var ph = en.photo_id ? byId[en.photo_id] : null;
          if (!ph) {
            // 找一张还没用过的、年份最接近的
            for (var k = 0; k < pool.length; k++) {
              if (!used[pool[k].id]) { ph = pool[k]; break; }
            }
          }
          if (ph) used[ph.id] = 1;

          panels.push({
            text: text,
            short: text.length > 70 ? text.slice(0, 70) : text,
            year: en.at_year || (ch && ch.year_from) || null,
            photo: ph ? ph.path : null,
            entryId: en.id,
          });
        }

        var pages = [];
        for (var p = 0; p < panels.length; p += pp) {
          pages.push({
            no: pages.length + 1,
            panels: panels.slice(p, p + pp),
          });
        }

        var json = {
          perPage: pp,
          layout: pp === 6 ? '2x3' : (pp === 2 ? '1x2' : '2x2'),
          title: (ch && ch.title) || a.subject_name,
          name: a.subject_name,
          archiveNo: a.archive_no || '',
          years: (ch && ch.year_from) ? (ch.year_from + (ch.year_to && ch.year_to !== ch.year_from ? '—' + ch.year_to : '')) : '',
          persona: (r[4][0] && r[4][0].v) || '',
          pages: pages,
        };

        return API.exec(
          'INSERT INTO storyboards (archive_id, chapter_id, layout, json) VALUES (?,?,?,?)',
          [archiveId, chapterId, json.layout, JSON.stringify(json)]
        ).then(function (res) {
          json.id = res.lastId;
          return json;
        });
      });
    },

    listComics: function (archiveId) {
      return API.query('SELECT * FROM storyboards WHERE archive_id=? ORDER BY id DESC', [archiveId]);
    },

    getComic: function (id) {
      return API.query('SELECT * FROM storyboards WHERE id=?', [id]).then(function (rows) {
        if (!rows.length) throw new Error('找不到这本漫画');
        var row = rows[0];
        try { row.parsed = JSON.parse(row.json || '{}'); } catch (e) { row.parsed = {}; }
        return row;
      });
    },

    /** 改一格的气泡文字。只改 json，不动原文——原文是档案，漫画是作品 */
    updateComicPanel: function (comicId, pageNo, idx, text) {
      return DB.getComic(comicId).then(function (row) {
        var j = row.parsed || {};
        var pg = (j.pages || [])[pageNo - 1];
        if (!pg || !pg.panels[idx]) throw new Error('找不到这一格');
        pg.panels[idx].short = String(text || '').slice(0, 200);
        return API.exec('UPDATE storyboards SET json=? WHERE id=?', [JSON.stringify(j), comicId])
          .then(function () { return j; });
      });
    },

    deleteComic: function (id) {
      return API.exec('DELETE FROM storyboards WHERE id=?', [id]);
    },

    /* ---------------- 工具 ---------------- */

    yearLabel: function (a, b) {
      if (!a) return '年份未填';
      return (b && b !== a) ? a + '—' + b : String(a);
    },

    findYear: findYear,
    nowSql: nowSql,
    clean: clean
  };

  window.DB = DB;
})();
