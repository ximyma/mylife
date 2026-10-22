package com.mylife.archive;

import org.json.JSONArray;
import org.json.JSONObject;

/** 极薄的 JSON 取值助手，避免到处写 try/catch */
public final class Json {

    private Json() {}

    public static JSONObject obj(String s) {
        try {
            return new JSONObject(s == null ? "{}" : s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public static String str(String json, String key) {
        return obj(json).optString(key, null);
    }

    public static String str(String json, String key, String def) {
        String v = obj(json).optString(key, null);
        return v == null ? def : v;
    }

    public static int num(String json, String key, int def) {
        return obj(json).optInt(key, def);
    }

    public static JSONArray arr(String json, String key) {
        JSONArray a = obj(json).optJSONArray(key);
        return a == null ? new JSONArray() : a;
    }

    /** 把一个对象序列化进 JSON 字符串时用（带引号转义，不含外层引号） */
    public static String esc(String s) {
        if (s == null) return "";
        String q = JSONObject.quote(s);      // 返回 "..." 形式
        return q.length() >= 2 ? q.substring(1, q.length() - 1) : "";
    }

    public static String err(String msg) {
        return "{\"__error\":\"" + esc(msg) + "\"}";
    }
}
