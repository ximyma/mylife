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
 * 云端模型调用。
 *
 * 为什么在原生侧发请求，而不是让前端 fetch：
 *   ① 多数 LLM 接口不允许浏览器跨域直连；
 *   ② API Key 必须留在原生侧，不能出现在 JS 和 DevTools 里；
 *   ③ WebView 里长连接容易被系统掐断。
 *
 * 支持：
 *   - OpenAI 兼容（/v1/chat/completions、/v1/models）
 *   - DeepSeek 官方、硅基流动、vLLM、各类中转站（同一套协议）
 *   - 本机 Ollama（http://127.0.0.1:11434/v1，无需 Key）
 *   - 多模态：messages 里带 image_url 直接透传
 */
public final class Ai {

    private static final String TAG = "Ai";
    private static final int T_CHAT = 120000;
    private static final int T_LIST = 20000;
    private static final int T_TEST = 40000;

    private Ai() {}

    /* ================= 配置选取 ================= */

    private static JSONObject one(Db db, String sql, JSONArray args) throws Exception {
        JSONArray rows = new JSONArray(db.query(sql, args));
        return rows.length() > 0 ? rows.getJSONObject(0) : null;
    }

    private static JSONObject byId(Db db, int id) throws Exception {
        return one(db, "SELECT * FROM ai_profiles WHERE id=?", new JSONArray().put(id));
    }

    private static JSONObject forSlot(Db db, String slot) throws Exception {
        JSONObject row = one(db, "SELECT profile_id, model FROM ai_slots WHERE slot=?",
                new JSONArray().put(slot));
        if (row == null || row.isNull("profile_id")) return null;
        JSONObject p = byId(db, row.optInt("profile_id"));
        if (p == null) return null;
        String m = row.optString("model", "");
        if (m.length() > 0) p.put("__model", m);
        return p;
    }

    private static JSONObject pick(Db db, JSONObject in) throws Exception {
        if (in != null && in.has("profileId") && !in.isNull("profileId")) {
            JSONObject p = byId(db, in.optInt("profileId"));
            if (p != null) {
                if (in.has("model") && in.optString("model", "").length() > 0) {
                    p.put("__model", in.optString("model"));
                }
                return p;
            }
        }
        if (in != null && in.has("slot")) {
            JSONObject p = forSlot(db, in.optString("slot"));
            if (p != null) return p;
        }
        return one(db, "SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id LIMIT 1", new JSONArray());
    }

    private static String modelOf(JSONObject p) {
        String m = p.optString("__model", "");
        if (m.length() > 0) return m;
        return p.optString("default_model", "");
    }

    /* ================= HTTP ================= */

