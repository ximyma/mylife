package com.mylife.archive;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
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
    private static final int T_ASR = 180000;

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

    /** 1 秒静音 WAV（16k 单声道 16bit）：只用来探转写接口通不通，内容无所谓 */
    private static byte[] tinyWav(int seconds) {
        int rate = 16000;
        int n = rate * Math.max(1, seconds);
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + n * 2);
        b.order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes());
        b.putInt(36 + n * 2);
        b.put("WAVE".getBytes());
        b.put("fmt ".getBytes());
        b.putInt(16);
        b.putShort((short) 1);
        b.putShort((short) 1);
        b.putInt(rate);
        b.putInt(rate * 2);
        b.putShort((short) 2);
        b.putShort((short) 16);
        b.put("data".getBytes());
        b.putInt(n * 2);
        return b.array();
    }

    public static String test(Context ctx, Db db, String payload) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject in = Json.obj(payload);
            JSONObject p = pick(db, in);
            if (p == null) return msg(false, "还没有可用的模型配置");
            String model = modelOf(p);
            if (model.length() == 0) return msg(false, "这条配置还没选模型");

            // 语音模型不能拿对话接口试：ASR 模型在 /chat/completions 上一律
            // "Model does not exist"，看着像配置错，其实是接口用错了。
            // 这里真发 1 秒静音 WAV 到 /audio/transcriptions，HTTP 200 就算通。
            if ("asr".equals(in.optString("slot", ""))) {
                JSONObject fields = new JSONObject();
                fields.put("model", model);
                JSONObject r2 = callMultipart(base(p) + "/audio/transcriptions",
                        p.optString("api_key", ""), tinyWav(1), "file", "probe.wav",
                        "audio/wav", fields, T_TEST);
                long ms2 = System.currentTimeMillis() - t0;
                int st2 = r2.optInt("status", -1);
                if (st2 != 200) {
                    String body2 = shorten(r2.optString("text"), 200);
                    String hint = "";
                    if (body2.matches("(?s).*(20012|does not exist|model_not_found|invalid model).*")) {
                        hint = "\n→ 这个模型不支持转写接口。硅基流动免费能转写的只有 "
                                + "FunAudioLLM/SenseVoiceSmall 和 TeleAI/TeleSpeechASR。";
                    }
                    JSONObject o = msgObj(false, "HTTP " + st2 + "：" + body2 + hint);
                    o.put("ms", ms2);
                    return o.toString();
                }
                JSONObject o = msgObj(true, "转写接口可用");
                o.put("ms", ms2);
                o.put("model", model);
                o.put("profile", p.optString("name", ""));
                o.put("reply", "转写接口可用（发了一段静音测试音）");
                return o.toString();
            }

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

    /* ================= 语音转文字 ================= */

    /**
     * 语音转文字：把已经存好的音频交给模型的 /v1/audio/transcriptions。
     *
     * 为什么这里要用 multipart 而不是 JSON：语音识别的上行约定就是文件字段，
     * OpenAI 兼容的这个 endpoint 各家实现清一色收 form-data。
     *
     * payload: { path: 'audio/xxx.webm', profileId?, model?, language? }
     */
    public static String asr(Context ctx, long uid, Db db, String payload) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject in = Json.obj(payload);

            // 优先用「语音转文字」这个用途绑定的配置
            if (!in.has("slot")) in.put("slot", "asr");
            JSONObject p = pick(db, in);
            if (p == null) return msg(false, "没有可用的语音模型。去设置里给「语音转文字」绑一条配置。");

            String model = in.optString("model", "");
            if (model.length() == 0) model = modelOf(p);
            if (model.length() == 0) return msg(false, "这条配置还没选模型");

            String rel = in.optString("path", "").replace("..", "").replace("\\", "/");
            if (rel.length() == 0) return msg(false, "没有指定音频");
            // 与 LocalServer 的 /files/、Files.java 同一套根目录：users/<uid>/files/
            // v0.3.3 修：原来少了 users/<uid> 这一层，v0.3 之后录的音一律"找不到这个音频文件"
            File f = new File(new File(new File(new File(ctx.getFilesDir(), "users"),
                    String.valueOf(uid)), "files"), rel);
            if (!f.exists()) return msg(false, "找不到这个音频文件");
            long size = f.length();
            if (size > 25L * 1024 * 1024) {
                return msg(false, "音频 " + Math.round(size / 1048576.0)
                        + "MB，超过服务端 25MB 上限，请先分段");
            }

            String name = f.getName().toLowerCase();
            String mime = name.endsWith(".wav") ? "audio/wav"
                    : name.endsWith(".mp3") ? "audio/mpeg"
                    : name.endsWith(".m4a") ? "audio/mp4"
                    : name.endsWith(".aac") ? "audio/aac"
                    : name.endsWith(".ogg") ? "audio/ogg"
                    : name.endsWith(".flac") ? "audio/flac"
                    : name.endsWith(".mp4") ? "audio/mp4"
                    : name.endsWith(".webm") ? "audio/webm" : "audio/mpeg";

            JSONObject fields = new JSONObject();
            fields.put("model", model);
            if (in.optString("language", "").length() > 0) {
                fields.put("language", in.optString("language", ""));
            }

            JSONObject r = callMultipart(base(p) + "/audio/transcriptions",
                    p.optString("api_key", ""), readFile(f), "file", f.getName(), mime,
                    fields, T_ASR);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, "HTTP " + status + "：" + shorten(r.optString("text"), 200));
                o.put("ms", ms);
                return o.toString();
            }

            JSONObject j = r.optJSONObject("json");
            String text = j != null ? j.optString("text", "") : "";
            if (text.trim().length() == 0) {
                return msg(false, "转出来是空的。录音里可能没说话，或者这段音频格式不支持。");
            }

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("ms", ms);
            o.put("model", model);
            o.put("text", text.trim());
            o.put("bytes", size);
            if (j != null) {
                if (j.has("usage")) o.put("usage", j.get("usage"));
                if (j.has("language")) o.put("language", j.get("language"));
            }
            return o.toString();

        } catch (Exception e) {
            Log.w(TAG, "asr 失败", e);
            return msg(false, "转不了：" + e.getMessage());
        }
    }

    /** 手写的 multipart/form-data 上行 */
    private static JSONObject callMultipart(String url, String apiKey, byte[] data,
            String field, String fileName, String mime, JSONObject fields, int timeout) {
        String boundary = "----MyLifeForm" + System.currentTimeMillis();
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(timeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type",
                    "multipart/form-data; boundary=" + boundary);
            if (apiKey != null && apiKey.length() > 0) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            conn.setChunkedStreamingMode(0);   // 音频较大，不要一次性压进内存再发

            OutputStream os = conn.getOutputStream();
            // 普通字段
            java.util.Iterator<String> it = fields.keys();
            while (it.hasNext()) {
                String k = it.next();
                os.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
                os.write(("Content-Disposition: form-data; name=\"" + k + "\"\r\n\r\n")
                        .getBytes("UTF-8"));
                os.write((fields.optString(k, "") + "\r\n").getBytes("UTF-8"));
            }
            // 文件字段
            os.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
            os.write(("Content-Disposition: form-data; name=\"" + field + "\"; filename=\""
                    + fileName + "\"\r\n").getBytes("UTF-8"));
            os.write(("Content-Type: " + mime + "\r\n\r\n").getBytes("UTF-8"));
            os.write(data);
            os.write("\r\n".getBytes("UTF-8"));
            os.write(("--" + boundary + "--\r\n").getBytes("UTF-8"));
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            JSONObject out = new JSONObject();
            out.put("status", code);
            String text = readAll(is);
            out.put("text", text);
            try { out.put("json", new JSONObject(text)); } catch (Exception ignored) {}
            return out;

        } catch (Exception e) {
            Log.w(TAG, "multipart 失败 " + url, e);
            JSONObject out = new JSONObject();
            try {
                out.put("status", -1);
                out.put("text", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {}
            return out;
        }
    }

    private static byte[] readFile(File f) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        InputStream is = new java.io.FileInputStream(f);
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
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
