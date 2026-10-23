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
        return sv(obj(json), key, null);
    }

    public static String str(String json, String key, String def) {
        return sv(obj(json), key, def);
    }

    /**
     * 取字符串——**这是安卓端最容易踩的坑，务必用它而不是 optString(name, "")**。
     *
     * org.json 的 optString 实现是 `JSON.toString(opt(name))`，而 JSONObject.NULL
     * 的 toString() 返回字符串 "null"。于是前端发来的
     *     {"model": null}
     * 到了 Java 侧变成字符串 "null"（4 个字符，非空！），
     * `if (model.length() == 0)` 判断失效，请求里就带上了 model=null，
     * 服务端回 400 "Model does not exist"。
     *
     * Node 端写的是 `body.model || profile.default_model`，null 是 falsy 直接跳过，
     * 所以同一个接口网页端一直正常、手机端一律失败。
     *
     * 这里把 JSON null / 缺失 / 字面量 "null" / "undefined" 统一当成"没给"。
     */
    public static String sv(JSONObject o, String key, String def) {
        if (o == null || key == null || !o.has(key) || o.isNull(key)) return def;
        Object v = o.opt(key);
        if (v == null) return def;
        String s = String.valueOf(v);
        if (s.length() == 0 || "null".equals(s) || "undefined".equals(s)) return def;
        return s;
    }

    public static String sv(JSONObject o, String key) {
        return sv(o, key, "");
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
