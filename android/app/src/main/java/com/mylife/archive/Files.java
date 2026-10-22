package com.mylife.archive;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;

/**
 * 文件读写：照片、录音、视频都落在 filesDir/files/<kind>/ 下。
 * 前端拿到的是相对路径（photo/a1b2.jpg），浏览器用 /files/photo/a1b2.jpg 取。
 */
public final class Files {

    private static final String TAG = "Files";
    private static final int MAX_ONE = 80 * 1024 * 1024;

    private Files() {}

    public static String op(Context ctx, String json) {
        try {
            String op = Json.str(json, "op", "save");
            if ("save".equals(op)) return save(ctx, json);
            if ("read".equals(op)) return read(ctx, json);
            if ("del".equals(op)) return del(ctx, json);
            if ("list".equals(op)) return list(ctx, json);
            return Json.err("未知操作 " + op);
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }

    private static File root(Context ctx) {
        File f = new File(ctx.getFilesDir(), "files");
        if (!f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.mkdirs();
        }
        return f;
    }

    private static File resolve(Context ctx, String kind, String name) {
        String k = safe(kind);
        String n = safe(name);
        File dir = new File(root(ctx), k);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return new File(dir, n);
    }

    private static String safe(String s) {
        if (s == null) return "misc";
        return s.replace("..", "").replace("/", "").replace("\\", "");
    }

    private static String save(Context ctx, String json) throws Exception {
        String kind = Json.str(json, "kind", "misc");
        String name = Json.str(json, "name", String.valueOf(System.currentTimeMillis()));
        String b64 = Json.str(json, "base64", "");
        // 允许 dataURL 前缀
        int comma = b64.indexOf(',');
        if (b64.startsWith("data:") && comma > 0) b64 = b64.substring(comma + 1);
        if (b64.length() == 0) return Json.err("没有收到内容");

        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        if (data.length == 0) return Json.err("文件是空的");
        if (data.length > MAX_ONE) return Json.err("单个文件超过 80MB");

        File f = resolve(ctx, kind, name);
        if (Json.num(json, "append", 0) == 1) {
            FileOutputStream fo = new FileOutputStream(f, true);
            fo.write(data);
            fo.flush();
            fo.close();
        } else {
            FileOutputStream fo = new FileOutputStream(f, false);
            fo.write(data);
            fo.flush();
            fo.close();
        }
        long size = f.length();
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("path", safe(kind) + "/" + safe(name));
        r.put("bytes", size);
        Log.d(TAG, "写入 " + r.optString("path") + " " + size + "B");
        return r.toString();
    }

    private static String read(Context ctx, String json) throws Exception {
        String path = Json.str(json, "path", "");
        File f = new File(root(ctx), path.replace("..", ""));
        if (!f.isFile()) return Json.err("文件不存在");
        FileInputStream is = new FileInputStream(f);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("base64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
        r.put("bytes", f.length());
        return r.toString();
    }

    private static String del(Context ctx, String json) throws Exception {
        String path = Json.str(json, "path", "");
        File f = new File(root(ctx), path.replace("..", ""));
        boolean ok = f.isFile() && f.delete();
        JSONObject r = new JSONObject();
        r.put("ok", ok);
        return r.toString();
    }

    private static String list(Context ctx, String json) throws Exception {
        String kind = Json.str(json, "kind", "misc");
        File dir = new File(root(ctx), safe(kind));
        org.json.JSONArray arr = new org.json.JSONArray();
        File[] fs = dir.listFiles();
        if (fs != null) {
            for (File f : fs) {
                JSONObject o = new JSONObject();
                o.put("name", f.getName());
                o.put("bytes", f.length());
                arr.put(o);
            }
        }
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("items", arr);
        return r.toString();
    }
}
