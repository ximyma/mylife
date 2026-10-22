package com.mylife.archive;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;

/**
 * 数据层：一个 SQLite 文件，schema.sql 与网页端共用。
 *
 * 只有两个对外能力：
 *   query(sql, params) -> JSON 数组
 *   exec(sql, params)  -> {changes, lastId}
 *
 * 业务 SQL 全部写在前端 db.js 里，这里不懂业务。
 */
public class Db {

    private static final String TAG = "Db";
    private static final String DB_NAME = "archive.db";

    private final Context ctx;
    private SQLiteDatabase db;

    public Db(Context ctx) {
        this.ctx = ctx;
    }

    public void open() throws Exception {
        File f = ctx.getDatabasePath(DB_NAME);
        File dir = f.getParentFile();
        if (dir != null && !dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        boolean fresh = !f.exists() || f.length() == 0;
        db = SQLiteDatabase.openOrCreateDatabase(f, null);
        db.execSQL("PRAGMA foreign_keys = ON");
        if (fresh) {
            Log.i(TAG, "首次启动，建表：" + f.getAbsolutePath());
            initSchema();
        }
    }

    private void initSchema() throws Exception {
        String raw = readAsset("schema.sql");
        List<String> stmts = splitSql(raw);
        int ok = 0;
        for (String s : stmts) {
            if (s.trim().isEmpty()) continue;
            try {
                db.execSQL(s);
                ok++;
            } catch (Exception e) {
                // 单条失败不阻断：比如 PRAGMA 在某些版本上不支持
                Log.w(TAG, "建表语句跳过：" + s.substring(0, Math.min(60, s.length())), e);
            }
        }
        Log.i(TAG, "建表完成，执行 " + ok + "/" + stmts.size() + " 条");
    }

    /** 按分号切语句；整行注释丢弃。schema.sql 的写法必须保证语句内不出现分号。 */
    private static List<String> splitSql(String raw) {
        List<String> out = new ArrayList<String>();
        StringBuilder cur = new StringBuilder();
        BufferedReader br = new BufferedReader(new StringReader(raw));
        try {
            String line;
            while ((line = br.readLine()) != null) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith("--")) continue;
                cur.append(line).append('\n');
                if (t.endsWith(";")) {
                    String s = cur.toString().trim();
                    out.add(s.substring(0, s.length() - 1));
                    cur.setLength(0);
                }
            }
        } catch (IOException ignored) {
        }
        if (cur.toString().trim().length() > 0) out.add(cur.toString().trim());
        return out;
    }

    private String readAsset(String name) throws Exception {
        InputStream is = ctx.getAssets().open(name);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    /* ---------------- 对外两个方法 ---------------- */

    public String query(String sql, JSONArray params) throws Exception {
        Cursor c = db.rawQuery(sql, toArgs(params));
        JSONArray rows = new JSONArray();
        String[] cols = c.getColumnNames();
        try {
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                for (int i = 0; i < cols.length; i++) {
                    if (c.isNull(i)) o.put(cols[i], JSONObject.NULL);
                    else o.put(cols[i], c.getString(i));
                }
                rows.put(o);
            }
        } finally {
            c.close();
        }
        return rows.toString();
    }

    public String exec(String sql, JSONArray params) throws Exception {
        String s = sql.trim().toLowerCase();
        if (s.startsWith("select") || s.startsWith("pragma")) {
            throw new Exception("exec 不接受查询语句");
        }
        if (s.startsWith("drop") || s.startsWith("alter") || s.startsWith("attach")
                || s.startsWith("create") || s.startsWith("vacuum")) {
            throw new Exception("exec 不允许改表结构");
        }
        db.execSQL(sql, toArgs(params));
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("changes", scalar("SELECT changes()"));
        r.put("lastId", scalar("SELECT last_insert_rowid()"));
        return r.toString();
    }

    private long scalar(String sql) {
        Cursor c = db.rawQuery(sql, null);
        long v = 0;
        try {
            if (c.moveToFirst()) v = c.getLong(0);
        } finally {
            c.close();
        }
        return v;
    }

    /** rawQuery 只认 String[]，SQLite 会把它们按 TEXT 绑定；数字列靠 SQLite 的亲和性转换 */
    private static String[] toArgs(JSONArray p) {
        if (p == null) return new String[0];
        String[] a = new String[p.length()];
        for (int i = 0; i < p.length(); i++) {
            if (p.isNull(i)) a[i] = null;
            else a[i] = String.valueOf(p.opt(i));
        }
        return a;
    }

    public SQLiteDatabase raw() {
        return db;
    }

    /** 取一个设置项（API Key 这类只在原生侧读，不下发到 JS） */
    public String setting(String k) {
        Cursor c = db.rawQuery("SELECT v FROM settings WHERE k=?", new String[]{k});
        String v = null;
        try {
            if (c.moveToFirst()) v = c.getString(0);
        } finally {
            c.close();
        }
        return v;
    }

    public void putSetting(String k, String v) {
        db.execSQL("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                new Object[]{k, v});
    }

    public void close() {
        try {
            if (db != null && db.isOpen()) db.close();
        } catch (Exception ignored) {
        }
    }
}
