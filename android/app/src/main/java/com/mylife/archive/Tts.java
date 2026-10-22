package com.mylife.archive;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 朗读：把安卓原生 TTS 包得皮实一点。
 *
 * 重点解决「老手机能读、新手机没声音」这一类问题，四个坑位：
 *
 *   ① Android 11+ 包可见性 —— 必须先在 Manifest 里 <queries> 声明 TTS_SERVICE，
 *      否则引擎列表是空的，new TextToSpeech() 直接 ERROR。
 *   ② 引擎可能不止一个，默认那个可能是坏的 —— 枚举 + 可指定 + 失败换下一个。
 *   ③ 中文语言包可能没装 —— setLanguage 返回 LANG_MISSING_DATA 要能报出来，
 *      而不是静默无声。
 *   ④ 单次朗读有长度上限 —— 长段落切成句，逐句读，顺便给前端做高亮回调。
 */
public class Tts {

    private static final String TAG = "Tts";
    private static final int MAX_CHARS = 900;   // 单句上限，超了就切

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextToSpeech tts;
    private volatile boolean ready = false;
    private volatile String lastError = "";
    private String enginePkg = "";

    private List<String> queue = new ArrayList<String>();
    private int cursor = 0;
    private volatile boolean playing = false;
    private WebView web;

    public Tts(Context ctx) {
        this.ctx = ctx;
    }

    public void attach(WebView w) {
        this.web = w;
    }

    /* ---------------- 初始化 ---------------- */

    public void init() {
        initWithEngine(null);
    }

