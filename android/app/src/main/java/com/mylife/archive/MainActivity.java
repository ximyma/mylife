package com.mylife.archive;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.content.pm.PackageManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 壳：起本地服务 → WebView 加载 http://127.0.0.1:port/ → 只补三件原生能力
 *   ① 朗读（Tts.java，原生 TTS，比 WebView 的 speechSynthesis 可靠）
 *   ② 相册选图（<input type=file> 在 WebView 里默认没反应）
 *   ③ 返回键：先停朗读，再回退
 */
public class MainActivity extends Activity {

    private static final String TAG = "MainActivity";
    private static final int REQ_PERM = 1001;
    private static final int REQ_FILE = 1002;
    private static final int REQ_MIC = 1003;

    private WebView web;
    private Db db;
    private LocalServer server;
    private Auth auth;

    /** v0.3.3：原生录音（绕开 WebView 的 getUserMedia，国产 ROM 上那层不可靠） */
    private final MicRec mic = new MicRec();

    /** v0.2 的旧单用户库还在吗（决定首个注册账号是否继承） */
    public static boolean hasLegacyData(Context ctx) {
        return new File(ctx.getDatabasePath("archive.db").getParentFile(), "archive.db").isFile();
    }

    /** 首个注册账号继承旧数据：移动（不是复制），避免两份数据分叉 */
    public static void migrateLegacy(Context ctx, long uid) {
        File base = ctx.getDatabasePath("archive.db").getParentFile();
        File legacyDb = new File(base, "archive.db");
        if (!legacyDb.isFile()) return;
        File userDir = new File(new File(ctx.getFilesDir(), "users"), String.valueOf(uid));
        //noinspection ResultOfMethodCallIgnored
        userDir.mkdirs();
        File targetDb = new File(userDir, "archive.db");
        if (targetDb.isFile()) //noinspection ResultOfMethodCallIgnored
            targetDb.delete();
        for (String ext : new String[]{"-wal", "-shm"}) {
            File s = new File(base, "archive.db" + ext);
            if (s.isFile()) {
                File t = new File(userDir, "archive.db" + ext);
                //noinspection ResultOfMethodCallIgnored
                s.renameTo(t);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        legacyDb.renameTo(targetDb);
        File legacyFiles = new File(ctx.getFilesDir(), "files");
        if (legacyFiles.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            legacyFiles.renameTo(new File(userDir, "files"));
        }
        Log.i("MainActivity", "v0.2 旧数据已归属 uid=" + uid);
    }
    private Tts tts;

    private ValueCallback<Uri[]> fileCallback;

    /* 流式导出（v0.9.41）：分多次 write 写同一个文件，JS 不用把整包一次性拼成字符串。
       小米9 实测：素材全选 171MB 一次性 stringify → WebView 爆内存，App 进程直接闪退。 */
    private java.io.OutputStream exportOs = null;
    private Uri exportUri = null;
    private View splash;
    private TextView status;
    private ProgressBar bar;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        splash = findViewById(R.id.splash);
        status = findViewById(R.id.status);
        bar = findViewById(R.id.bar);

        setupWeb();
        tts = new Tts(getApplicationContext());
        tts.attach(web);
        requestPerms();
        boot();
    }

    /* ---------------- 启动链：开库 → 起服务 → 加载 ---------------- */

    private void boot() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    say("正在启动本地服务", 55);
                    auth = new Auth(getApplicationContext());
                    server = new LocalServer(getApplicationContext(), auth);
                    final int port = server.start();

                    // TextToSpeech 必须在主线程构造
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            tts.init();
                        }
                    });

                    say("正在载入界面", 90);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            web.loadUrl("http://127.0.0.1:" + port + "/");
                        }
                    });
                } catch (final Exception e) {
                    Log.e(TAG, "启动失败", e);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            say("启动失败：" + e.getMessage(), 0);
                        }
                    });
                }
            }
        }, "boot").start();
    }

    private void say(String text, int progress) {
        if (status != null) status.setText(text);
        if (bar != null) bar.setProgress(progress);
    }

    /* ---------------- WebView ---------------- */

    private void setupWeb() {
        // 照片和录音是 <img src="/files/..."> / <audio src="/files/..."> 直接取的，
        // 标签发不了 Authorization 头，只能靠 cookie 过鉴权。本地服务在登录时
        // 会 Set-Cookie，这里必须允许 WebView 收下并回传。
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cm.setAcceptThirdPartyCookies(web, true);
            }
        } catch (Throwable t) {
            Log.w(TAG, "cookie 开关设置失败", t);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setDefaultTextEncodingName("UTF-8");
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (splash != null && splash.getVisibility() == View.VISIBLE) {
                    splash.setVisibility(View.GONE);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /**
             * WebView 里的录音要过两道门：
             *   ① 系统权限（Manifest 声明 + requestPermissions）——这道已经有了
             *   ② WebView 自己的授权回调——以前漏的就是这道
             * 少了 onPermissionRequest，JS 那边拿到的一律是 NotAllowedError，
             * 界面上看起来像"没给麦克风权限"，其实系统在 ABIitaries 早就点了允许。
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                String[] want = request.getResources();
                java.util.List<String> grant = new java.util.ArrayList<>();

                for (String r : want) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        if (hasPerm(Manifest.permission.RECORD_AUDIO)) grant.add(r);
                    } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        if (hasPerm(Manifest.permission.CAMERA)) grant.add(r);
                    }
                    // 其它资源一概不放
                }

                if (grant.isEmpty()) {
                    request.deny();
                    // 顺手把系统那道门也要一次：用户点完允许，再点录音就能成
                    if (!hasPerm(Manifest.permission.RECORD_AUDIO)
                            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                    toastIt("录音权限没给。到系统设置 → 应用 → 岁月记录助手 → 权限里打开麦克风。");
                } else {
                    request.grant(grant.toArray(new String[0]));
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                // 上一次的回调没还就来了新的：必须先给旧的回 null，
                // 否则 WebView 认为上一次还没结束，之后再也不弹选择器
                if (fileCallback != null) {
                    try { fileCallback.onReceiveValue(null); } catch (Exception ignored) {}
                }
                fileCallback = cb;
                try {
                    // v0.9.42：input 带 multiple 时算多选——相册里能勾好几张一起传。
                    // 只开 extra 不给够没用，回调那边还得按 ClipData 把每一张都取出来。
                    boolean multi = false;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        multi = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                    }
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    String[] accept = params.getAcceptTypes();
                    String type = "*/*";
                    if (accept != null) {
                        for (String a : accept) {
                            if (a == null) continue;
                            if (a.contains("image")) { type = "image/*"; break; }
                            if (a.contains("video")) { type = "video/*"; break; }
                            if (a.contains("audio")) { type = "audio/*"; break; }
                        }
                    }
                    i.setType(type);
                    if (multi) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(
                            Intent.createChooser(i, multi ? "选择照片（可多选）" : "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new TtsBridge(), "NativeTTS");
        web.addJavascriptInterface(new NativeIO(), "NativeIO");
        web.addJavascriptInterface(new NativeRec(), "NativeRec");
        // 开启 WebView 远程调试：电脑 chrome://inspect 可看 console/元素；logcat 能收到 JS 报错
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /* ---------------- 录音桥（v0.3.3） ---------------- */

    /**
     * 前端录音优先级：
     *   ① window.NativeRec 存在 → 走原生 AudioRecord（稳）
     *   ② 否则 / 原生也失败 → 走 WebView 的 getUserMedia
     * 桥里只做三件事：查权限、要权限、录。
     */
    public class NativeRec {

        /** "granted" / "denied" + 是否支持原生录音 */
        @JavascriptInterface
        public String state() {
            boolean ok = hasPerm(Manifest.permission.RECORD_AUDIO);
            return "{\"perm\":\"" + (ok ? "granted" : "denied") + "\",\"running\":" + mic.isRunning() + "}";
        }

        /** 要系统权限；结果异步回到 window.__micPerm('granted'|'denied') */
        @JavascriptInterface
        public void ask() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                            || hasPerm(Manifest.permission.RECORD_AUDIO)) {
                        callJsMic("granted");
                        return;
                    }
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            });
        }

        /** token 用来定位是哪个用户（每个用户一套文件目录），name 是文件名 */
        @JavascriptInterface
        public String start(String token, String name) {
            Auth.User u = auth == null ? null : auth.verify(token);
            if (u == null) return "err:登录已过期，重新登录再录";
            if (!hasPerm(Manifest.permission.RECORD_AUDIO)) {
                ask();
                return "err:needperm";
            }
            return mic.start(getApplicationContext(), u.uid, name);
        }

        @JavascriptInterface
        public String stop() {
            return mic.stop();
        }

        @JavascriptInterface
        public String cancel() {
            return mic.cancel();
        }

        @JavascriptInterface
        public double level() {
            return mic.level();
        }

        @JavascriptInterface
        public long seconds() {
            return mic.seconds();
        }

        /** 体检报告：出问题时让用户截图 */
        @JavascriptInterface
        public String info() {
            String j = MicRec.info(getApplicationContext(), hasPerm(Manifest.permission.RECORD_AUDIO));
            try {
                org.json.JSONObject o = new org.json.JSONObject(j);
                o.put("webview", String.valueOf(WebSettings.getDefaultUserAgent(MainActivity.this)));
                o.put("native", true);
                return o.toString();
            } catch (Exception e) {
                return j;
            }
        }
    }

    private void callJsMic(final String result) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web == null) return;
                web.evaluateJavascript("window.__micPerm&&window.__micPerm('" + result + "')", null);
            }
        });
    }

    /* ---------------- 导出桥 ---------------- */

    /** 档案导出：JS 把整包 JSON 递过来，落到手机的 Download 目录，文件管理器里能直接看到 */
    public class NativeIO {

        /**
         * v0.9.36：登录 token 在原生侧再存一份。
         * localStorage 按 origin 隔离，本地服务端口一旦不是固定的 34567
         * （被占用时退到随机端口），上次登录的 token 就读不到了。
         * 这里用 SharedPreferences 兜底，JS 侧读不到 localStorage 时取这份。
         */
        private android.content.SharedPreferences prefs() {
            return getSharedPreferences("mylife_session", MODE_PRIVATE);
        }

        @JavascriptInterface
        public String getToken() {
            try { return prefs().getString("token", ""); } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public void setToken(String t) {
            try {
                android.content.SharedPreferences.Editor ed = prefs().edit();
                if (t == null || t.length() == 0) ed.remove("token");
                else ed.putString("token", t);
                ed.apply();
            } catch (Exception e) { Log.w("NativeIO", "setToken 失败", e); }
        }

        /**
         * 开始写一个导出文件。之后用 exportAppend() 一段段补，最后 exportEnd() 收尾。
         * 这样 JS 端可以「读一条素材 → 写一条 → 释放」，内存峰值等于单条素材，
         * 不再需要把 170MB 全部拼成一个字符串（那样必崩）。
         */
        @JavascriptInterface
        public synchronized boolean exportBegin(String filename) {
            try {
                exportAbort();
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename);
                    cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json");
                    exportUri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (exportUri == null) return false;
                    exportOs = getContentResolver().openOutputStream(exportUri);
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) dir.mkdirs();
                    exportOs = new java.io.FileOutputStream(new File(dir, filename));
                }
                return exportOs != null;
            } catch (Exception e) {
                Log.w("NativeIO", "exportBegin 失败", e);
                exportAbort();
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean exportAppend(String chunk) {
            if (exportOs == null) return false;
            try {
                exportOs.write(chunk.getBytes("UTF-8"));
                return true;
            } catch (Exception e) {
                Log.w("NativeIO", "exportAppend 失败", e);
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean exportEnd() {
            try {
                if (exportOs != null) { exportOs.flush(); exportOs.close(); }
                exportOs = null;
                exportUri = null;
                return true;
            } catch (Exception e) {
                Log.w("NativeIO", "exportEnd 失败", e);
                exportOs = null;
                exportUri = null;
                return false;
            }
        }

        @JavascriptInterface
        public synchronized void exportAbort() {
            try { if (exportOs != null) exportOs.close(); } catch (Exception ignored) {}
            exportOs = null;
            exportUri = null;
        }

        @JavascriptInterface
        public boolean saveExport(String json, String filename) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename);
                    cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json");
                    Uri uri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return false;
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(json.getBytes("UTF-8"));
                    os.flush();
                    os.close();
                    toastIt("已保存到 Download/" + filename);
                    return true;
                }
                File dir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, filename);
                java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                fos.write(json.getBytes("UTF-8"));
                fos.flush();
                fos.close();
                toastIt("已保存到 " + f.getAbsolutePath());
                return true;
            } catch (Exception e) {
                Log.w("NativeIO", "saveExport 失败", e);
                toastIt("保存失败：" + e.getMessage());
                return false;
            }
        }

        /**
         * v0.9.36：把一段文本（整本网页 html、备份 json）写进手机 Download。
         * 以前「生成整本网页」是 window.open 开新窗口，手机 WebView 一律拦截弹窗，
         * 用户只看到一句「弹窗被拦」。改成落文件，文件管理器里能直接找到、用浏览器打开。
         */
        @JavascriptInterface
        public boolean saveText(String text, String filename, String mime) {
            String m = (mime == null || mime.length() == 0) ? "text/plain" : mime;
            byte[] data;
            try { data = (text == null ? "" : text).getBytes("UTF-8"); }
            catch (Exception e) { data = new byte[0]; }
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename);
                    cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, m);
                    Uri uri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return false;
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(data);
                    os.flush();
                    os.close();
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) dir.mkdirs();
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(new File(dir, filename));
                    fos.write(data);
                    fos.flush();
                    fos.close();
                }
                toastIt("已保存到 Download/" + filename);
                return true;
            } catch (Exception e) {
                Log.w("NativeIO", "saveText 失败", e);
                toastIt("保存失败：" + e.getMessage());
                return false;
            }
        }

        /** 把档案目录里的导出文件（exports/xxx.docx）复制到手机 Download，文件管理器能找到 */
        @JavascriptInterface
        public boolean copyToDownload(String relPath, String filename, String mime, String token) {
            File src = resolveUserFile(token, relPath);
            if (src == null) return false;
            if (!src.isFile()) { toastIt("找不到导出文件"); return false; }
            return writeToDownloads(src, filename, mime) != null;
        }

        /** 复制到 Download 再弹出系统分享，发给另一台手机/电脑 */
        @JavascriptInterface
        public boolean shareFile(String relPath, String filename, String mime, String token) {
            File src = resolveUserFile(token, relPath);
            if (src == null) return false;
            if (!src.isFile()) { toastIt("找不到导出文件"); return false; }
            Uri uri = writeToDownloads(src, filename, mime);
            if (uri == null) return false;
            return shareUri(uri, mime);
        }

        /** 整库备份 JSON：写进 Download 再分享 */
        @JavascriptInterface
        public boolean shareText(String json, String filename) {
            try {
                File tmp = new File(getCacheDir(), filename);
                java.io.FileOutputStream fos = new java.io.FileOutputStream(tmp);
                fos.write(json.getBytes("UTF-8"));
                fos.flush();
                fos.close();
                Uri uri = writeToDownloads(tmp, filename, "application/json");
                if (uri == null) return false;
                return shareUri(uri, "application/json");
            } catch (Exception e) {
                toastIt("分享失败：" + e.getMessage());
                return false;
            }
        }

        /** 系统打印：手机上没有 Chrome 也能「保存为 PDF」 */
        @JavascriptInterface
        public void printHtml(final String html, final String jobName) {
            final String h = html == null ? "" : html;
            final String job = (jobName == null || jobName.length() == 0) ? "岁月记录助手" : jobName;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        final WebView pv = new WebView(MainActivity.this);
                        pv.getSettings().setJavaScriptEnabled(false);
                        pv.setWebViewClient(new WebViewClient() {
                            @Override
                            public void onPageFinished(WebView view, String url) {
                                try {
                                    android.print.PrintManager pm = (android.print.PrintManager)
                                            getSystemService(Context.PRINT_SERVICE);
                                    android.print.PrintDocumentAdapter ad =
                                            view.createPrintDocumentAdapter(job);
                                    android.print.PrintAttributes.Builder b =
                                            new android.print.PrintAttributes.Builder();
                                    b.setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4);
                                    pm.print(job, ad, b.build());
                                } catch (Exception e) {
                                    toastIt("打印失败：" + e.getMessage());
                                }
                            }
                        });
                        pv.loadDataWithBaseURL("file:///android_asset/web/", h, "text/html", "utf-8", null);
                    } catch (Exception e) {
                        toastIt("打印失败：" + e.getMessage());
                    }
                }
            });
        }

        private File resolveUserFile(String token, String relPath) {
            Auth.User u = auth == null ? null : auth.verify(token);
            if (u == null) { toastIt("登录已过期，重新登录再试"); return null; }
            String rel = String.valueOf(relPath == null ? "" : relPath).replace('\\', '/');
            while (rel.startsWith("/")) rel = rel.substring(1);
            return new File(new File(new File(getFilesDir(), "users"), String.valueOf(u.uid)), "files/" + rel);
        }

        private Uri writeToDownloads(File src, String filename, String mime) {
            String m = (mime == null || mime.length() == 0) ? "application/octet-stream" : mime;
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename);
                    cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, m);
                    Uri uri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return null;
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    java.io.FileInputStream in = new java.io.FileInputStream(src);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    in.close();
                    os.flush();
                    os.close();
                    toastIt("已保存到 Download/" + filename);
                    return uri;
                }
                File dir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, filename);
                java.io.FileInputStream in = new java.io.FileInputStream(src);
                java.io.FileOutputStream out = new java.io.FileOutputStream(f);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
                out.close();
                toastIt("已保存到 " + f.getAbsolutePath());
                return Uri.fromFile(f);
            } catch (Exception e) {
                Log.w("NativeIO", "导出到 Download 失败", e);
                toastIt("保存失败：" + e.getMessage());
                return null;
            }
        }

        private boolean shareUri(Uri uri, String mime) {
            try {
                Intent it = new Intent(Intent.ACTION_SEND);
                it.setType(mime == null || mime.length() == 0 ? "*/*" : mime);
                it.putExtra(Intent.EXTRA_STREAM, uri);
                it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(it, "分享到"));
                return true;
            } catch (Exception e) {
                toastIt("这台手机没有可用的分享方式");
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                // 多选时每张都放在 ClipData 里；单选（或个别 ROM）只给 getData()
                ClipData cd = data.getClipData();
                if (cd != null && cd.getItemCount() > 0) {
                    List<Uri> got = new ArrayList<>();
                    for (int i = 0; i < cd.getItemCount(); i++) {
                        Uri u = cd.getItemAt(i).getUri();
                        if (u != null) got.add(u);
                    }
                    if (!got.isEmpty()) uris = got.toArray(new Uri[0]);
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(uris);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (tts != null && tts.isPlaying()) {
                tts.stop();
                return true;
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    /* ---------------- 权限 ---------------- */

    private void requestPerms() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

        // 麦克风单独一批。
        // 以前和存储权限混在一起请求，只要批次里有一个权限是 Manifest 没声明的
        // （比如 Android 11 上已废弃的 WRITE_EXTERNAL_STORAGE），部分 ROM 会把
        // 整批请求判成失败，麦克风那道系统弹窗从来没出现过——用户看到的就是
        // 「我明明开了权限，App 还说没权限」。分开请求，麦克风这道一定弹。
        if (!hasPerm(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }

        List<String> need = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 33) {
            addPerm(need, Manifest.permission.READ_MEDIA_IMAGES);
            addPerm(need, Manifest.permission.READ_MEDIA_VIDEO);
            addPerm(need, Manifest.permission.READ_MEDIA_AUDIO);
        } else {
            addPerm(need, Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        // Android 9 及以下写公共目录（存到相册 / 导出进 Download）需要运行时授权；
        // 10+ 走 MediaStore 免授权，Manifest 里这条也限了 maxSdkVersion=28
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            addPerm(need, Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_PERM);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_MIC) {
            boolean ok = hasPerm(Manifest.permission.RECORD_AUDIO);
            Log.i(TAG, "麦克风权限结果：" + ok);
            callJsMic(ok ? "granted" : "denied");
            if (!ok) {
                toastIt("麦克风被系统挡住了。去「设置 → 应用 → 岁月记录助手 → 权限」改成「仅使用期间允许」");
            }
        }
    }

    private void addPerm(List<String> list, String p) {
        if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) list.add(p);
    }

    /** 系统权限是否真的拿到了（WebView 授权前先查这道） */
    private boolean hasPerm(String p) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    private void toastIt(String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                android.widget.Toast.makeText(MainActivity.this, msg,
                        android.widget.Toast.LENGTH_LONG).show();
            }
        });
    }

    /* ---------------- 朗读桥 ---------------- */

    public class TtsBridge {

        @JavascriptInterface
        public boolean ready() {
            return tts != null && tts.status().indexOf("\"ready\":true") >= 0;
        }

        @JavascriptInterface
        public String status() {
            return tts == null ? Json.err("还没初始化") : tts.status();
        }

        @JavascriptInterface
        public String engines() {
            return tts == null ? Json.err("还没初始化") : tts.engines();
        }

        @JavascriptInterface
        public String voices() {
            return tts == null ? Json.err("还没初始化") : tts.voices();
        }

        /** itemsJson 是句子数组；朗读时回调 window.TTS.onSeg(i)，读完 onEnd() */
        @JavascriptInterface
        public String speak(String itemsJson, float rate) {
            return tts == null ? Json.err("还没初始化") : tts.speak(itemsJson, rate);
        }

        @JavascriptInterface
        public void stop() {
            if (tts != null) tts.stop();
        }

        @JavascriptInterface
        public boolean speaking() {
            return tts != null && tts.isPlaying();
        }

        /** 换一个朗读引擎（某些机型默认引擎读不出中文） */
        @JavascriptInterface
        public void useEngine(String pkg) {
            if (tts != null) tts.initWithEngine(pkg == null || pkg.length() == 0 ? null : pkg);
        }
    }

    /* ---------------- 生命周期 ---------------- */

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (tts != null) tts.stop();
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        try {
            if (mic.isRunning()) mic.stop();   // 退出时把正在录的那段落成文件，别丢
            if (tts != null) tts.release();
            if (server != null) server.stop();
            if (db != null) db.close();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
