package com.mylife.archive;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.security.SecureRandom;
import java.security.spec.KeySpec;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

import android.database.sqlite.SQLiteDatabase;

/**
 * 账号库（auth.db）：users + sessions。
 * 与网页端的账号库各自独立——密码哈希两端算法不必一致，
 * 因为账号只在本机校验，不存在跨端登录。
 *
 * 验证码 v0.3 固定 1234（演示版）；真短信在 v0.4 接入。
 */
public class Auth {

    private static final String TAG = "Auth";
    private static final String CODE_FIXED = "1234";
    private static final int TOKEN_DAYS = 30;
    private static final int LOGIN_MAX_FAILS = 5;
    private static final long LOGIN_LOCK_MS = 10 * 60 * 1000L;
    private static final int PBKDF2_ITERS = 65536;
    private static final int PBKDF2_BITS = 256;

    public static class User {
        public long uid;
        public String phone;
        public String nickname;
    }

    private final SQLiteDatabase adb;
    private final Context ctx;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, long[]> failLocks = new HashMap<>(); // phone -> {fails, until}

    public Auth(Context ctx) {
        this.ctx = ctx;
        SQLiteDatabase d = ctx.openOrCreateDatabase("auth.db", Context.MODE_PRIVATE, null);
        d.execSQL("CREATE TABLE IF NOT EXISTS users (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "phone TEXT NOT NULL UNIQUE," +
                "password_hash TEXT NOT NULL," +
                "salt TEXT NOT NULL," +
                "nickname TEXT," +
                "created_at TEXT DEFAULT (datetime('now')))");
        d.execSQL("CREATE TABLE IF NOT EXISTS sessions (" +
                "token TEXT PRIMARY KEY," +
                "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
                "expires_at TEXT NOT NULL)");
        this.adb = d;
    }

    private static String hashPw(String password, String salt) throws Exception {
        SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        KeySpec spec = new PBEKeySpec(password.toCharArray(), hex(salt), PBKDF2_ITERS, PBKDF2_BITS);
        return hex(f.generateSecret(spec).getEncoded());
    }

