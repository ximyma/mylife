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
}
