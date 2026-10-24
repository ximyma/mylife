/**
 * 唯一的"后端"入口。
 * 安卓：http://127.0.0.1:<port>/api/*（LocalServer）
 * 网页：http://localhost/ api/*（server.js）
 * 两边接口一模一样，这里不需要区分。
 *
 * 刻意用 XMLHttpRequest 而不是 fetch：
 *   安卓 5/6 的 WebView 内核是 Chrome 37 左右，没有 fetch。
 *
 * v0.3 起要登录：每个请求带 Authorization 头；401 统一踢回登录页。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'mylife.token';
  var onUnauthorized = null;   // app.js 注入：收到 401 时跳登录页

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function post(path, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      var t = token();
      if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
      xhr.timeout = timeoutMs || 130000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0) return reject(new Error('连不上本地服务'));
        var j;
        try {
          j = JSON.parse(xhr.responseText);
        } catch (e) {
          return reject(new Error('返回的不是 JSON：' + String(xhr.responseText).slice(0, 80)));
        }
        if (xhr.status === 401) {
          setToken('');
          if (onUnauthorized) onUnauthorized();
          var err401 = new Error((j && (j.__auth || j.message)) || '需要登录');
          err401.unauthorized = true;
          return reject(err401);
        }
        if (j && j.__error) return reject(new Error(j.__error));
        if (xhr.status >= 400) return reject(new Error((j && j.message) || ('HTTP ' + xhr.status)));
        resolve(j);
      };
      xhr.onerror = function () { reject(new Error('网络出错了')); };
      xhr.ontimeout = function () { reject(new Error('等太久了，稍后再试')); };
      xhr.send(JSON.stringify(body || {}));
    });
  }

  /** 与 post 同构，但发 DELETE（用户删除用）。401 同样踢回登录页。 */
  function del(path, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('DELETE', path, true);
      var t = token();
      if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
      xhr.timeout = timeoutMs || 30000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0) return reject(new Error('连不上本地服务'));
        var j;
        try { j = JSON.parse(xhr.responseText); } catch (e) { return reject(new Error('返回的不是 JSON：' + String(xhr.responseText).slice(0, 80))); }
        if (xhr.status === 401) {
          setToken('');
          if (onUnauthorized) onUnauthorized();
          var e401 = new Error((j && (j.__auth || j.message)) || '需要登录');
          e401.unauthorized = true;
          return reject(e401);
        }
        if (j && j.__error) return reject(new Error(j.__error));
        if (xhr.status >= 400) return reject(new Error((j && j.message) || ('HTTP ' + xhr.status)));
        resolve(j);
      };
      xhr.onerror = function () { reject(new Error('网络出错了')); };
      xhr.ontimeout = function () { reject(new Error('等太久了，稍后再试')); };
      xhr.send();
    });
  }

  /**
   * 安卓端 SQLite 读出来的每一列都是字符串（Cursor.getString），
   * 电脑端 node:sqlite 给的是数字。于是 profiles[i].id === 1 这种比较
   * 在手机上永远是 false——「改配置」「删档案」点了没反应就是这么来的。
   *
   * 与其在每个调用点写 String()，不如在唯一入口把数字型的列还原成数字：
   * 两边数据形状一致，后面就不会再踩同一个坑。
   */
  var NUM_FIELD = /^(id|uid|seq|sort|enabled|.*_id|.*_count|.*_year|year|year_from|year_to|taken_year|birth_year|death_year|width|height|bytes|size)$/;

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) return rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== 'object') continue;
      for (var k in r) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        if (!NUM_FIELD.test(k)) continue;
        var v = r[k];
        if (typeof v !== 'string' || v === '') continue;
        if (/^-?\d+$/.test(v)) { r[k] = Number(v); continue; }
        if (/^-?\d+\.\d+$/.test(v)) r[k] = Number(v);
      }
    }
    return rows;
  }

  /**
   * 流式对话：服务端按行吐 NDJSON（{t:'d',v:'字'} / {t:'retry'} / {t:'done'} / {t:'err'}）。
   * 用 XHR 的 onprogress 增量读——EventSource 带不了 Authorization 头，
   * ReadableStream 在安卓 5/6 的 WebView 里根本不存在。
   *
   * onEvent(evt) 每解析出一行调用一次；返回值 resolve 完整文本。
   */
  function chatStream(opts, onEvent) {
    var abortFn = null;
    var p = new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      abortFn = function () { try { xhr.abort(); } catch (e) {} };
      xhr.open('POST', '/api/ai/chat', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      var t = token();
      if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
      xhr.timeout = 300000;

      var offset = 0, buf = '', full = '', finished = false, streamError = null;

      function feed(final) {
        var text = String(xhr.responseText || '');
        if (text.length <= offset) return;
        buf += text.slice(offset);
        offset = text.length;
        var nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line) continue;
          var evt;
          try { evt = JSON.parse(line); } catch (e) { continue; }
          // 安卓端还没有流式接口时，会回 {__error:"未知接口 …"}，转成统一的错误事件
          if (evt && evt.__error) evt = { t: 'err', message: evt.__error };
          if (evt.t === 'd') full += evt.v;
          if (evt.t === 'done') finished = true;
          if (evt.t === 'err') streamError = evt.message || '调用失败';
          if (onEvent) { try { onEvent(evt); } catch (e) {} }
        }
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 3) feed(false);
        if (xhr.readyState !== 4) return;
        feed(true);
        if (xhr.status === 401) {
          setToken('');
          if (onUnauthorized) onUnauthorized();
          return reject(new Error('需要登录'));
        }
        if (xhr.status === 0) return reject(new Error('连不上本地服务'));
        if (streamError) return reject(new Error(streamError));
        if (finished) return resolve(full);
        reject(new Error(finished ? '对话中断' : (full ? '输出被截断' : '没有收到回复')));
      };
      xhr.onerror = function () { reject(new Error('网络出错了')); };
      xhr.ontimeout = function () { reject(new Error('等太久了，稍后再试')); };
      xhr.send(JSON.stringify(opts || {}));
    });
    p.abort = function () { if (abortFn) abortFn(); };
    return p;
  }

  window.API = {
    query: function (sql, params) {
      return post('/api/query', { sql: sql, params: params || [] }).then(normalizeRows);
    },
    exec: function (sql, params) {
      return post('/api/exec', { sql: sql, params: params || [] });
    },

    /** opts: { messages, profileId, slot, model, temperature, maxTokens } */
    ai: function (opts) {
      return post('/api/ai', opts || {});
    },

    /** 拉某条配置的模型列表 */
    aiModels: function (profileId) {
      return post('/api/ai/models', { profileId: profileId });
    },

    /** 测试连通性：opts { profileId, model } 或 { slot } */
    aiTest: function (opts) {
      return post('/api/ai/test', opts || {});
    },

    /** 插图生成：opts { prompt, size?, steps?, cfg?, profileId? } -> {ok, path, cached} */
    image: function (opts) {
      return post('/api/image', opts || {}, 200000);
    },

    /** 短片分镜：规则生成，不调模型 -> { frames, seconds, missing } */
    moviePlan: function (opts) {
      return post('/api/movie/plan', opts || {}, 60000);
    },

    /** 渲染能力探测：ffmpeg 在不在 */
    renderProbe: function () {
      return post('/api/render/probe', {}, 30000);
    },

    /** 语音合成：opts { text, speed?, voice?, profileId? } -> {ok, path, cached} */
    tts: function (opts) {
      return post('/api/tts', opts || {}, 120000);
    },

    /** 语音转文字：opts { path, profileId?, model?, language? }，长音频要等，超时放宽 */
    asr: function (opts) {
      return post('/api/asr', opts || {}, 200000);
    },

    file: function (payload) {
      return post('/api/file', payload || {});
    },

    /* ---- v0.5：任务队列 / 用量 / 流式对话 / 导出 ---- */
    chatStream: chatStream,

    job: {
      create: function (type, payload) { return post('/api/jobs/create', { type: type, payload: payload || {} }); },
      get: function (id) { return post('/api/jobs', { id: id }); },
      list: function () { return post('/api/jobs', {}); },
      cancel: function (id) { return post('/api/jobs/cancel', { id: id }); }
    },

    usage: function (days) { return post('/api/ai/usage', { days: days || 30 }); },

    exportPdf: function (payload) { return post('/api/export/pdf', payload || {}, 180000); },
    exportSave: function (payload) { return post('/api/export/save', payload || {}, 120000); },

    /* ---- 账号（v0.3） ---- */
    auth: {
      register: function (phone, password, code, nickname) {
        return post('/api/auth/register', { phone: phone, password: password, code: code, nickname: nickname });
      },
      login: function (phone, password) {
        return post('/api/auth/login', { phone: phone, password: password });
      },
      logout: function () {
        return post('/api/auth/logout', {});
      },
      me: function () {
        return post('/api/auth/me', {});
      },
      sms: function (phone) {
        return post('/api/auth/sms', { phone: phone });
      },
      debugData: function () {
        return post('/api/debug/data', {});
      },
      /* ---- 用户管理（v0.9 单机版） ---- */
      users: function () { return post('/api/auth/users', {}); },
      createUser: function (phone, password, nickname, isAdmin) {
        return post('/api/auth/users', { phone: phone, password: password, nickname: nickname, isAdmin: !!isAdmin });
      },
      deleteUser: function (id) { return del('/api/auth/users/' + id); },
      resetUser: function (id, password) { return post('/api/auth/users/' + id + '/reset', { password: password }); },
      changePassword: function (oldP, password) { return post('/api/auth/me/password', { old: oldP, password: password }); },
      setSecurity: function (question, answer) { return post('/api/auth/me/security', { question: question, answer: answer }); },
      recoverQuestion: function (phone) { return post('/api/auth/recover/q', { phone: phone }); },
      recover: function (phone, answer, password) { return post('/api/auth/recover', { phone: phone, answer: answer, password: password }); },
      token: token,
      setToken: setToken,
      /** app.js 注入 401 跳转回调 */
      onUnauthorized: function (fn) { onUnauthorized = fn; }
    }
  };
})();
