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

    public static String op(Context ctx, long uid, String json) {
        try {
            File r = root(ctx, uid);
            String op = Json.str(json, "op", "save");
            if ("save".equals(op)) return save(r, json);
            if ("read".equals(op)) return read(r, json);
            if ("del".equals(op)) return del(r, json);
            if ("list".equals(op)) return list(r, json);
            return Json.err("未知操作 " + op);
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }

    /** 每个用户一套文件目录：filesDir/users/<uid>/files/<kind>/ */
    private static File root(Context ctx, long uid) {
        File f = new File(new File(new File(ctx.getFilesDir(), "users"), String.valueOf(uid)), "files");
        if (!f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.mkdirs();
        }
        return f;
    }

    private static File resolve(File rootDir, String kind, String name) {
        String k = safe(kind);
        String n = safe(name);
        File dir = new File(rootDir, k);
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

    private static String save(File rootDir, String json) throws Exception {
        // 前端大多传 dir（照片/缩略图/导出物各归各位），老代码传 kind——dir 优先
        String kind = Json.str(json, "dir", "");
        if (kind.length() == 0) kind = Json.str(json, "kind", "misc");
        String name = Json.str(json, "name", String.valueOf(System.currentTimeMillis()));
        String b64 = Json.str(json, "base64", "");
        // 允许 dataURL 前缀
        int comma = b64.indexOf(',');
        if (b64.startsWith("data:") && comma > 0) b64 = b64.substring(comma + 1);
        if (b64.length() == 0) return Json.err("没有收到内容");

        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        if (data.length == 0) return Json.err("文件是空的");
        if (data.length > MAX_ONE) return Json.err("单个文件超过 80MB");

        File f = resolve(rootDir, kind, name);
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

    private static String read(File rootDir, String json) throws Exception {
        String path = Json.str(json, "path", "");
        File f = new File(rootDir, path.replace("..", ""));
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

    private static String del(File rootDir, String json) throws Exception {
        String path = Json.str(json, "path", "");
        File f = new File(rootDir, path.replace("..", ""));
        boolean ok = f.isFile() && f.delete();
        JSONObject r = new JSONObject();
        r.put("ok", ok);
        return r.toString();
    }

    private static String list(File rootDir, String json) throws Exception {
        String kind = Json.str(json, "kind", "misc");
        File dir = new File(rootDir, safe(kind));
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

    /**
     * 存到系统相册：rel 是 users/<uid>/files 下的相对路径（如 ai/img/x.jpg）。
     * Android 10+ 走 MediaStore（无需存储权限）；老系统写公共图片目录再扫一遍。
     * WebView 里 <a download> 不生效（没有 DownloadListener），前端存图全靠这个口。
     */
    public static String gallery(Context ctx, long uid, String json) {
        try {
            String rel = Json.str(json, "path", "");
            if (rel.length() == 0) return Json.err("没有文件路径");
            File f = new File(root(ctx, uid), rel.replace("..", ""));
            if (!f.isFile()) return Json.err("文件不存在");
            String name = "suiyue_" + Long.toString(System.currentTimeMillis(), 36) + ".jpg";
            String where = "相册/Pictures/岁月记录助手/" + name;

            if (android.os.Build.VERSION.SDK_INT >= 29) {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH,
                        android.os.Environment.DIRECTORY_PICTURES + "/岁月记录助手");
                cv.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
                cv.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                android.net.Uri uri = ctx.getContentResolver().insert(
                        android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return Json.err("系统相册拒绝了这次写入");
                java.io.OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                if (os == null) return Json.err("相册输出流打不开");
                FileInputStream is = new FileInputStream(f);
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                is.close();
                os.flush();
                os.close();
            } else {
                File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_PICTURES), "岁月记录助手");
                if (!dir.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                }
                File dst = new File(dir, name);
                FileInputStream is = new FileInputStream(f);
                FileOutputStream fo = new FileOutputStream(dst);
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) fo.write(buf, 0, n);
                is.close();
                fo.flush();
                fo.close();
                android.media.MediaScannerConnection.scanFile(ctx,
                        new String[]{dst.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
            }
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("where", where);
            return r.toString();
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }
}
