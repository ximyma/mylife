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

    /** 语音转文字：opts { path, profileId?, model?, language? }，长音频要等，超时放宽 */
    asr: function (opts) {
      return post('/api/asr', opts || {}, 200000);
    },

    file: function (payload) {
      return post('/api/file', payload || {});
    },

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
      token: token,
      setToken: setToken,
      /** app.js 注入 401 跳转回调 */
      onUnauthorized: function (fn) { onUnauthorized = fn; }
    }
  };
})();
