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
 *   POST /api/file    {op, ...}      -> 落盘 / 读取 / 删除
 *   GET  /files/<rel>                 -> 二进制，支持 Range
 */
public class LocalServer {

    private static final String TAG = "LocalServer";
    private static final int MAX_BODY = 64 * 1024 * 1024;   // 单请求 64MB 上限

    private final Context ctx;
    private final Db db;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    private ServerSocket socket;
    private volatile boolean running = false;
    private int port = 0;

    public LocalServer(Context ctx, Db db) {
        this.ctx = ctx;
        this.db = db;
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
        InputStream in = client.getInputStream();
        OutputStream out = client.getOutputStream();

        byte[] all = readAll(in, MAX_BODY);
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

        // Range 头（视频拖动）
        String range = null;
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i];
            int c = l.indexOf(':');
            if (c < 0) continue;
            String k = l.substring(0, c).trim().toLowerCase();
            if (k.equals("range")) range = l.substring(c + 1).trim();
        }

        if ("OPTIONS".equals(method)) {
            writeEmpty(out, 204);
            return;
        }

        if (path.startsWith("/api/")) {
            String json = routeApi(path, body);
            writeJson(out, json);
            return;
        }

        if (path.startsWith("/files/")) {
            serveFiles(out, path.substring(7), range);
            return;
        }

        serveAsset(out, path);
    }

    /** 读完整个请求。手机内存有限，所以有上限；超了直接截断，上层会报错。 */
    private static byte[] readAll(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[16384];
        int n;
        int guard = 0;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            guard += n;
            if (guard >= max) break;
            // 已经读到 Content-Length 指定的长度就停，不等连接关闭
            byte[] cur = bo.toByteArray();
            int h = indexOfHeaderEnd(cur);
            if (h >= 0) {
                long need = contentLength(cur, h);
                if (need >= 0 && cur.length - (h + 4) >= need) break;
            }
            if (in.available() == 0) break;
        }
        return bo.toByteArray();
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

    private String routeApi(String path, byte[] body) {
        try {
            String json = new String(body, "UTF-8");
            if (path.equals("/api/query")) {
                return db.query(Json.str(json, "sql"), Json.arr(json, "params"));
            }
            if (path.equals("/api/exec")) {
                return db.exec(Json.str(json, "sql"), Json.arr(json, "params"));
            }
            if (path.equals("/api/ai")) {
                return Ai.chat(ctx, db, json);
            }
            if (path.equals("/api/file")) {
                return Files.op(ctx, json);
            }
            return "{\"__error\":\"未知接口 " + path + "\"}";
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

    private void serveFiles(OutputStream out, String rel, String range) throws Exception {
        String decoded = URLDecoder.decode(rel, "UTF-8");
        if (decoded.contains("..")) {
            writeText(out, 404, "not found");
            return;
        }
        File f = new File(new File(ctx.getFilesDir(), "files"), decoded);
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
        byte[] data = json.getBytes("UTF-8");
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 200 OK").append("\r\n");
        h.append("Content-Type: application/json; charset=utf-8").append("\r\n");
        h.append("Content-Length: ").append(data.length).append("\r\n");
        h.append("Cache-Control: no-store").append("\r\n");
        h.append("Access-Control-Allow-Origin: *").append("\r\n");
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
