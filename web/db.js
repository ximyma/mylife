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
  function findYear(text) {
    var m = String(text || '').match(/(1[89]\d{2}|20\d{2})\s*年?/);
    return m ? parseInt(m[1], 10) : null;
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
