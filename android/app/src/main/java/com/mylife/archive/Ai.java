package com.mylife.archive;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
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
        String m = Json.sv(row, "model");
        if (m.length() > 0) p.put("__model", m);
        return p;
    }

    private static JSONObject pick(Db db, JSONObject in) throws Exception {
        if (in != null && in.has("profileId") && !in.isNull("profileId")) {
            JSONObject p = byId(db, in.optInt("profileId"));
            if (p != null) {
                if (in.has("model") && Json.sv(in, "model").length() > 0) {
                    p.put("__model", Json.sv(in, "model"));
                }
                return p;
            }
        }
        if (in != null && in.has("slot")) {
            JSONObject p = forSlot(db, Json.sv(in, "slot"));
            if (p != null) return p;
        }
        return one(db, "SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id LIMIT 1", new JSONArray());
    }

    private static String modelOf(JSONObject p) {
        String m = Json.sv(p, "__model");
        if (m.length() > 0) return m;
        return Json.sv(p, "default_model");
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
        String b = Json.sv(p, "base_url");
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

            JSONObject r = call(base(p) + "/models", "GET", Json.sv(p, "api_key"), null, T_LIST);
            int status = r.optInt("status", -1);
            if (status != 200) {
                return msg(false, "拉不到模型（HTTP " + status + "）：" + shorten(Json.sv(r, "text"), 160));
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
                    // 模型清单里字段名各家用得不一样：id / name / model 依次兜底
                    String id = Json.sv(m, "id");
                    if (id.length() == 0) id = Json.sv(m, "name");
                    if (id.length() == 0) id = Json.sv(m, "model");
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
            if ("asr".equals(Json.sv(in, "slot"))) {
                JSONObject fields = new JSONObject();
                fields.put("model", model);
                JSONObject r2 = callMultipart(base(p) + "/audio/transcriptions",
                        Json.sv(p, "api_key"), tinyWav(1), "file", "probe.wav",
                        "audio/wav", fields, T_TEST);
                long ms2 = System.currentTimeMillis() - t0;
                int st2 = r2.optInt("status", -1);
                if (st2 != 200) {
                    String body2 = shorten(Json.sv(r2, "text"), 200);
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
                o.put("profile", Json.sv(p, "name"));
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
                    Json.sv(p, "api_key"), body.toString(), T_TEST);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, "HTTP " + status + "：" + shorten(Json.sv(r, "text"), 200));
                o.put("ms", ms);
                return o.toString();
            }

            JSONObject j = r.optJSONObject("json");
            String text = "";
            if (j != null) {
                JSONArray ch = j.optJSONArray("choices");
                if (ch != null && ch.length() > 0) {
                    JSONObject msg = ch.optJSONObject(0).optJSONObject("message");
                    if (msg != null) text = Json.sv(msg, "content");
                }
            }
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("ms", ms);
            o.put("model", model);
            o.put("profile", Json.sv(p, "name"));
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
                    Json.sv(p, "api_key"), body.toString(), T_CHAT);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, "模型返回 " + status + "：" + shorten(Json.sv(r, "text"), 200));
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
                    if (msg != null) text = Json.sv(msg, "content");
                }
                usage = j.optJSONObject("usage");
            }

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("ms", ms);
            o.put("model", model);
            o.put("profile", Json.sv(p, "name"));
            o.put("text", text);
            if (usage != null) o.put("usage", usage);
            // 用量记账：tokens 总数（没有就按字数估），供设置页用量统计用
            double units = 0;
            if (usage != null) {
                units = usage.optDouble("total_tokens",
                        usage.optDouble("prompt_tokens", 0) + usage.optDouble("completion_tokens", 0));
            }
            if (units <= 0) units = text.length();
            usageAdd(db, "text", model, units, "token");
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

            String model = Json.sv(in, "model");
            if (model.length() == 0) model = modelOf(p);
            if (model.length() == 0) return msg(false, "这条配置还没选模型");

            String rel = Json.sv(in, "path").replace("..", "").replace("\\", "/");
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
            if (Json.sv(in, "language").length() > 0) {
                fields.put("language", Json.sv(in, "language"));
            }

            JSONObject r = callMultipart(base(p) + "/audio/transcriptions",
                    Json.sv(p, "api_key"), readFile(f), "file", f.getName(), mime,
                    fields, T_ASR);
            long ms = System.currentTimeMillis() - t0;

            int status = r.optInt("status", -1);
            if (status != 200) {
                JSONObject o = msgObj(false, msgForStatus(status, Json.sv(r, "text")));
                o.put("ms", ms);
                // 把这次请求的原始信息一并带回去，界面上「看详情」直接能判断
                // 是网络、鉴权、模型名还是音频本身的问题，不用再猜
                o.put("diag", diag(base(p), model, Json.sv(p, "name"), rel, size, status,
                        Json.sv(r, "text")));
                return o.toString();
            }

            JSONObject j = r.optJSONObject("json");
            String text = j != null ? Json.sv(j, "text") : "";
            if (text.trim().length() == 0) {
                JSONObject o = msgObj(false, "转出来是空的。录音里可能没说话，或者这段音频格式不支持。");
                o.put("diag", diag(base(p), model, Json.sv(p, "name"), rel, size, status,
                        Json.sv(r, "text")));
                return o.toString();
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
            usageAdd(db, "asr", model, text.trim().length(), "char");
            return o.toString();

        } catch (Exception e) {
            Log.w(TAG, "asr 失败", e);
            JSONObject o = msgObj(false, "转不了：" + e.getMessage());
            try {
                JSONObject d = new JSONObject();
                d.put("status", -1);
                d.put("body", e.getClass().getSimpleName() + ": " + e.getMessage());
                o.put("diag", d);
            } catch (Exception ignored) {
            }
            return o.toString();
        }
    }

    /* ================= 文生图（/api/image，与 Node 端 apiImage 同一套约定） ================= */

    private static final int T_IMAGE = 180000;

    /**
     * 生成一张插图。供应商走 OpenAI 兼容的 /images/generations。
     * 硅基流动返回的是临时图床 URL（会过期），必须当场下载落盘，不能只存链接。
     *
     * payload: { prompt, size?, steps?, cfg?, model?, profileId?, refImage?(dataURL), again? }
     * 返回 { ok, path:'ai/img/<key>.jpg', bytes, model, ms, note? } —— 前端按 /files/<path> 展示。
     */
    public static String image(Context ctx, long uid, Db db, String payload) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject in = Json.obj(payload);
            String prompt = Json.sv(in, "prompt").trim();
            if (prompt.length() == 0) return msg(false, "没有画面描述");
            if (prompt.length() > 1200) return msg(false, "画面描述太长了（最多 1200 字）");

            // 优先用「图片生成」这个用途绑定的配置（slot=img，与桌面版一致）
            if (!in.has("slot")) in.put("slot", "img");
            JSONObject p = pick(db, in);
            if (p == null) return msg(false,
                    "还没配「图片生成」的模型。设置 → 模型来源里绑一条，模型填 Kwai-Kolors/Kolors（免费）。");

            String model = Json.sv(in, "model");
            if (model.length() == 0) model = modelOf(p);
            // 与 Node 端同规则：文本默认模型（如 Qwen3-8B）拿去调 /images/generations，
            // 硅基流动会判成非法操作（403），所以非图像模型一律回退到免费的 Kolors。
            if (model.length() == 0 || !isImageModel(model)) model = "Kwai-Kolors/Kolors";

            String size = Json.sv(in, "size");
            if (!size.matches("\\d{3,4}x\\d{3,4}")) size = "1024x1024";

            String refB64 = "";
            String raw = Json.sv(in, "refImage");
            if (raw.length() > 0) {
                int comma = raw.indexOf(',');
                refB64 = comma >= 0 ? raw.substring(comma + 1) : raw;
            }

            String key = sha1(prompt + "|" + model + "|" + size).substring(0, 20);
            File dir = new File(new File(new File(new File(ctx.getFilesDir(), "users"),
                    String.valueOf(uid)), "files"), "ai/img");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();

            String[] errors = new String[2];
            int errN = 0;

            // 带参考图失败（部分模型不认 image 字段）时自动退回纯文字再画一次
            int attemptsN = refB64.length() > 0 ? 2 : 1;
            for (int at = 0; at < attemptsN; at++) {
                boolean withRef = refB64.length() > 0 && at == 0;
                try {
                    JSONObject pl = new JSONObject();
                    pl.put("model", model);
                    pl.put("prompt", prompt);
                    pl.put("image_size", size);
                    pl.put("batch_size", 1);
                    pl.put("num_inference_steps", in.optInt("steps", 20));
                    pl.put("guidance_scale", in.optDouble("cfg", 7.5));
                    if (withRef) pl.put("image", refB64);

                    JSONObject r = call(base(p) + "/images/generations", "POST",
                            Json.sv(p, "api_key"), pl.toString(), T_IMAGE);
                    int status = r.optInt("status", -1);
                    if (status != 200) {
                        errors[errN++] = Json.sv(p, "name") + (withRef ? "（带参考图）" : "")
                                + " HTTP " + status + "：" + shorten(Json.sv(r, "text"), 160);
                        continue;
                    }
                    JSONObject j = r.optJSONObject("json");
                    JSONArray imgs = null;
                    if (j != null) {
                        imgs = j.optJSONArray("images");
                        if (imgs == null) imgs = j.optJSONArray("data");
                    }
                    if (imgs == null || imgs.length() == 0) {
                        errors[errN++] = Json.sv(p, "name") + " 没返回图片";
                        continue;
                    }
                    JSONObject item = imgs.optJSONObject(0);
                    byte[] buf = null;
                    if (item != null) {
                        String url = Json.sv(item, "url");
                        String b64 = Json.sv(item, "b64_json");
                        if (url.startsWith("data:")) {
                            buf = android.util.Base64.decode(
                                    url.substring(url.indexOf(',') + 1), android.util.Base64.DEFAULT);
                        } else if (b64.length() > 0) {
                            buf = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                        } else if (url.startsWith("http")) {
                            buf = download(url);
                        }
                    }
                    if (buf == null || buf.length == 0) {
                        errors[errN++] = Json.sv(p, "name") + " 图片是空的";
                        continue;
                    }

                    String rel = "ai/img/" + key + ".jpg";
                    java.io.FileOutputStream fo = new java.io.FileOutputStream(new File(dir, key + ".jpg"));
                    fo.write(buf);
                    fo.close();

                    usageAdd(db, "image", model, 1, "call");

                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("path", rel);
                    o.put("bytes", buf.length);
                    o.put("model", model);
                    o.put("ms", System.currentTimeMillis() - t0);
                    o.put("cached", false);
                    if (refB64.length() > 0 && !withRef) {
                        o.put("refIgnored", true);
                        o.put("note", "这个模型不认参考图，已按提示词重新画一张。想严格照着照片画，请在「设置 → 图片生成」里换一个支持图生图的模型。");
                    } else {
                        o.put("note", "图片由 AI 生成，服务商会在角落加标识");
                    }
                    return o.toString();

                } catch (Exception e) {
                    Log.w(TAG, "image 失败", e);
                    if (errN < 2) errors[errN++] = Json.sv(p, "name") + (withRef ? "（带参考图）" : "")
                            + " 连不上：" + e.getMessage();
                }
            }

            StringBuilder sb = new StringBuilder("没画出来：");
            for (int i = 0; i < errN; i++) {
                if (i > 0) sb.append("；");
                sb.append(errors[i]);
            }
            if (refB64.length() > 0) {
                sb.append("（带参考图的请求被服务商拒了，已自动改成纯文字重画；要给模型参考图，得换支持图生图的模型）");
            }
            sb.append("。请到「设置 → 模型来源」把「图片生成」这一环选成硅基流动免费档，模型填 Kwai-Kolors/Kolors，并填好 API Key。");
            return msg(false, sb.toString());

        } catch (Exception e) {
            Log.w(TAG, "image 失败", e);
            return msg(false, "画不了：" + e.getMessage());
        }
    }

    /** 是不是文生图模型：与 Node 端 isImageModel、web/db.js 的 modelKind 保持一致 */
    private static boolean isImageModel(String model) {
        String s = String.valueOf(model).toLowerCase();
        return s.matches(".*(kolors|flux|cogview|qwen-image|z-image|stable-diffusion|sdxl|dall|imagen|seedream|janus|playground|ideogram|aura|sd3|dream).*");
    }

    private static String sha1(String s) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
        byte[] d = md.digest(s.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** GET 下载图片字节（文生图接口返回的是临时图床 URL） */
    private static byte[] download(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("图床取图失败 HTTP " + code);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            InputStream is = conn.getInputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            is.close();
            return bo.toByteArray();
        } finally {
            conn.disconnect();
        }
    }

    /** 状态码 → 人话。网络层失败（-1）跟服务端 4xx/5xx 是两回事，别混成一句 */
    private static String msgForStatus(int status, String body) {        if (status == -1) {
            return "连不上服务器：" + shorten(body, 160)
                    + "\n→ 检查手机网络（或用的是需要代理的接口）";
        }
        if (status == 401 || status == 403) {
            return "HTTP " + status + "：API Key 不对或用不了\n→ " + shorten(body, 200);
        }
        if (status == 413) {
            return "HTTP 413：音频太大，服务端不收\n→ " + shorten(body, 160);
        }
        if (status == 429) {
            return "HTTP 429：调用太频繁或免费额度用完了\n→ " + shorten(body, 160);
        }
        return "HTTP " + status + "：" + shorten(body, 200);
    }

    /** 把这次转写请求的原貌打成一个 JSON，界面上一展开就知道卡在哪 */
    private static JSONObject diag(String base, String model, String profile,
            String path, long bytes, int status, String body) {
        JSONObject d = new JSONObject();
        try {
            d.put("base", base);
            d.put("model", model);
            d.put("profile", profile);
            d.put("path", path);
            d.put("bytes", bytes);
            d.put("status", status);
            d.put("body", shorten(body, 600));
        } catch (Exception ignored) {
        }
        return d;
    }

    /**
     * 手写的 multipart/form-data 上行。
     *
     * v0.3.5 改了两处，都是安卓端独有的坑：
     *   ① 原来用 setChunkedStreamingMode(0) 走 Transfer-Encoding: chunked。
     *      不少 OpenAI 兼容网关（nginx/云 WAF 前置）对 chunked 的 POST 直接拒，
     *      表现是连响应都拿不到、或者 411 Length Required。改成固定长度，
     *      和 fetch(FormData) 发出去的东西长得一模一样。
     *   ② 头部和文件分开写，避免把 25MB 音频再复制一份（手机内存吃不消）。
     */
    private static JSONObject callMultipart(String url, String apiKey, byte[] data,
            String field, String fileName, String mime, JSONObject fields, int timeout) {
        String boundary = "----MyLifeForm" + System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            // ---- 先把所有"头"拼出来，算出总长度，才能用固定长度模式 ----
            ByteArrayOutputStream head = new ByteArrayOutputStream(1024);
            java.util.Iterator<String> it = fields.keys();
            while (it.hasNext()) {
                String k = it.next();
                head.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
                head.write(("Content-Disposition: form-data; name=\"" + k + "\"\r\n\r\n")
                        .getBytes("UTF-8"));
                head.write((Json.sv(fields, k) + "\r\n").getBytes("UTF-8"));
            }
            head.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
            head.write(("Content-Disposition: form-data; name=\"" + field + "\"; filename=\""
                    + fileName + "\"\r\n").getBytes("UTF-8"));
            head.write(("Content-Type: " + mime + "\r\n\r\n").getBytes("UTF-8"));
            byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes("UTF-8");
            byte[] hb = head.toByteArray();

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(timeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type",
                    "multipart/form-data; boundary=" + boundary);
            conn.setRequestProperty("Accept", "application/json");
            if (apiKey != null && apiKey.length() > 0) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            conn.setFixedLengthStreamingMode((long) hb.length + data.length + tail.length);

            OutputStream os = conn.getOutputStream();
            os.write(hb);
            os.write(data);
            os.write(tail);
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
                out.put("text", e.getClass().getSimpleName()
                        + (e.getMessage() == null ? "" : "：" + e.getMessage()));
            } catch (Exception ignored) {}
            return out;
        } finally {
            if (conn != null) conn.disconnect();
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

    /* ================= 流式对话（NDJSON，与 Node 端同一个协议） ================= */

    /**
     * 每行一个 JSON：{"t":"d","v":"字"} 增量 / {"t":"retry"} 换下一个 /
     * {"t":"done","text":...} 收尾 / {"t":"err","message":...} 失败。
     *
     * 为什么把 OutputStream 传进来：边收边发才叫流式。攒完再 write 一遍，
     * 用户要盯着空白等十几秒——跟没有流式没区别。
     */
    public static void chatStream(Context ctx, Db db, String payload, OutputStream out) {
        try {
            JSONObject in = Json.obj(payload);
            JSONArray msgs = in.optJSONArray("messages");
            if (msgs == null || msgs.length() == 0) {
                writeLine(out, "{\"t\":\"err\",\"message\":\"没有要发送的内容\"}");
                return;
            }
            JSONArray profiles = new JSONArray(db.query(
                    "SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id", new JSONArray()));
            if (profiles.length() == 0) {
                writeLine(out, "{\"t\":\"err\",\"message\":\"还没配模型。打开「设置 → 模型来源」加一条。\"}");
                return;
            }
            int tried = 0;
            for (int i = 0; i < profiles.length() && tried < 3; i++) {
                JSONObject p = profiles.getJSONObject(i);
                String model = modelOf(p);
                if (model.length() == 0) continue;
                tried++;
                if (streamOne(p, model, in, msgs, out)) return;
            }
            writeLine(out, "{\"t\":\"err\",\"message\":\"所有模型都没通，检查网络或 Key\"}");
        } catch (Exception e) {
            writeLine(out, "{\"t\":\"err\",\"message\":\"" + Json.esc(String.valueOf(e.getMessage())) + "\"}");
        }
    }

    private static boolean streamOne(JSONObject p, String model, JSONObject in,
                                     JSONArray msgs, OutputStream out) {
        HttpURLConnection conn = null;
        try {
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", msgs);
            body.put("temperature", in.optDouble("temperature", 0.7));
            body.put("stream", true);

            conn = (HttpURLConnection) new URL(base(p) + "/chat/completions").openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(T_CHAT);
            conn.setRequestProperty("Content-Type", "application/json");
            String key = Json.sv(p, "api_key");
            if (key.length() > 0) conn.setRequestProperty("Authorization", "Bearer " + key);
            conn.setDoOutput(true);
            OutputStream os = conn.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            if (code != 200) {
                String err = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
                writeLine(out, "{\"t\":\"retry\",\"message\":\""
                        + Json.esc(Json.sv(p, "name") + " HTTP " + code) + "\"}");
                Log.w(TAG, "流式失败 " + code + " " + shorten(err, 120));
                return false;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder full = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                line = line.trim();
                if (line.length() == 0 || line.startsWith(":")) continue;
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if ("[DONE]".equals(data)) break;
                try {
                    JSONObject j = new JSONObject(data);
                    JSONArray ch = j.optJSONArray("choices");
                    if (ch == null || ch.length() == 0) continue;
                    JSONObject delta = ch.getJSONObject(0).optJSONObject("delta");
                    if (delta == null) continue;
                    String piece = Json.sv(delta, "content");
                    if (piece.length() == 0) piece = Json.sv(delta, "reasoning_content");
                    if (piece.length() > 0) {
                        full.append(piece);
                        writeLine(out, "{\"t\":\"d\",\"v\":\"" + Json.esc(piece) + "\"}");
                    }
                } catch (Exception parse) {
                    // 心跳、注释行、畸形 JSON：跳过，不打断整段
                }
            }
            br.close();
            writeLine(out, "{\"t\":\"done\",\"text\":\"" + Json.esc(full.toString())
                    + "\",\"model\":\"" + Json.esc(model) + "\"}");
            return true;
        } catch (Exception e) {
            writeLine(out, "{\"t\":\"retry\",\"message\":\"" + Json.esc(String.valueOf(e.getMessage())) + "\"}");
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void writeLine(OutputStream out, String line) {
        try {
            out.write((line + "\n").getBytes("UTF-8"));
            out.flush();
        } catch (Exception ignored) {
        }
    }

    /* ================= 公共小件 ================= */

    /** users/<uid>/files/<rel> 目录，自动建 */
    private static File filesDir(Context ctx, long uid, String rel) {
        File d = new File(new File(new File(new File(ctx.getFilesDir(), "users"),
                String.valueOf(uid)), "files"), rel);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    /** 用量记账：与 Node 端 usageAdd 同约定，失败不影响主流程 */
    private static void usageAdd(Db db, String cap, String model, double units, String unit) {
        try {
            JSONArray a = new JSONArray();
            a.put(cap == null ? "text" : cap);
            a.put(model == null || model.length() == 0 ? JSONObject.NULL : model);
            a.put(units);
            a.put(unit == null || unit.length() == 0 ? JSONObject.NULL : unit);
            a.put(0);
            a.put(JSONObject.NULL);
            db.exec("INSERT INTO ai_usage (capability, model, units, unit, cost, ref) VALUES (?,?,?,?,?,?)", a);
        } catch (Exception ignored) {
        }
    }

    /**
     * 二进制 HTTP POST（TTS 音频用）：call() 读的是文本，这里必须收原始字节。
     * 非 2xx 抛异常，message 里带状态码和响应摘要。
     */
    private static byte[] callBinary(String url, String apiKey, String body, int timeout) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(timeout);
            conn.setRequestProperty("Content-Type", "application/json");
            if (apiKey != null && apiKey.length() > 0) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            conn.setDoOutput(true);
            OutputStream os = conn.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while (is != null && (n = is.read(buf)) > 0) bo.write(buf, 0, n);
            if (is != null) is.close();
            byte[] out = bo.toByteArray();
            if (code >= 400) {
                throw new Exception("HTTP " + code + "：" + shorten(new String(out, "UTF-8"), 160));
            }
            return out;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* ================= 云端朗读（/api/tts，与 Node 端 apiTts 同约定） ================= */

    private static final int T_TTS = 120000;

    /**
     * 云端音色合成。供应商走 OpenAI 兼容 /audio/speech，返回 mp3 落盘。
     * 硅基流动的 CosyVoice2 音色必须写成「模型名:音色名」，只给 anna 会报 20047 Invalid voice（实测）。
     *
     * payload: { text, speed?, voice?, profileId?, model? }
     * 返回 { ok, path:'ai/tts/<key>.mp3', cached, model } —— 前端按 /files/<path> 播放；
     * 失败时 { ok:false, message }，前端 tts.js 会整段退回系统音色，不会卡住朗读。
     */
    public static String tts(Context ctx, long uid, Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            String text = Json.sv(in, "text").trim();
            if (text.length() == 0) return msg(false, "没有要读的文字");
            if (text.length() > 2000) return msg(false, "一次最多 2000 字，长文请分段读");

            if (!in.has("slot")) in.put("slot", "tts");
            JSONObject p = pick(db, in);
            if (p == null) {
                return msg(false, "还没配「朗读」用的模型，先用系统音色读。");
            }

            String model = modelOf(p);
            if (model.length() == 0) model = "tts-1";
            String voice = Json.sv(in, "voice");
            if (voice.length() == 0) {
                if (base(p).toLowerCase().contains("siliconflow")) {
                    voice = model.indexOf(':') >= 0 ? model : model + ":anna";
                } else {
                    voice = "alloy";
                }
            }
            float speed;
            try { speed = (float) in.optDouble("speed", 1.0); } catch (Exception e) { speed = 1f; }
            if (speed <= 0) speed = 1f;

            String key = sha1(text + "|" + voice + "|" + speed + "|" + model).substring(0, 20);
            String rel = "ai/tts/" + key + ".mp3";
            File f = new File(filesDir(ctx, uid, "ai/tts"), key + ".mp3");

            JSONObject o = new JSONObject();
            if (f.exists() && f.length() > 0) {
                o.put("ok", true);
                o.put("path", rel);
                o.put("cached", true);
                o.put("model", model);
                return o.toString();
            }

            JSONObject pl = new JSONObject();
            pl.put("model", model);
            pl.put("input", text);
            pl.put("voice", voice);
            pl.put("speed", (double) speed);
            pl.put("response_format", "mp3");

            byte[] buf = callBinary(base(p) + "/audio/speech",
                    Json.sv(p, "api_key"), pl.toString(), T_TTS);
            if (buf == null || buf.length == 0) {
                return msg(false, Json.sv(p, "name") + " 返回空音频，先用系统音色读。");
            }
            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
            fo.write(buf);
            fo.close();

            usageAdd(db, "tts", model, text.length(), "char");

            o.put("ok", true);
            o.put("path", rel);
            o.put("cached", false);
            o.put("model", model);
            return o.toString();
        } catch (Exception e) {
            Log.w(TAG, "tts 失败", e);
            // 失败文案给前端兜底提示用；tts.js 收到 ok:false 会自动退回系统音色
            return msg(false, "云端朗读没成：" + e.getMessage() + "。先用系统音色读。");
        }
    }

    /* ================= 演奏歌曲（/api/song/make，与 Node 端 apiSongMake 同约定） ================= */

    /**
     * 歌词 → 人声 + 伴奏 → 一首歌。安卓没有 ffmpeg，全程自己算：
     *   ① 人声：云端 TTS（与 /api/tts 同链路），mp3 用系统 MediaCodec 解成 PCM
     *   ② 伴奏：按曲风和弦进行逐小节合成（与桌面 synthBgm 同一套参数）
     *   ③ 混音：人声垫在伴奏上，输出 44.1kHz/16bit/立体声 WAV（WebView 的 <audio> 直接播）
     *
     * payload: { lyrics, style?, voice?, profileId?, model?, speed? }
     * 返回 { ok, path:'ai/song/<key>/song.wav', seconds, voice, voiceNote?, cached }
     */
    public static String song(Context ctx, long uid, Db db, String payload) {
        final int SR = 44100;
        try {
            JSONObject in = Json.obj(payload);
            String lyrics = Json.sv(in, "lyrics").trim();
            if (lyrics.length() == 0) return msg(false, "没有歌词");
            if (lyrics.length() > 2000) return msg(false, "歌词一次最多 2000 字");

            String style = Json.sv(in, "style");
            if (style.length() == 0) style = "calm";
            BgmProg prog = BgmProg.byName(style);
            if (prog == null) return msg(false, "没有这种曲风");
            boolean wantVoice = !"false".equals(Json.sv(in, "voice"));

            String key = sha1(lyrics + "|" + style + "|" + (wantVoice ? "v" : "i")).substring(0, 16);
            String relDir = "ai/song/" + key;
            File dir = filesDir(ctx, uid, relDir);
            File out = new File(dir, "song.wav");
            JSONObject o = new JSONObject();
            if (out.exists() && out.length() > 0) {
                o.put("ok", true);
                o.put("path", relDir + "/song.wav");
                o.put("cached", true);
                o.put("voice", wantVoice);
                o.put("seconds", wavSeconds(out, SR));
                return o.toString();
            }

            /* ① 人声：直接走云端 TTS 链路 */
            float[] voice = null;
            String voiceNote = "";
            if (wantVoice) {
                String r = tts(ctx, uid, db, new JSONObject()
                        .put("text", lyrics).put("slot", "tts")
                        .put("profileId", in.opt("profileId")).put("model", in.opt("model"))
                        .put("speed", in.optDouble("speed", 1.0)).toString());
                JSONObject rj = new JSONObject(r);
                if (rj.optBoolean("ok")) {
                    File vf = new File(filesDir(ctx, uid, "ai/tts"),
                            new File(Json.sv(rj, "path")).getName());
                    try {
                        voice = decodeMp3Mono(vf, SR);
                    } catch (Exception de) {
                        Log.w(TAG, "人声解码失败", de);
                        voiceNote = "人声解码失败，这版只有伴奏";
                    }
                } else {
                    voiceNote = Json.sv(rj, "message").length() > 0
                            ? Json.sv(rj, "message") : "没配朗读模型，这版只有伴奏";
                }
            }

            /* ② 时长：有人声跟人声同长；没有就按字数估（约 6 字/秒，唱总比念慢） */
            double voiceSec = voice != null ? voice.length / (double) SR : 0;
            double estSec = voiceSec > 0 ? voiceSec : Math.max(6, lyrics.replaceAll("\\s", "").length() / 6.0);
            double total = estSec + 2.0;
            int totalN = (int) Math.round(total * SR);

            /* ③ 混音写 WAV：逐小节合成伴奏，叠上人声，落盘 */
            boolean withVoice = voice != null && voice.length > 0;
            java.io.FileOutputStream fo = new java.io.FileOutputStream(out);
            fo.write(wavHeader(totalN * 4, SR, 2));
            int barSamples = (int) Math.round(prog.bar * SR);
            float bgmVol = withVoice ? 0.5f : 0.9f;
            float voiceVol = withVoice ? 1.35f : 0f;
            for (int b = 0; b * barSamples < totalN; b++) {
                int len = Math.min(barSamples, totalN - b * barSamples);
                float[] L = new float[len];
                float[] R = new float[len];
                int[] ch = prog.chords[b % prog.chords.length];
                // 低音铺底：根音与三音各低一个八度
                addNote(L, R, SR, midiHz(ch[0] - 12), 0, prog.bar, 0.16f, true);
                addNote(L, R, SR, midiHz(ch[1] - 12), 0, prog.bar, 0.10f, true);
                // 八分音符琶音：上行四音再下行，后半小节抬八度
                int[] seq = {0, 1, 2, 3, 2, 1, 0, 1};
                double step = prog.bar / 8.0;
                for (int k = 0; k < 8 && k * step < prog.bar; k++) {
                    int note = ch[seq[k]] + (k >= 4 ? 12 : 0);
                    double dur = Math.min(2.0, prog.bar - k * step);
                    addNote(L, R, SR, midiHz(note), k * step, dur, 0.085f, false);
                }
                byte[] pcm = new byte[len * 4];
                int vOff = b * barSamples;
                for (int i = 0; i < len; i++) {
                    double sec = (vOff + i) / (double) SR;
                    // 全曲淡入淡出（与桌面 afade 同意图：入 1.2s，尾 2.6s）
                    double fade = 1.0;
                    if (sec < 1.2) fade = sec / 1.2;
                    else if (sec > total - 2.6) fade = Math.max(0, (total - sec) / 2.6);
                    double vL = L[i] * bgmVol * fade;
                    double vR = R[i] * bgmVol * fade;
                    if (withVoice && vOff + i < voice.length) {
                        vL += voice[vOff + i] * voiceVol;
                        vR += voice[vOff + i] * voiceVol;
                    }
                    int li = Math.round(Math.max(-1f, Math.min(1f, (float) vL)) * 32767f);
                    int ri = Math.round(Math.max(-1f, Math.min(1f, (float) vR)) * 32767f);
                    pcm[i * 4] = (byte) li;
                    pcm[i * 4 + 1] = (byte) (li >> 8);
                    pcm[i * 4 + 2] = (byte) ri;
                    pcm[i * 4 + 3] = (byte) (ri >> 8);
                }
                fo.write(pcm);
            }
            fo.close();

            if (withVoice) usageAdd(db, "tts", "", lyrics.length(), "char");

            o.put("ok", true);
            o.put("path", relDir + "/song.wav");
            o.put("seconds", Math.round(total * 10) / 10.0);
            o.put("voice", withVoice);
            if (voiceNote.length() > 0) o.put("voiceNote", voiceNote);
            return o.toString();
        } catch (Exception e) {
            Log.w(TAG, "song 失败", e);
            return msg(false, "演奏失败：" + e.getMessage());
        }
    }

    /* ---- 伴奏合成：与桌面 synthBgm/addNote 同参数 ---- */

    private static double midiHz(int m) {
        return 440.0 * Math.pow(2.0, (m - 69) / 12.0);
    }

    private static class BgmProg {
        double bar;
        int[][] chords;

        BgmProg(double bar, int[][] chords) {
            this.bar = bar;
            this.chords = chords;
        }

        static BgmProg byName(String s) {
            if ("warm".equals(s)) return new BgmProg(4.4, new int[][]{{53, 57, 60, 65}, {50, 53, 57, 62}, {46, 50, 53, 58}, {48, 52, 55, 60}});
            if ("bright".equals(s)) return new BgmProg(3.6, new int[][]{{57, 61, 64, 69}, {54, 57, 61, 66}, {50, 54, 57, 62}, {52, 56, 59, 64}});
            if ("old".equals(s)) return new BgmProg(5.0, new int[][]{{50, 53, 57, 62}, {46, 50, 53, 58}, {43, 46, 50, 55}, {45, 49, 52, 57}});
            if ("calm".equals(s)) return new BgmProg(4.0, new int[][]{{60, 64, 67, 72}, {57, 60, 64, 69}, {53, 57, 60, 65}, {55, 59, 62, 67}});
            return null;
        }
    }

    /** 一个音符写进左右声道。pad=低音铺底（慢起慢落），pluck=琶音（快起快落） */
    private static void addNote(float[] L, float[] R, int sr, double hz,
                                double startSec, double durSec, double amp, boolean pad) {
        int n0 = (int) Math.round(startSec * sr);
        int n = (int) Math.min(Math.round(durSec * sr), (long) L.length - n0);
        if (n <= 0) return;
        double atk = pad ? 0.45 : 0.008;
        double dec = pad ? 0.22 : 2.2;
        double[][] harm = pad
                ? new double[][]{{1, 1}, {2, 0.22}, {3, 0.08}}
                : new double[][]{{1, 1}, {2, 0.46}, {3, 0.22}, {4, 0.11}};
        double detune = 1.0009;   // 右声道差一点点，听上去更宽
        double fadeFrom = durSec - 0.3;
        for (int i = 0; i < n; i++) {
            double t = i / (double) sr;
            double env = Math.min(1, t / atk) * Math.exp(-t * dec);
            if (t > fadeFrom) env *= Math.max(0, (durSec - t) / 0.3);
            if (env < 2e-4) continue;
            double sL = 0, sR = 0;
            for (int h = 0; h < harm.length; h++) {
                double k = harm[h][0], a = harm[h][1];
                double ph = 6.283185307 * hz * k * t;
                sL += a * Math.sin(ph);
                sR += a * Math.sin(ph * detune + 0.35);
            }
            double g = env * amp;
            L[n0 + i] += (float) (sL * g);
            R[n0 + i] += (float) (sR * g);
        }
    }

    /* ---- 音频解码：mp3 → 44.1kHz 单声道 float[]（系统 MediaCodec，不引第三方） ---- */

    private static float[] decodeMp3Mono(File f, int targetSr) throws Exception {
        android.media.MediaExtractor ex = new android.media.MediaExtractor();
        try {
            ex.setDataSource(f.getAbsolutePath());
            int ti = -1;
            android.media.MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                android.media.MediaFormat x = ex.getTrackFormat(i);
                String mime = x.getString(android.media.MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) { ti = i; fmt = x; break; }
            }
            if (ti < 0 || fmt == null) throw new Exception("音频里没有音轨");
            int srcSr = fmt.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE);
            int srcCh = fmt.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT);
            ex.selectTrack(ti);
            android.media.MediaCodec dec = android.media.MediaCodec.createDecoderByType(
                    fmt.getString(android.media.MediaFormat.KEY_MIME));
            dec.configure(fmt, null, null, 0);
            dec.start();

            ByteArrayOutputStream pcmBytes = new ByteArrayOutputStream();
            android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
            boolean eosIn = false, eosOut = false;
            while (!eosOut) {
                if (!eosIn) {
                    int ib = dec.dequeueInputBuffer(10000);
                    if (ib >= 0) {
                        java.nio.ByteBuffer bb = dec.getInputBuffer(ib);
                        int sz = ex.readSampleData(bb, 0);
                        if (sz < 0) {
                            dec.queueInputBuffer(ib, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            eosIn = true;
                        } else {
                            dec.queueInputBuffer(ib, 0, sz, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int ob = dec.dequeueOutputBuffer(info, 10000);
                if (ob >= 0) {
                    java.nio.ByteBuffer bb = dec.getOutputBuffer(ob);
                    if (bb != null && info.size > 0) {
                        byte[] chunk = new byte[info.size];
                        bb.position(info.offset);
                        bb.get(chunk);
                        pcmBytes.write(chunk);
                    }
                    dec.releaseOutputBuffer(ob, false);
                    if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) eosOut = true;
                }
            }
            dec.stop();
            dec.release();

            /* 解出来的 PCM 是 16bit 交织多声道 → 折成单声道 float */
            byte[] raw = pcmBytes.toByteArray();
            int frames = raw.length / (2 * srcCh);
            float[] mono = new float[frames];
            for (int i = 0; i < frames; i++) {
                int acc = 0;
                for (int c = 0; c < srcCh; c++) {
                    int off = i * 2 * srcCh + c * 2;
                    short s = (short) ((raw[off] & 0xff) | (raw[off + 1] << 8));
                    acc += s;
                }
                mono[i] = acc / (float) srcCh / 32767f;
            }
            if (srcSr == targetSr) return mono;
            /* 线性重采样到目标采样率 */
            int outN = (int) ((long) frames * targetSr / srcSr);
            float[] out = new float[outN];
            double ratio = (frames - 1) / (double) Math.max(1, outN - 1);
            for (int i = 0; i < outN; i++) {
                double p = i * ratio;
                int i0 = (int) p;
                double fr = p - i0;
                float a = mono[i0];
                float b2 = i0 + 1 < frames ? mono[i0 + 1] : a;
                out[i] = (float) (a + (b2 - a) * fr);
            }
            return out;
        } finally {
            try { ex.release(); } catch (Exception ignored) {}
        }
    }

    private static byte[] wavHeader(int dataBytes, int sr, int ch) {
        byte[] h = new byte[44];
        put(h, 0, "RIFF");
        putInt(h, 4, 36 + dataBytes);
        put(h, 8, "WAVE");
        put(h, 12, "fmt ");
        putInt(h, 16, 16);
        h[20] = 1;
        h[22] = (byte) ch;
        putInt(h, 24, sr);
        putInt(h, 28, sr * ch * 2);
        h[32] = (byte) (ch * 2);
        h[34] = 16;
        put(h, 36, "data");
        putInt(h, 40, dataBytes);
        return h;
    }

    private static void put(byte[] b, int off, String s) {
        for (int i = 0; i < s.length(); i++) b[off + i] = (byte) s.charAt(i);
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) v;
        b[off + 1] = (byte) (v >> 8);
        b[off + 2] = (byte) (v >> 16);
        b[off + 3] = (byte) (v >> 24);
    }

    private static double wavSeconds(File f, int sr) {
        long bytes = f.length() - 44;
        return Math.round(bytes / 4.0 / sr * 10) / 10.0;
    }

    /* ================= 用量统计（/api/ai/usage，与 Node 端 usageSummary 同约定） ================= */

    public static String usage(Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            int days = in.optInt("days", 30);
            if (days < 1) days = 1;
            JSONArray rows = new JSONArray(db.query(
                    "SELECT capability, COUNT(*) AS calls, COALESCE(SUM(units),0) AS units, " +
                            "COALESCE(SUM(cost),0) AS cost FROM ai_usage " +
                            "WHERE at >= datetime('now', ?) GROUP BY capability ORDER BY capability",
                    new JSONArray().put("-" + days + " days")));
            long calls = 0;
            double cost = 0;
            for (int i = 0; i < rows.length(); i++) {
                JSONObject r = rows.getJSONObject(i);
                calls += r.optLong("calls", 0);
                cost += r.optDouble("cost", 0);
            }
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("days", days);
            o.put("byCapability", rows);
            o.put("calls", calls);
            o.put("cost", Math.round(cost * 100) / 100.0);
            return o.toString();
        } catch (Exception e) {
            return msg(false, "读用量失败：" + e.getMessage());
        }
    }

    /* ================= 短片分镜（/api/movie/plan，与 Node 端 apiMoviePlan 同约定） ================= */

    /**
     * 纯规则分镜：封面卡 + 每段讲述按字幕行拆格，照片按拍摄年就近垫图。
     * 安卓没有渲染引擎，probe 会告诉前端「只能排分镜，合成去电脑」——但分镜、
     * 字幕稿、时长预估照样完整可用，用户可以先在这台手机上把片子「编辑」好。
     */
    public static String moviePlan(Db db, String payload) throws Exception {
        JSONObject in = Json.obj(payload);
        int aid = in.optInt("archiveId", 0);
        int chId = in.optInt("chapterId", 0);
        if (aid == 0) throw new Exception("要指定档案");

        JSONObject a = one(db, "SELECT * FROM archives WHERE id=?", new JSONArray().put(aid));
        if (a == null) throw new Exception("找不到这本档案");
        JSONObject ch = chId > 0
                ? one(db, "SELECT * FROM chapters WHERE id=?", new JSONArray().put(chId)) : null;

        JSONArray rawEntries;
        if (chId > 0) {
            rawEntries = new JSONArray(db.query(
                    "SELECT * FROM entries WHERE chapter_id=? ORDER BY COALESCE(sort_key,seq,0), id",
                    new JSONArray().put(chId)));
        } else {
            rawEntries = new JSONArray(db.query(
                    "SELECT e.*, c.title AS chapter_title FROM entries e " +
                            "LEFT JOIN chapters c ON c.id=e.chapter_id " +
                            "WHERE e.archive_id=? AND e.kind IN ('text','quote') " +
                            "ORDER BY COALESCE(c.seq, 999999), COALESCE(e.sort_key, e.seq, 0), e.id",
                    new JSONArray().put(String.valueOf(aid))));
        }

        JSONArray photos;
        if (chId > 0) {
            photos = new JSONArray(db.query(
                    "SELECT * FROM photos WHERE chapter_id=? ORDER BY taken_year, taken_month, id",
                    new JSONArray().put(chId)));
        } else {
            photos = new JSONArray(db.query(
                    "SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year, taken_month, id",
                    new JSONArray().put(String.valueOf(aid))));
        }
        java.util.HashMap<String, JSONObject> byId = new java.util.HashMap<String, JSONObject>();
        for (int i = 0; i < photos.length(); i++) {
            JSONObject ph = photos.getJSONObject(i);
            byId.put(String.valueOf(ph.opt("id")), ph);
        }
        java.util.HashMap<String, Boolean> used = new java.util.HashMap<String, Boolean>();
        int cursor = 0;

        JSONObject cover = one(db, "SELECT p.path FROM photos p WHERE p.id=?",
                new JSONArray().put(String.valueOf(a.opt("cover_photo_id") == null ? -1 : a.opt("cover_photo_id"))));

        JSONArray frames = new JSONArray();
        if (cover != null && Json.sv(cover, "path").length() > 0) {
            JSONObject t = new JSONObject();
            t.put("image", Json.sv(cover, "path"));
            t.put("text", Json.sv(a, "subject_name")
                    + (Json.sv(a, "birth_year").length() > 0 ? " · " + Json.sv(a, "birth_year") : ""));
            t.put("sec", 2.6);
            t.put("kind", "title");
            frames.put(t);
        }

        // 整本排下来可能很长：格数 160 / 总时长 900s 封顶，超了截断并在返回里说明
        final int MAX_FRAMES = 160;
        final double MAX_SECONDS = 900;
        double totalSec = 0;
        int truncated = 0;
        int entryCount = 0;

        for (int ei = 0; ei < rawEntries.length(); ei++) {
            JSONObject en = rawEntries.getJSONObject(ei);
            String text = Json.sv(en, "text").trim();
            if (text.length() == 0) continue;
            entryCount++;
            if (frames.length() >= MAX_FRAMES || totalSec >= MAX_SECONDS) { truncated++; continue; }

            JSONObject ph = null;
            String pid = String.valueOf(en.opt("photo_id") == null ? "" : en.opt("photo_id"));
            if (!pid.isEmpty() && !"null".equals(pid)) ph = byId.get(pid);
            if (ph != null) {
                used.put(String.valueOf(ph.opt("id")), Boolean.TRUE);
            } else {
                while (cursor < photos.length() &&
                        used.containsKey(String.valueOf(photos.getJSONObject(cursor).opt("id")))) cursor++;
                if (cursor < photos.length()) ph = photos.getJSONObject(cursor++);
                if (ph != null) used.put(String.valueOf(ph.opt("id")), Boolean.TRUE);
            }

            // 文字卡顶部小标：章节名 + 年份；正文里已提这一年就不重复
            String chName = Json.sv(ch, "title");
            if (chName.length() == 0) chName = Json.sv(en, "chapter_title");
            chName = chName.replaceFirst("^[^·]*·\\s*", "").trim();

            java.util.List<String> parts = splitSubtitle(text, 50);
            for (int pi = 0; pi < parts.size(); pi++) {
                if (frames.length() >= MAX_FRAMES || totalSec >= MAX_SECONDS) { truncated++; break; }
                String piece = parts.get(pi);
                double sec = Math.min(12, Math.max(2.8, 2.4 + piece.length() / 9.0));
                String yearStr = Json.sv(en, "at_year");
                boolean yearInLine = yearStr.length() > 0 && piece.contains(yearStr);
                String kicker = (chName.length() > 0 ? chName : "")
                        + (yearStr.length() > 0 && !yearInLine
                        ? (chName.length() > 0 ? " · " : "") + yearStr + " 年" : "");
                if (kicker.length() == 0) kicker = Json.sv(a, "subject_name");
                JSONObject f = new JSONObject();
                if (ph != null) f.put("image", Json.sv(ph, "path"));
                f.put("text", piece);
                f.put("sec", Math.round(sec * 10) / 10.0);
                if (yearStr.length() > 0) f.put("year", yearStr);
                f.put("entryId", en.opt("id"));
                f.put("part", pi > 0 ? pi + 1 : 0);
                f.put("kicker", kicker);
                frames.put(f);
                totalSec += Math.round(sec * 10) / 10.0;
            }
        }

        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("title", ch != null ? Json.sv(ch, "title") : Json.sv(a, "subject_name"));
        o.put("name", Json.sv(a, "subject_name"));
        o.put("archiveNo", Json.sv(a, "archive_no"));
        o.put("frames", frames);
        o.put("seconds", Math.round(totalSec * 10) / 10.0);
        int missing = 0;
        for (int i = 0; i < frames.length(); i++) {
            if (!frames.getJSONObject(i).has("image")) missing++;
        }
        o.put("missing", missing);
        o.put("truncated", truncated);
        o.put("entries", entryCount);
        o.put("hasFfmpeg", false);
        return o.toString();
    }

    /** 一段讲述切成字幕格：一行 13 字、最多四行 → 一格不超 50 字，内容一句不丢 */
    private static java.util.List<String> splitSubtitle(String text, int limit) {
        int max = limit > 0 ? limit : 50;
        String s = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        java.util.List<String> out = new java.util.ArrayList<String>();
        if (s.length() <= max) {
            out.add(s);
            return out;
        }
        StringBuilder buf = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            buf.append(c);
            boolean isEnd = "。！？；".indexOf(c) >= 0;
            if ((isEnd && buf.length() >= max * 0.5) || buf.length() >= max) {
                out.add(buf.toString().trim());
                buf.setLength(0);
            }
        }
        if (buf.toString().trim().length() > 0) out.add(buf.toString().trim());
        return out;
    }
}
