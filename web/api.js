/**
 * 唯一的"后端"入口。
 * 安卓：http://127.0.0.1:<port>/api/*（LocalServer）
 * 网页：http://localhost/ api/*（server.js）
 * 两边接口一模一样，这里不需要区分。
 *
 * 刻意用 XMLHttpRequest 而不是 fetch：
 *   安卓 5/6 的 WebView 内核是 Chrome 37 左右，没有 fetch。
 *   XHR 从 IE7 时代就有，绝对不会翻车。
 */
(function () {
  'use strict';

  function post(path, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 120000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0) return reject(new Error('连不上本地服务'));
        var j;
        try {
          j = JSON.parse(xhr.responseText);
        } catch (e) {
          return reject(new Error('返回的不是 JSON：' + String(xhr.responseText).slice(0, 80)));
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

  window.API = {
    query: function (sql, params) {
      return post('/api/query', { sql: sql, params: params || [] });
    },
    exec: function (sql, params) {
      return post('/api/exec', { sql: sql, params: params || [] });
    },
    ai: function (messages) {
      return post('/api/ai', { messages: messages });
    },
    file: function (payload) {
      return post('/api/file', payload || {});
    }
  };
})();