    private static JSONObject call(String url, String method, String apiKey, String body, int timeout) {
        JSONObject out = new JSONObject();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(timeout);
            conn.setRequestProperty("Content-Type", "application/json");
            if (apiKey != null && apiKey.length() > 0) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            if (body != null) {
                conn.setDoOutput(true);
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is);
            out.put("status", code);
            out.put("text", text);
            try { out.put("json", new JSONObject(text)); } catch (Exception ignored) {}
            return out;

        } catch (Exception e) {
            Log.w(TAG, "请求失败 " + url, e);
            try {
                out.put("status", -1);
                out.put("text", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {}
            return out;
        } finally {
            if (conn != null) conn.disconnect();
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

    private static String base(JSONObject p) {
        String b = p.optString("base_url", "");
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    private static String shorten(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    /* ================= 拉模型 ================= */

    public static String models(Context ctx, Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            JSONObject p = in.has("profileId") ? byId(db, in.optInt("profileId")) : null;
            if (p == null) return msg(false, "没有这条配置");

            JSONObject r = call(base(p) + "/models", "GET", p.optString("api_key", ""), null, T_LIST);
            int status = r.optInt("status", -1);
            if (status != 200) {
                return msg(false, "拉不到模型（HTTP " + status + "）：" + shorten(r.optString("text"), 160));
            }
            JSONObject j = r.optJSONObject("json");
            JSONArray list = null;
            if (j != null) {
                list = j.optJSONArray("data");
                if (list == null) list = j.optJSONArray("models");
            }
            JSONArray ids = new JSONArray();
            if (list != null) {
                for (int i = 0; i < list.length(); i++) {
                    JSONObject m = list.optJSONObject(i);
                    if (m == null) continue;
                    String id = m.optString("id", m.optString("name", m.optString("model", "")));
                    if (id.length() > 0) ids.put(id);
                }
            }
            JSONArray args = new JSONArray();
            args.put(ids.toString());
            args.put(p.optInt("id"));
            db.exec("UPDATE ai_profiles SET models_json=? WHERE id=?", args);

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("models", ids);
            o.put("count", ids.length());
            return o.toString();

        } catch (Exception e) {
            return msg(false, String.valueOf(e.getMessage()));
        }
    }

    /* ================= 测试 ================= */

    public static String test(Context ctx, Db db, String payload) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject in = Json.obj(payload);
            JSONObject p = pick(db, in);
            if (p == null) return msg(false, "还没有可用的模型配置");
            String model = modelOf(p);
            if (model.length() == 0) return msg(false, "这条配置还没选模型");

            JSONObject body = new JSONObject();
            body.put("model", model);
            JSONArray msgs = new JSONArray();
            JSONObject m0 = new JSONObject();
            m0.put("role", "user");
            m0.put("content", "只回两个字：可用");
            msgs.put(m0);
            body.put("messages", msgs);
            body.put("temperature", 0);
            body.put("max_tokens", 16);
            body.put("stream", false);

            JSONObject r = call(base(p) + "/chat/completions", "POST",
                    p.optString("api_key", ""), body.toString(), T_TEST);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, "HTTP " + status + "：" + shorten(r.optString("text"), 200));
                o.put("ms", ms);
                return o.toString();
            }

            JSONObject j = r.optJSONObject("json");
            String text = "";
            if (j != null) {
                JSONArray ch = j.optJSONArray("choices");
                if (ch != null && ch.length() > 0) {
                    JSONObject msg = ch.optJSONObject(0).optJSONObject("message");
                    if (msg != null) text = msg.optString("content", "");
                }
            }
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("ms", ms);
            o.put("model", model);
            o.put("profile", p.optString("name", ""));
            o.put("reply", shorten(text.trim(), 40));
            return o.toString();

        } catch (Exception e) {
            return msg(false, "出错了：" + e.getMessage());
        }
    }

    /* ================= 对话 ================= */

    public static String chat(Context ctx, Db db, String payload) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject in = Json.obj(payload);
            JSONObject p = pick(db, in);
            if (p == null) return msg(false, "还没配模型。打开「设置 → 模型」加一条。");

            String model = modelOf(p);
            if (model.length() == 0) return msg(false, "这条配置还没选模型");

            JSONArray messages = in.optJSONArray("messages");
            if (messages == null || messages.length() == 0) return msg(false, "没有要发送的内容");

            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", messages);
            body.put("temperature", in.optDouble("temperature", 0.7));
            if (in.has("maxTokens")) body.put("max_tokens", in.optInt("maxTokens"));
            body.put("stream", false);

            JSONObject r = call(base(p) + "/chat/completions", "POST",
                    p.optString("api_key", ""), body.toString(), T_CHAT);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, "模型返回 " + status + "：" + shorten(r.optString("text"), 200));
                o.put("ms", ms);
                return o.toString();
            }

            JSONObject j = r.optJSONObject("json");
            String text = "";
            JSONObject usage = null;
            if (j != null) {
                JSONArray ch = j.optJSONArray("choices");
                if (ch != null && ch.length() > 0) {
                    JSONObject msg = ch.getJSONObject(0).optJSONObject("message");
                    if (msg != null) text = msg.optString("content", "");
                }
                usage = j.optJSONObject("usage");
            }

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("ms", ms);
            o.put("model", model);
            o.put("profile", p.optString("name", ""));
            o.put("text", text);
            if (usage != null) o.put("usage", usage);
            return o.toString();

        } catch (Exception e) {
            Log.w(TAG, "chat 失败", e);
            return msg(false, "调不通：" + e.getMessage());
        }
    }

    /* ================= 小工具 ================= */

    private static JSONObject msgObj(boolean ok, String text) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("message", text);
        } catch (Exception ignored) {}
        return o;
    }

    private static String msg(boolean ok, String text) {
        return msgObj(ok, text).toString();
    }
}
