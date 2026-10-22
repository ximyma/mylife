package com.mylife.archive;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 调用云端模型。
 *
 * 为什么在原生侧发请求，而不是让前端 fetch：
 *   ① 多数 LLM 接口不允许浏览器跨域直连；
 *   ② API Key 必须留在原生侧，不能出现在 JS 和 DevTools 里；
 *   ③ WebView 里 fetch 长连接容易被系统掐断。
 *
 * 前端只发 {messages:[...]}，这里补 model / temperature，Key 从 settings 读。
 */
public final class Ai {

    private static final String TAG = "Ai";
    private static final int TIMEOUT = 90000;

    private Ai() {}

    public static String chat(Context ctx, Db db, String payload) {
        try {
            String base = db.setting("ai.base");
            String key = db.setting("ai.key");
            String model = db.setting("ai.model");
            String temp = db.setting("ai.temp");

            if (base == null || base.trim().length() == 0) {
                return msg(false, "还没配模型。打开「设置 → 模型」，填上接口地址和 Key。");
            }
            if (key == null || key.trim().length() == 0) {
                return msg(false, "还没填 API Key。");
            }

            JSONObject in = Json.obj(payload);
            JSONArray messages = in.optJSONArray("messages");
            if (messages == null || messages.length() == 0) {
                return msg(false, "没有要发送的内容");
            }

            JSONObject body = new JSONObject();
            body.put("model", model == null || model.length() == 0 ? "deepseek-ai/DeepSeek-V4-Flash" : model);
            body.put("messages", messages);
            body.put("temperature", temp == null ? 0.7 : Double.parseDouble(temp));
            body.put("stream", false);

            String url = base.endsWith("/") ? base + "chat/completions" : base + "/chat/completions";
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(TIMEOUT);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + key);

            OutputStream os = conn.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is);
            conn.disconnect();

            if (code >= 400) {
                Log.w(TAG, "HTTP " + code + " " + text);
                return msg(false, "模型返回 " + code + "：" + shorten(text, 200));
            }

            JSONObject res = new JSONObject(text);
            JSONArray choices = res.optJSONArray("choices");
            String content = "";
            if (choices != null && choices.length() > 0) {
                JSONObject c0 = choices.getJSONObject(0);
                JSONObject m = c0.optJSONObject("message");
                if (m != null) content = m.optString("content", "");
            }

            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("text", content);
            return out.toString();

        } catch (Exception e) {
            Log.w(TAG, "调用失败", e);
            return msg(false, "调不通：" + e.getMessage());
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    private static String shorten(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    private static String msg(boolean ok, String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            o.put("message", text);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }
}