    private static byte[] hex(String s) {
        int n = s.length() / 2;
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) {
            b[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return b;
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static String hex(byte[] b) {
        char[] r = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            r[i * 2] = HEX[(b[i] >> 4) & 0xf];
            r[i * 2 + 1] = HEX[b[i] & 0xf];
        }
        return new String(r);
    }

    private boolean phoneTaken(String phone) {
        android.database.Cursor c = adb.rawQuery("SELECT 1 FROM users WHERE phone=?", new String[]{phone});
        boolean hit = c.moveToFirst();
        c.close();
        return hit;
    }

    private int userCount() {
        android.database.Cursor c = adb.rawQuery("SELECT count(*) FROM users", null);
        c.moveToFirst();
        int n = c.getInt(0);
        c.close();
        return n;
    }

    /** 注册。返回 {uid, token, phone, migrated}；抛 Exception 则前端收到 message */
    public String register(String phone, String password, String code, String nickname) throws Exception {
        lock.lock();
        try {
            if (phone == null || !phone.matches("1[3-9]\\d{9}")) throw new Exception("手机号格式不对");
            if (password == null || password.length() < 6) throw new Exception("密码至少 6 位");
            if (!CODE_FIXED.equals(code == null ? "" : code)) {
                throw new Exception("验证码不对（演示版固定 " + CODE_FIXED + "）");
            }
            if (phoneTaken(phone)) throw new Exception("这个手机号已经注册过，直接登录");

            SecureRandom rnd = new SecureRandom();
            byte[] salt = new byte[16];
            rnd.nextBytes(salt);
            String saltHex = hex(salt);
            String hash = hashPw(password, saltHex);

            boolean migrate = userCount() == 0 && MainActivity.hasLegacyData(ctx);

            android.content.ContentValues cv = new android.content.ContentValues();
            cv.put("phone", phone);
            cv.put("password_hash", hash);
            cv.put("salt", saltHex);
            cv.put("nickname", nickname == null || nickname.trim().isEmpty() ? null : nickname.trim());
            long uid = adb.insert("users", null, cv);

            if (migrate) {
                MainActivity.migrateLegacy(ctx, uid);
                Log.i(TAG, "旧数据已归属 uid=" + uid);
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("uid", uid);
            out.put("phone", phone);
            out.put("token", issueToken(uid));
            out.put("migrated", migrate);
            out.put("message", migrate ? "注册成功，旧档案已归属这个账号" : "注册成功");
            return out.toString();
        } finally {
            lock.unlock();
        }
    }

    public String login(String phone, String password) throws Exception {
        lock.lock();
        try {
            long[] lk = failLocks.get(phone);
            long now = System.currentTimeMillis();
            if (lk != null && lk[1] > now) {
                long min = (lk[1] - now) / 60000 + 1;
                throw new Exception("失败次数太多，请 " + min + " 分钟后再试");
            }
            android.database.Cursor c = adb.rawQuery(
                    "SELECT id, password_hash, salt FROM users WHERE phone=?", new String[]{phone});
            boolean ok = false;
            long uid = -1;
            if (c.moveToFirst()) {
                uid = c.getLong(0);
                try {
                    String expect = c.getString(1);
                    String got = hashPw(password == null ? "" : password, c.getString(2));
                    ok = expect.equals(got);
                } catch (Exception ignored) {
                }
            }
            c.close();
            if (!ok) {
                long[] lk2 = failLocks.get(phone);
                int fails = (lk2 == null ? 0 : (int) lk2[0]) + 1;
                long until = fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0;
                failLocks.put(phone, new long[]{fails, until});
                throw new Exception("手机号或密码不对" +
                        (until > 0 ? "，已锁定 10 分钟" : "（还剩 " + (LOGIN_MAX_FAILS - fails) + " 次机会）"));
            }
            failLocks.remove(phone);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("uid", uid);
            out.put("phone", phone);
            out.put("token", issueToken(uid));
            return out.toString();
        } finally {
            lock.unlock();
        }
    }

    /** 演示版：不真发。真短信 v0.4 接入 */
    public String sms(String phone) throws Exception {
        if (phone == null || !phone.matches("1[3-9]\\d{9}")) throw new Exception("手机号格式不对");
        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("fixed", true);
        return out.toString();
    }

    private String issueToken(long uid) {
        SecureRandom rnd = new SecureRandom();
        byte[] b = new byte[32];
        rnd.nextBytes(b);
        String token = hex(b);
        // 过期时间用 SQLite 的日期函数算，保证与 verify 的比较一致
        adb.execSQL("INSERT INTO sessions (token, user_id, expires_at) " +
                "VALUES (?, ?, datetime('now','+30 days'))", new Object[]{token, uid});
        return token;
    }

    /** token -> 用户；无效/过期返回 null */
    public User verify(String token) {
        if (token == null || token.isEmpty()) return null;
        try {
            android.database.Cursor c = adb.rawQuery(
                    "SELECT s.user_id, u.phone, u.nickname FROM sessions s " +
                            "JOIN users u ON u.id = s.user_id " +
                            "WHERE s.token = ? AND s.expires_at > datetime('now')",
                    new String[]{token});
            User u = null;
            if (c.moveToFirst()) {
                u = new User();
                u.uid = c.getLong(0);
                u.phone = c.getString(1);
                u.nickname = c.getString(2);
            }
            c.close();
            return u;
        } catch (Exception e) {
            Log.w(TAG, "verify: " + e.getMessage());
            return null;
        }
    }

    public void logout(String token) {
        if (token == null || token.isEmpty()) return;
        try {
            adb.execSQL("DELETE FROM sessions WHERE token=?", new Object[]{token});
        } catch (Exception ignored) {
        }
    }
}