    /** 指定引擎初始化；传 null 用系统默认 */
    public void initWithEngine(final String pkg) {
        release();
        try {
            TextToSpeech.OnInitListener listener = new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    if (status != TextToSpeech.SUCCESS) {
                        ready = false;
                        lastError = "朗读引擎初始化失败（status=" + status + "）。"
                                + "可能是系统里没有朗读引擎，请到「设置 → 语言与输入 → 文字转语音」装一个。";
                        Log.w(TAG, lastError);
                        push();
                        return;
                    }
                    try {
                        int r = tts.setLanguage(Locale.CHINA);
                        if (r == TextToSpeech.LANG_MISSING_DATA) {
                            ready = false;
                            lastError = "系统缺中文语音包。到「设置 → 语言与输入 → 文字转语音」下载中文。";
                        } else if (r == TextToSpeech.LANG_NOT_SUPPORTED) {
                            // 有些引擎用 SIMPLIFIED_CHINESE 更认
                            r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                                ready = false;
                                lastError = "这个朗读引擎不支持中文，换一个引擎试试。";
                            } else {
                                ready = true;
                                lastError = "";
                            }
                        } else {
                            ready = true;
                            lastError = "";
                        }

                        if (tts != null) {
                            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                                @Override public void onStart(String id) { }

                                @Override
                                public void onDone(String id) {
                                    ui.post(new Runnable() {
                                        @Override public void run() { next(); }
                                    });
                                }

                                @Override
                                public void onError(String id) {
                                    ui.post(new Runnable() {
                                        @Override public void run() {
                                            playing = false;
                                            lastError = "读到一半出错了，换一个引擎试试。";
                                            push();
                                        }
                                    });
                                }
                            });
                        }
                        Log.i(TAG, "TTS 就绪 ready=" + ready + " engine=" + enginePkg + " " + lastError);
                        push();
                    } catch (Exception e) {
                        ready = false;
                        lastError = "设置中文语音失败：" + e.getMessage();
                        push();
                    }
                }
            };

            if (pkg != null && pkg.length() > 0) {
                enginePkg = pkg;
                tts = new TextToSpeech(ctx, listener, pkg);
            } else {
                tts = new TextToSpeech(ctx, listener);
                enginePkg = "";
            }
        } catch (Exception e) {
            ready = false;
            lastError = "朗读初始化异常：" + e.getMessage();
            Log.w(TAG, lastError, e);
            push();
        }
    }

    public void release() {
        try {
            if (tts != null) { tts.stop(); tts.shutdown(); }
        } catch (Exception ignored) {
        }
        tts = null;
        ready = false;
        playing = false;
    }

    /* ---------------- 引擎与音色 ---------------- */

    /** 列出设备上的朗读引擎；Android 11+ 依赖 Manifest 的 <queries> */
    public String engines() {
        JSONArray out = new JSONArray();
        try {
            List<TextToSpeech.EngineInfo> list = null;
            if (tts != null) list = tts.getEngines();
            if (list != null) {
                for (TextToSpeech.EngineInfo e : list) {
                    JSONObject o = new JSONObject();
                    o.put("pkg", e.name);
                    o.put("label", e.label == null ? e.name : e.label);
                    o.put("current", e.name.equals(tts == null ? "" : tts.getDefaultEngine()));
                    out.put(o);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "枚举引擎失败", e);
        }
        try {
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("engines", out);
            r.put("count", out.length());
            r.put("current", enginePkg);
            return r.toString();
        } catch (Exception e) {
            return Json.err(e.getMessage());
        }
    }

    /** 当前引擎支持的中文音色 */
    public String voices() {
        JSONArray out = new JSONArray();
        try {
            if (tts != null && Build.VERSION.SDK_INT >= 21) {
                Set<Voice> vs = tts.getVoices();
                if (vs != null) {
                    for (Voice v : vs) {
                        String lang = v.getLocale() == null ? "" : v.getLocale().toString();
                        if (lang.toLowerCase().startsWith("zh")) {
                            JSONObject o = new JSONObject();
                            o.put("name", v.getName());
                            o.put("lang", lang);
                            out.put(o);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "枚举音色失败", e);
        }
        try {
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("voices", out);
            return r.toString();
        } catch (Exception e) {
            return Json.err(e.getMessage());
        }
    }

    /* ---------------- 朗读 ---------------- */

    /** 状态，前端拿它决定要不要提示用户去装引擎 */
    public String status() {
        try {
            JSONObject o = new JSONObject();
            o.put("ready", ready);
            o.put("error", lastError);
            o.put("playing", playing);
            o.put("engine", enginePkg);
            o.put("sdk", Build.VERSION.SDK_INT);
            return o.toString();
        } catch (Exception e) {
            return Json.err(e.getMessage());
        }
    }

    /**
     * 逐句朗读。items 是句子数组，前端按 index 做高亮。
     * 返回 {ok, count} 或 {ok:false, message}
     */
    public String speak(String itemsJson, final float rate) {
        try {
            if (!ready || tts == null) {
                JSONObject o = new JSONObject();
                o.put("ok", false);
                o.put("message", lastError.length() > 0 ? lastError
                        : "朗读还没准备好，稍等一下再点。");
                return o.toString();
            }
            JSONArray arr = new JSONArray(itemsJson);
            List<String> lines = new ArrayList<String>();
            for (int i = 0; i < arr.length(); i++) {
                String t = arr.optString(i, "").trim();
                if (t.length() == 0) continue;
                // 太长就切开，TTS 对超长文本不可靠
                while (t.length() > MAX_CHARS) {
                    int cut = t.lastIndexOf('。', MAX_CHARS);
                    if (cut < 200) cut = MAX_CHARS;
                    lines.add(t.substring(0, cut + 1));
                    t = t.substring(cut + 1);
                }
                if (t.length() > 0) lines.add(t);
            }
            if (lines.isEmpty()) {
                JSONObject o = new JSONObject();
                o.put("ok", false);
                o.put("message", "这一段没有可读的内容");
                return o.toString();
            }

            queue = lines;
            cursor = 0;
            playing = true;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try { tts.setSpeechRate(rate <= 0 ? 0.95f : rate); } catch (Exception ignored) {}
                    next();
                }
            });

            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("count", lines.size());
            return o.toString();

        } catch (Exception e) {
            return Json.err(e.getMessage());
        }
    }

    private void next() {
        if (!playing) return;
        if (cursor >= queue.size()) {
            playing = false;
            notifyJs("window.TTS && window.TTS.onEnd && window.TTS.onEnd()");
            push();
            return;
        }
        final int i = cursor;
        String line = queue.get(i);
        cursor++;
        notifyJs("window.TTS && window.TTS.onSeg && window.TTS.onSeg(" + i + ")");
        try {
            tts.speak(line, TextToSpeech.QUEUE_FLUSH, null, "seg" + i);
        } catch (Exception e) {
            Log.w(TAG, "speak 失败", e);
            playing = false;
            push();
        }
    }

    public void stop() {
        playing = false;
        queue = new ArrayList<String>();
        cursor = 0;
        try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
        notifyJs("window.TTS && window.TTS.onEnd && window.TTS.onEnd()");
    }

    public void pause() {
        // 原生 TTS 没有 pause，只能停；保留语义给前端
        stop();
    }

    public boolean isPlaying() {
        return playing;
    }

    /* ---------------- 与 JS 通信 ---------------- */

    private void push() {
        notifyJs("window.TTS && window.TTS.onState && window.TTS.onState(" + status() + ")");
    }

    private void notifyJs(final String js) {
        if (web == null) return;
        ui.post(new Runnable() {
            @Override
            public void run() {
                try { web.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }
}
