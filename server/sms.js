'use strict';
/*
 * 短信通道钩子。v0.3 用固定验证码（1234），这个文件是空实现占位。
 * v0.4 接阿里云/腾讯云短信时，只实现这里的 send()，注册逻辑一行不改。
 */

/** 发送验证码。返回 {ok, fixed:true} 表示演示模式（前端会提示验证码是 1234） */
function send(phone, code) {
  // TODO v0.4: 接入真实短信服务商
  //   阿里云: dysmsapi  SendSms
  //   腾讯云: sms SendSms
  //   模板参数 { code }, 60s 限一条、24h 限十条（服务端已在 auth 层限速）
  return { ok: true, fixed: true };
}

module.exports = { send };
