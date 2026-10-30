package com.mylife.archive;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 任务队列（安卓端）。与 Node 端同表、同接口、同一套状态机。
 *
 * 为什么手机端也要：
 *   0.5.0 之前只有网页端有队列，设置页的「跑一次自检」在手机上直接提示"这个版本还没有"。
 *   两端的接口形态不一致，是后面接配音、渲染这些长任务时最容易翻车的地方，先补齐。
 *
 * 目前只实现 selftest（自检用）；真正的重活（配音、短片）由前端逐段调用同步接口，
 * 进度显示在前端，不占服务端线程——手机的内存比服务器金贵。
 */
public final class Jobs {

    private static final String TAG = "Jobs";
    private static volatile boolean working = false;
    private static volatile boolean started = false;

    private Jobs() {}

    /** 进程重启后，把上次卡在 running 的任务放回队列 */
    public static void resetStale(Db db) {
        try {
            db.exec("UPDATE jobs SET status='queued', stage='重启后继续' WHERE status='running'", new JSONArray());
        } catch (Exception e) {
            Log.w(TAG, "复位任务失败（可能是旧库还没有 jobs 表）", e);
        }
    }

    public static String create(Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            String type = Json.sv(in, "type");
            if (type.length() == 0) return Json.err("没有任务类型");
            // 手机端做不了的重活，如实说明去哪做（前端会把这个 message 直接显示出来）
            if (type.equals("aivideo") || type.equals("movie")) {
                return Json.err("这个安装包里没有渲染引擎（ffmpeg），短片合成要用电脑版；手机上排分镜、看字幕稿不受影响");
            }
            if (type.equals("aimusic")) {
                return Json.err("AI 作曲演唱要连音乐大模型，请用电脑版；手机上可以点「演奏出来」先听本地合成版");
            }
            if (!type.equals("selftest")) return Json.err("这个版本还不支持任务 " + type);

            JSONArray p = new JSONArray();
            p.put(type);
            p.put(in.has("payload") ? in.opt("payload").toString() : "{}");
            p.put("排队中");
            String r = db.exec("INSERT INTO jobs (type, payload_json, stage) VALUES (?,?,?)", p);
            JSONObject o = new JSONObject(r);
            long id = o.optLong("lastId", 0);
            startWorker(db);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("id", id);
            return out.toString();
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }

    public static String get(Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            long id = in.optLong("id", 0);
            if (id <= 0) {
                String rows = db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT 10", new JSONArray());
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("items", new JSONArray(rows));
                return out.toString();
            }
            String rows = db.query("SELECT * FROM jobs WHERE id=?", params(id));
            JSONArray arr = new JSONArray(rows);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("job", arr.length() > 0 ? arr.getJSONObject(0) : JSONObject.NULL);
            return out.toString();
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }

    public static String cancel(Db db, String payload) {
        try {
            JSONObject in = Json.obj(payload);
            long id = in.optLong("id", 0);
            if (id <= 0) return Json.err("没有任务号");
            JSONArray p = new JSONArray();
            p.put(id);
            db.exec("UPDATE jobs SET cancel_flag=1 WHERE id=? AND status IN ('queued','running')", p);
            JSONArray p2 = new JSONArray();
            p2.put(id);
            db.exec("UPDATE jobs SET status='canceled', finished_at=datetime('now') WHERE id=? AND status='queued'", p2);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            return out.toString();
        } catch (Exception e) {
            return Json.err(String.valueOf(e.getMessage()));
        }
    }

    /* ---------------- worker ---------------- */

    private static synchronized void startWorker(final Db db) {
        if (started) return;
        started = true;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                loop(db);
            }
        }, "job-worker");
        t.setDaemon(true);
        t.start();
    }

    private static void loop(Db db) {
        while (true) {
            try {
                if (working) { Thread.sleep(200); continue; }
                String rows = db.query("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1", new JSONArray());
                JSONArray arr = new JSONArray(rows);
                if (arr.length() == 0) { Thread.sleep(400); continue; }
                JSONObject job = arr.getJSONObject(0);
                working = true;
                run(db, job.optLong("id", 0), job.optString("type", ""), job.optString("payload_json", "{}"));
                working = false;
            } catch (Exception e) {
                working = false;
                Log.w(TAG, "worker 异常", e);
                try { Thread.sleep(600); } catch (Exception ignored) {}
            }
        }
    }

    private static void run(Db db, long id, String type, String payloadJson) {
        try {
            JSONArray p = new JSONArray();
            p.put(id);
            db.exec("UPDATE jobs SET status='running', started_at=datetime('now'), progress=0, stage='准备中' WHERE id=?", p);

            JSONObject payload = Json.obj(payloadJson);
            int steps = Math.max(1, payload.optInt("steps", 6));
            int ms = Math.max(20, payload.optInt("ms", 120));

            if (!type.equals("selftest")) {
                fail(db, id, "未知任务类型 " + type);
                return;
            }

            for (int i = 1; i <= steps; i++) {
                Thread.sleep(ms);
                if (canceled(db, id)) {
                    setStatus(db, id, "canceled", null, null);
                    return;
                }
                JSONArray q = new JSONArray();
                q.put((double) i / steps);
                q.put("第 " + i + "/" + steps + " 步");
                q.put(id);
                db.exec("UPDATE jobs SET progress=?, stage=? WHERE id=?", q);
            }

            JSONArray done = new JSONArray();
            done.put("{\"steps\":" + steps + "}");
            done.put(id);
            db.exec("UPDATE jobs SET status='done', progress=1, stage='完成', result_json=?, finished_at=datetime('now') WHERE id=?", done);
        } catch (Exception e) {
            fail(db, id, String.valueOf(e.getMessage()));
        }
    }

    private static boolean canceled(Db db, long id) {
        try {
            String rows = db.query("SELECT cancel_flag FROM jobs WHERE id=?", params(id));
            JSONArray arr = new JSONArray(rows);
            return arr.length() > 0 && arr.getJSONObject(0).optInt("cancel_flag", 0) == 1;
        } catch (Exception e) {
            return false;
        }
    }

    private static void fail(Db db, long id, String message) {
        setStatus(db, id, "failed", message, null);
    }

    private static void setStatus(Db db, long id, String status, String error, String result) {
        try {
            JSONArray p = new JSONArray();
            p.put(status);
            p.put(error == null ? JSONObject.NULL : error);
            p.put(id);
            db.exec("UPDATE jobs SET status=?, error=?, finished_at=datetime('now') WHERE id=?", p);
        } catch (Exception e) {
            Log.w(TAG, "更新任务状态失败", e);
        }
    }

    private static JSONArray params(long id) {
        JSONArray a = new JSONArray();
        a.put(id);
        return a;
    }
}
