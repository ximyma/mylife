package com.mylife.archive;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地 HTTP 服务（纯 Java，零依赖）。
 *
 * 为什么安卓里也要起一个 HTTP 服务：
 *   这样前端只认 fetch，网页端和安卓端是同一份代码、同一个地址形态。
 *   图片/视频走 /files/*，不需要转 base64，也不需要 JsBridge。
 *
 * 只提供 4 个接口：
 *   POST /api/query   {sql, params}  -> rows[]
 *   POST /api/exec    {sql, params}  -> {changes, lastId}
 *   POST /api/ai      {messages...}  -> {text}
 *   POST /api/asr     {path}         -> {text}   语音转文字
 *   POST /api/ai/chat {messages}     -> NDJSON 流（逐行 {"t":"d","v":"字"}）
 *   POST /api/jobs    {id?}          -> 任务查询 / 创建 / 取消
 *   POST /api/file    {op, ...}      -> 落盘 / 读取 / 删除
 *   GET  /files/<rel>                 -> 二进制，支持 Range
 */
public class LocalServer {

    private static final String TAG = "LocalServer";
    private static final int MAX_BODY = 64 * 1024 * 1024;   // 单请求 64MB 上限

    private final Context ctx;
    private final Auth auth;
    private final Map<Long, Db> userDbs = new HashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    private ServerSocket socket;
    private volatile boolean running = false;
    private int port = 0;

    public LocalServer(Context ctx, Auth auth) {
        this.ctx = ctx;
        this.auth = auth;
    }

