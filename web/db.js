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
    return '';
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

  var DB = {

    /* ---------------- 档案 ---------------- */

    listArchives: function () {
      return API.query(
        'SELECT a.*, ' +
        '(SELECT COUNT(*) FROM chapters c WHERE c.archive_id=a.id) AS chapter_count, ' +
        '(SELECT COUNT(*) FROM entries e WHERE e.archive_id=a.id) AS entry_count, ' +
        '(SELECT COUNT(*) FROM photos p WHERE p.archive_id=a.id) AS photo_count ' +
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
        API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [id]),
        API.query('SELECT * FROM entries WHERE archive_id=? ORDER BY seq', [id]),
        API.query('SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year', [id]),
        API.query('SELECT * FROM segments WHERE archive_id=? ORDER BY id', [id])
      ]).then(function (r) {
        return {
          archive: r[0][0] || null,
          chapters: r[1],
          entries: r[2],
          photos: r[3],
          segments: r[4]
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
     * 导入一本档案：所有 id 重新分配，媒体落成新文件。
     * 引用关系（条目→照片/媒体、封面、章）按导出时的旧 id 一一映射回去。
     */
    importArchive: function (pack) {
      if (!pack || pack.format !== 'mylife-archive' || !pack.archive) {
        return Promise.reject(new Error('这不是本程序导出的档案文件'));
      }
      var self = this;
      var a = pack.archive;
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

      return API.exec(
        'INSERT INTO archives (subject_name,birth_year,death_year,hometown,intro,status,archive_no,created_at,updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?)',
        [a.subject_name || '未命名', a.birth_year || null, a.death_year || null,
         a.hometown || null, a.intro || null, 'ready', a.archive_no || null, nowSql(), nowSql()]
      ).then(function (ar) {
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
      if (/cogvideo|seedance|video/.test(s)) return 't2v';
      return 'text';
    },

    /** 2026-10 实测的免费档模型。不在名单里的按付费提示 */
    isFreeModel: function (id) {
      var s = String(id || '');
      if (/^Pro\//.test(s)) return false;          // Pro 前缀是付费加速版
      return /hunyuan-mt|qwen3-8b$|qwen3\.5-4b$|deepseek-ocr|qwen3-asr|glm-4-9b|kolors|cosyvoice|sensevoice|bge-|r1-0528-qwen3-8b/i.test(s);
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
          asr: ['Qwen/Qwen3-ASR-1.7B', 'FunAudioLLM/SenseVoiceSmall']
        };
        var KIND = { title: 'text', vision: 'vision', asr: 'asr' };
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
        'UPDATE archives SET subject_name=?, birth_year=?, death_year=?, hometown=?, intro=?, updated_at=? WHERE id=?',
        [String(f.name || '').trim(), f.birth || null, f.death || null,
         String(f.hometown || '').trim(), String(f.intro || '').trim(), nowSql(), id]);
    },

    updateChapter: function (id, title, summary) {
      return API.exec('UPDATE chapters SET title=?, summary=? WHERE id=?',
        [String(title || '').trim(), String(summary || '').trim(), id]);
    },

    updateEntry: function (id, text) {
      var t = String(text || '').trim();
      if (!t) return Promise.reject(new Error('内容不能是空的'));
      return API.exec('UPDATE entries SET text=? WHERE id=?', [t, id]);
    },

    /** 删条目。章里一条不剩就把章也收走，免得留下空标题 */
    deleteEntry: function (id) {
      return API.query('SELECT chapter_id FROM entries WHERE id=?', [id]).then(function (rows) {
        var cid = rows.length ? rows[0].chapter_id : null;
        return API.exec('DELETE FROM entries WHERE id=?', [id]).then(function (r) {
          if (!cid) return r;
          return API.query('SELECT count(*) n FROM entries WHERE chapter_id=?', [cid])
            .then(function (c) {
              if (c[0].n === 0) {
                return API.exec('DELETE FROM chapters WHERE id=?', [cid]).then(function () { return r; });
              }
              return r;
            });
        });
      });
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
    addMediaEntry: function (archiveId, chapterId, kind, base64, mime, caption, ext) {
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
          // 排到该章最后；没章就归待归档
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
      return API.query('SELECT * FROM segments WHERE id=?', [segId]).then(function (rows) {
        if (!rows.length) return Promise.reject(new Error('找不到这段讲述'));
        var seg = rows[0];
        if (!seg.audio_path) return Promise.reject(new Error('这段没有录音可以转'));

        return API.asr({
          path: seg.audio_path,
          slot: 'asr',        // 默认用「语音转文字」绑的那条；显式 profileId 时以它为准
          profileId: (opts && opts.profileId) || null,
          model: (opts && opts.model) || null,
          language: (opts && opts.language) || null,
        }).then(function (r) {
          if (!r.ok) return r;
          var old = String(seg.raw_text || '');
          var isPlaceholder = !old || old.indexOf('待转写') >= 0 || old.indexOf('录音已保存') >= 0;
          var merged = isPlaceholder ? r.text : old + '\n' + r.text;
          return API.exec('UPDATE segments SET raw_text=?, year_hint=? WHERE id=?',
            [merged, findYear(merged) || seg.year_hint, segId]).then(function () {
            return { ok: true, ms: r.ms, model: r.model, text: r.text, merged: merged };
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
              return API.exec("UPDATE archives SET status='ready', updated_at=? WHERE id=?", [nowSql(), archiveId]);
            });
          });
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