    /** 绑 0 端口让系统分配，避免 8080 被别的 App 占 */
    public int start() throws Exception {
        socket = new ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"));
        port = socket.getLocalPort();
        running = true;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                loop();
            }
        }, "local-http");
        t.setDaemon(true);
        t.start();
        Log.i(TAG, "监听 http://127.0.0.1:" + port + "/");
        return port;
    }

    public int port() {
        return port;
    }

    public void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        pool.shutdownNow();
    }

    private void loop() {
        while (running) {
            try {
                final Socket client = socket.accept();
                pool.submit(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            handle(client);
                        } catch (Exception e) {
                            Log.w(TAG, "请求处理失败：" + e.getMessage());
                        } finally {
                            try { client.close(); } catch (Exception ignored) {}
                        }
                    }
                });
            } catch (Exception e) {
                if (running) Log.w(TAG, "accept 失败：" + e.getMessage());
            }
        }
    }

    /* ---------------- 请求解析 ---------------- */

    private void handle(Socket client) throws Exception {
        try {
            client.setSoTimeout(60000);      // 半开的连接别把线程挂死
            client.setTcpNoDelay(true);
        } catch (Exception ignored) {
        }
        InputStream in = client.getInputStream();
        OutputStream out = client.getOutputStream();

        byte[] all = readRequest(in, MAX_BODY);
        if (all == null || all.length == 0) return;

        int split = indexOfHeaderEnd(all);
        String head = new String(all, 0, split < 0 ? all.length : split, "UTF-8");
        byte[] body = split < 0 ? new byte[0] : slice(all, split + 4);

        String[] lines = head.split("\r\n");
        if (lines.length == 0) return;
        String[] first = lines[0].split(" ");
        if (first.length < 2) return;

        String method = first[0];
        String target = first[1];
        String path = target;
        String query = "";
        int qm = target.indexOf('?');
        if (qm >= 0) {
            path = target.substring(0, qm);
            query = target.substring(qm + 1);
        }

        // Range 头（视频拖动）+ Authorization + Cookie
        String range = null;
        String authHeader = null;
        String cookieHeader = null;
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i];
            int c = l.indexOf(':');
            if (c < 0) continue;
            String k = l.substring(0, c).trim().toLowerCase();
            if (k.equals("range")) range = l.substring(c + 1).trim();
            if (k.equals("authorization")) authHeader = l.substring(c + 1).trim();
            if (k.equals("cookie")) cookieHeader = l.substring(c + 1).trim();
        }

        if ("OPTIONS".equals(method)) {
            writeEmpty(out, 204);
            return;
        }

        if (path.startsWith("/api/auth/")) {
            String json = routeAuth(path, body, authHeader);
            // 登录/注册成功顺手种 cookie：<img src> 和 <audio src> 发不了
            // Authorization 头，没有 cookie 就一律 401——这正是安卓端
            // 照片不显示、录音点不动的原因（Node 端一直有 Set-Cookie）。
            String tk = Json.sv(Json.obj(json), "token");
            String extra = tk.length() > 0
                    ? "Set-Cookie: " + COOKIE_NAME + "=" + tk
                      + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000\r\n"
                    : "";
            writeJson(out, json, extra);
            return;
        }

        if (path.startsWith("/api/")) {
            Auth.User user = auth.verify(tokenFrom(authHeader, cookieHeader, query));
            if (user == null) {
                writeJson(out, "{\"__auth\":\"需要登录\"}");
                return;
            }
            Db udb = dbForUser(user.uid);

            // 流式对话：边收边发，必须自己写头，不能走"返回一个 JSON 字符串"那条路
            if (path.equals("/api/ai/chat")) {
                String ndHead = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: application/x-ndjson; charset=utf-8\r\n"
                        + "Cache-Control: no-store\r\n"
                        + "Connection: close\r\n"
                        + "Access-Control-Allow-Origin: *\r\n\r\n";
                out.write(ndHead.getBytes("UTF-8"));
                out.flush();
                Ai.chatStream(ctx, udb, new String(body, "UTF-8"), out);
                out.flush();
                return;
            }

            String json = routeApi(path, body, udb, user.uid);
            writeJson(out, json);
            return;
        }

        if (path.startsWith("/files/")) {
            Auth.User user = auth.verify(tokenFrom(authHeader, cookieHeader, query));
            if (user == null) {
                writeText(out, 401, "需要登录");
                return;
            }
            serveFiles(out, path.substring(7), range, user.uid);
            return;
        }

        serveAsset(out, path);
    }

    private static final String COOKIE_NAME = "mylife_token";

    /** token 三个来源：Authorization 头 → cookie → ?token=（给 <img>/<audio> 兜底） */
    private static String tokenFrom(String authHeader, String cookieHeader, String query) {
        String t = tokenOf(authHeader);
        if (t != null && t.length() > 0) return t;
        if (cookieHeader != null) {
            String[] parts = cookieHeader.split(";");
            for (int i = 0; i < parts.length; i++) {
                String p = parts[i].trim();
                int eq = p.indexOf('=');
                if (eq <= 0) continue;
                if (COOKIE_NAME.equals(p.substring(0, eq))) {
                    String v = p.substring(eq + 1).trim();
                    if (v.length() > 0) return v;
                }
            }
        }
        if (query != null) {
            String[] qs = query.split("&");
            for (int i = 0; i < qs.length; i++) {
                int eq = qs[i].indexOf('=');
                if (eq <= 0) continue;
                if ("token".equals(qs[i].substring(0, eq))) {
                    try {
                        String v = URLDecoder.decode(qs[i].substring(eq + 1), "UTF-8");
                        if (v.length() > 0) return v;
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        return null;
    }

    private static String tokenOf(String authHeader) {
        if (authHeader == null) return null;
        return authHeader.replaceFirst("(?i)^Bearer\\s+", "").trim();
    }

    /** 用户库按需打开 + 缓存（本地单进程，20 个上限够用） */
    private Db dbForUser(long uid) throws Exception {
        synchronized (userDbs) {
            Db d = userDbs.get(uid);
            if (d != null) return d;
            File dir = new File(new File(ctx.getFilesDir(), "users"), String.valueOf(uid));
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            d = new Db(ctx, new File(dir, "archive.db"));
            d.open();
            // 关键：迁移来的可能是 v0.1 的旧库，缺 v0.2/v0.3 的新表。
            // schema 全是 IF NOT EXISTS，幂等——每次打开都补一遍（Node 端同样做法）。
            d.ensureSchema();
            Jobs.resetStale(d);          // 上次进程被杀时卡在 running 的任务，放回队列
            userDbs.put(uid, d);
            return d;
        }
    }

    /** 注册 / 登录 / 验证码（免 token）；me / logout 带 token */
    private String routeAuth(String path, byte[] body, String authHeader) {
        try {
            String json = new String(body, "UTF-8");
            if (path.equals("/api/auth/register")) return auth.register(
                    Json.str(json, "phone"), Json.str(json, "password"),
                    Json.str(json, "code"), Json.str(json, "nickname"));
            if (path.equals("/api/auth/login")) return auth.login(
                    Json.str(json, "phone"), Json.str(json, "password"));
            if (path.equals("/api/auth/sms")) return auth.sms(Json.str(json, "phone"));
            if (path.equals("/api/auth/logout")) {
                auth.logout(tokenOf(authHeader));
                return "{\"ok\":true}";
            }
            if (path.equals("/api/auth/me")) {
                Auth.User u = auth.verify(tokenOf(authHeader));
                if (u == null) return "{\"__auth\":\"需要登录\"}";
                return "{\"ok\":true,\"uid\":" + u.uid + ",\"phone\":\"" + Json.esc(u.phone) + "\"}";
            }
            return "{\"__error\":\"未知接口 " + path + "\"}";
        } catch (Exception e) {
            return "{\"ok\":false,\"message\":\"" + Json.esc(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    /**
     * 读一个完整请求（头 + 体）。
     *
     * v0.3.5 重写。原来的实现靠 `in.available() == 0` 判断"读完了"，这是错的：
     * available() 只表示"此刻内核缓冲区里有几个字节"，请求体分成多个 TCP 段到达时
     * 中途会返回 0，于是 body 被截断。小 JSON 平时刚好一整包到达所以看不出问题，
     * 一旦传照片（base64 好几 MB）就会随机解析失败。
     *
     * 正确做法：先把请求头读到 \r\n\r\n 结束，取出 Content-Length，再精确读那么多字节。
     */
    private static byte[] readRequest(InputStream raw, int max) throws Exception {
        InputStream in = new java.io.BufferedInputStream(raw, 16384);

        ByteArrayOutputStream head = new ByteArrayOutputStream(1024);
        int s = 0;                                  // 匹配 \r\n\r\n 的状态机
        while (head.size() < 65536) {
            int c = in.read();
            if (c < 0) break;
            head.write(c);
            if (c == '\r') {
                s = (s == 2) ? 3 : 1;
            } else if (c == '\n') {
                if (s == 1) s = 2;
                else if (s == 3) { s = 4; break; }
                else s = 0;
            } else {
                s = 0;
            }
        }
        byte[] hb = head.toByteArray();
        if (hb.length == 0) return null;

        long need = contentLength(hb, hb.length);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];

        if (need > 0) {
            long left = Math.min(need, max);
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) break;
                body.write(buf, 0, n);
                left -= n;
            }
        } else if (need < 0) {
            // 没有 Content-Length（chunked 之类）：把此刻能读到的都读走
            int guard = 0;
            while (guard < max && in.available() > 0) {
                int n = in.read(buf, 0, Math.min(buf.length, max - guard));
                if (n <= 0) break;
                body.write(buf, 0, n);
                guard += n;
            }
        }

        byte[] bb = body.toByteArray();
        byte[] all = new byte[hb.length + bb.length];
        System.arraycopy(hb, 0, all, 0, hb.length);
        System.arraycopy(bb, 0, all, hb.length, bb.length);
        return all;
    }

    /** 兼容旧调用：整包读完（不再被用到，但留着防止别处引用） */
    private static byte[] readAll(InputStream in, int max) throws Exception {
        return readRequest(in, max);
    }

    private static int indexOfHeaderEnd(byte[] b) {
        for (int i = 0; i + 3 < b.length; i++) {
            if (b[i] == '\r' && b[i + 1] == '\n' && b[i + 2] == '\r' && b[i + 3] == '\n') return i;
        }
        return -1;
    }

    private static long contentLength(byte[] b, int headEnd) {
        String head = new String(b, 0, headEnd, java.nio.charset.Charset.forName("UTF-8"));
        String[] lines = head.split("\r\n");
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i];
            int c = l.indexOf(':');
            if (c < 0) continue;
            if (l.substring(0, c).trim().equalsIgnoreCase("content-length")) {
                try { return Long.parseLong(l.substring(c + 1).trim()); } catch (Exception e) { return -1; }
            }
        }
        return -1;
    }

    private static byte[] slice(byte[] b, int from) {
        if (from >= b.length) return new byte[0];
        byte[] r = new byte[b.length - from];
        System.arraycopy(b, from, r, 0, r.length);
        return r;
    }

    /* ---------------- API ---------------- */

    private String routeApi(String path, byte[] body, Db udb, long uid) {
        try {
            String json = new String(body, "UTF-8");
            if (path.equals("/api/query")) {
                return udb.query(Json.str(json, "sql"), Json.arr(json, "params"));
            }
            if (path.equals("/api/exec")) {
                return udb.exec(Json.str(json, "sql"), Json.arr(json, "params"));
            }
            if (path.equals("/api/ai")) {
                return Ai.chat(ctx, udb, json);
            }
            if (path.equals("/api/ai/models")) {
                return Ai.models(ctx, udb, json);
            }
            if (path.equals("/api/ai/test")) {
                return Ai.test(ctx, udb, json);
            }
            if (path.equals("/api/asr")) {
                return Ai.asr(ctx, uid, udb, json);
            }
            if (path.equals("/api/file")) {
                return Files.op(ctx, uid, json);
            }
            if (path.equals("/api/jobs")) {
                return Jobs.get(udb, json);
            }
            if (path.equals("/api/jobs/create")) {
                return Jobs.create(udb, json);
            }
            if (path.equals("/api/jobs/cancel")) {
                return Jobs.cancel(udb, json);
            }
            if (path.equals("/api/debug/data")) {
                return debugData(udb, uid);
            }
            return "{\"__error\":\"未知接口 " + path + "\"}";
        } catch (Exception e) {
            return "{\"__error\":\"" + Json.esc(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    /** 数据自检：uid、库路径、表清单、行数——设置页展示，用户截图即可确诊 */
    private String debugData(Db udb, long uid) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("{\"uid\":").append(uid);
            File f = new File(new File(new File(ctx.getFilesDir(), "users"), String.valueOf(uid)), "archive.db");
            sb.append(",\"dbPath\":\"").append(Json.esc(f.getAbsolutePath()));
            sb.append("\",\"dbBytes\":").append(f.length());
            sb.append(",\"tables\":[");
            android.database.Cursor c = udb.raw().rawQuery(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", null);
            boolean first = true;
            while (c.moveToNext()) {
                if (!first) sb.append(",");
                first = false;
                sb.append("\"").append(Json.esc(c.getString(0))).append("\"");
            }
            c.close();
            sb.append("]");
            String[] counts = {"archives", "chapters", "entries", "photos", "segments", "ai_profiles"};
            for (int i = 0; i < counts.length; i++) {
                c = udb.raw().rawQuery("SELECT count(*) FROM " + counts[i], null);
                c.moveToFirst();
                sb.append(",\"").append(counts[i]).append("_n\":").append(c.getLong(0));
                c.close();
            }
            sb.append("}");
            return sb.toString();
        } catch (Exception e) {
            return "{\"__error\":\"" + Json.esc(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    /* ---------------- 静态资源（assets/web） ---------------- */

    private void serveAsset(OutputStream out, String path) throws Exception {
        String rel = path.equals("/") ? "web/index.html" : "web" + path;
        if (rel.contains("..")) {
            writeText(out, 404, "not found");
            return;
        }
        try {
            InputStream is = ctx.getAssets().open(rel);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            is.close();
            byte[] data = bo.toByteArray();
            writeBytes(out, 200, mime(rel), data, null);
        } catch (Exception e) {
            writeText(out, 404, "not found");
        }
    }

    /* ---------------- 用户文件（files/） ---------------- */

    private void serveFiles(OutputStream out, String rel, String range, long uid) throws Exception {
        String decoded = URLDecoder.decode(rel, "UTF-8");
        if (decoded.contains("..")) {
            writeText(out, 404, "not found");
            return;
        }
        // 根目录是 users/<uid>/files —— 少这一层 files 就会 404（v0.3.3 修）
        File f = new File(new File(new File(new File(ctx.getFilesDir(), "users"),
                String.valueOf(uid)), "files"), decoded);
        if (!f.isFile()) {
            writeText(out, 404, "not found");
            return;
        }
        FileInputStream is = new FileInputStream(f);
        long size = f.length();
        long start = 0, end = size - 1;

        if (range != null && range.startsWith("bytes=")) {
            String spec = range.substring(6);
            int dash = spec.indexOf('-');
            if (dash > 0) {
                try { start = Long.parseLong(spec.substring(0, dash)); } catch (Exception ignored) {}
                String tail = spec.substring(dash + 1).trim();
                if (tail.length() > 0) {
                    try { end = Math.min(size - 1, Long.parseLong(tail)); } catch (Exception ignored) {}
                }
            }
            if (start >= size) {
                out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\n\r\n").getBytes("UTF-8"));
                is.close();
                return;
            }
            is.skip(start);
            long len = end - start + 1;
            StringBuilder h = new StringBuilder();
            h.append("HTTP/1.1 206 Partial Content\r\n");
            h.append("Content-Type: ").append(mime(f.getName())).append("\r\n");
            h.append("Content-Length: ").append(len).append("\r\n");
            h.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(size).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append("Cache-Control: private, max-age=86400\r\n");
            h.append("\r\n");
            out.write(h.toString().getBytes("UTF-8"));
            copyN(is, out, len);
        } else {
            StringBuilder h = new StringBuilder();
            h.append("HTTP/1.1 200 OK\r\n");
            h.append("Content-Type: ").append(mime(f.getName())).append("\r\n");
            h.append("Content-Length: ").append(size).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append("Cache-Control: private, max-age=86400\r\n");
            h.append("\r\n");
            out.write(h.toString().getBytes("UTF-8"));
            copyN(is, out, size);
        }
        is.close();
        out.flush();
    }

    private static void copyN(InputStream in, OutputStream out, long n) throws Exception {
        byte[] buf = new byte[16384];
        long left = n;
        while (left > 0) {
            int want = (int) Math.min(buf.length, left);
            int read = in.read(buf, 0, want);
            if (read <= 0) break;
            out.write(buf, 0, read);
            left -= read;
        }
    }

    /* ---------------- 响应 ---------------- */

    private static final byte[] CRLF = "\r\n".getBytes();

    private void writeJson(OutputStream out, String json) throws Exception {
        writeJson(out, json, null);
    }

    private void writeJson(OutputStream out, String json, String extraHeaders) throws Exception {
        byte[] data = json.getBytes("UTF-8");
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 200 OK").append("\r\n");
        h.append("Content-Type: application/json; charset=utf-8").append("\r\n");
        h.append("Content-Length: ").append(data.length).append("\r\n");
        h.append("Cache-Control: no-store").append("\r\n");
        h.append("Access-Control-Allow-Origin: *").append("\r\n");
        if (extraHeaders != null && extraHeaders.length() > 0) h.append(extraHeaders);
        h.append("\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        out.write(data);
        out.flush();
    }

    private void writeText(OutputStream out, int code, String text) throws Exception {
        byte[] data = text.getBytes("UTF-8");
        String head = "HTTP/1.1 " + code + " X\r\nContent-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + data.length + "\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(data);
        out.flush();
    }

    private void writeBytes(OutputStream out, int code, String type, byte[] data, String extra) throws Exception {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(" OK").append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(data.length).append("\r\n");
        h.append("Cache-Control: no-cache").append("\r\n");
        if (extra != null) h.append(extra);
        h.append("\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        out.write(data);
        out.flush();
    }

    private void writeEmpty(OutputStream out, int code) throws Exception {
        out.write(("HTTP/1.1 " + code + " No Content\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: *\r\n"
                + "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n\r\n").getBytes("UTF-8"));
        out.flush();
    }

    private static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".m4a")) return "audio/mp4";
        if (n.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
