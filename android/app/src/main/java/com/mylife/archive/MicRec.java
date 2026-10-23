package com.mylife.archive;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.AudioDeviceInfo;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;

/**
 * 原生录音兜底（v0.3.3 新增）。
 *
 * 为什么还要一套原生录音？
 *   WebView 里的 navigator.mediaDevices.getUserMedia 在国产 ROM 上极不稳定：
 *   系统权限明明给的是「仅使用期间允许」，WebView 那一层仍然可能返回
 *   NotAllowedError / NotFoundError / NotReadableError，界面上就变成了
 *   「没有拿到麦克风权限」——用户在设置里翻来覆去开权限也没用。
 *
 * 这里绕开 WebView，直接用 AudioRecord 录，写到用户自己的
 *   filesDir/users/&lt;uid&gt;/files/audio/xxx.wav
 * 这个位置和 API.file 的 kind=audio 完全一致，前端只要拿到相对路径
 *   audio/xxx.wav
 * 就能当普通录音用（/files/audio/xxx.wav 可回放，DB 里存的也是它）。
 *
 * 录音格式：单声道 16bit PCM，优先 16kHz（ASR 最省事），不支持退 44.1kHz。
 */
public class MicRec {

    private static final String TAG = "MicRec";

    private AudioRecord ar;
    private Thread th;
    private final Object ioLock = new Object();   // 只有读线程和 stop 会碰文件，单独一把锁，别和 synchronized(this) 混
    private volatile boolean running;
    private volatile double peak;
    private volatile long startedAt;
    private volatile long pcmBytes;
    private File out;
    private RandomAccessFile raf;
    private int rate = 16000;
    private int bufferSize = 4096;

    /* ---------------- 对外能力 ---------------- */

    /** 是否正在录 */
    public boolean isRunning() {
        return running;
    }

    /** 启动录音。name 只允许字母数字._-；返回 "ok" 或 "err:原因" */
    public synchronized String start(Context ctx, long uid, String name) {
        if (running) return "err:已经在录了";
        try {
            if (!openRecorder()) {
                return "err:这台手机没给录音通道（AudioRecord 初始化失败）";
            }

            File dir = new File(new File(new File(ctx.getFilesDir(), "users"),
                    String.valueOf(uid)), "files/audio");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            String safeName = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "");
            if (safeName.length() == 0) safeName = "mic-" + System.currentTimeMillis() + ".wav";
            if (!safeName.toLowerCase().endsWith(".wav")) safeName = safeName + ".wav";
            out = new File(dir, safeName);

            raf = new RandomAccessFile(out, "rw");
            raf.setLength(0);
            raf.write(new byte[44]);      // 44 字节 WAV 头先占位，停下时回填真实长度

            peak = 0;
            pcmBytes = 0;
            startedAt = System.currentTimeMillis();
            running = true;
            ar.startRecording();

            th = new Thread(new Runnable() {
                @Override
                public void run() {
                    readLoop();
                }
            }, "mic-rec");
            th.start();
            return "ok";
        } catch (SecurityException se) {
            Log.w(TAG, "没有录音权限", se);
            cleanup();
            return "err:系统没给录音权限";
        } catch (Throwable t) {
            Log.w(TAG, "启动录音失败", t);
            cleanup();
            return "err:" + t.getClass().getSimpleName() + (t.getMessage() == null ? "" : " " + t.getMessage());
        }
    }

    /** 停止并落成 WAV。返回 JSON：{ok:true,path,seconds,peak,bytes} 或 {ok:false,err} */
    public synchronized String stop() {
        if (!running) return "{\"ok\":false,\"err\":\"没在录\"}";
        running = false;
        try {
            ar.stop();
        } catch (Throwable ignored) {
        }
        try {
            if (th != null) th.join(2000);
        } catch (InterruptedException ignored) {
        }
        synchronized (ioLock) {
            try {
                if (raf != null) raf.close();
            } catch (Throwable ignored) {
            }
            raf = null;
        }
        try {
            if (ar != null) ar.release();
        } catch (Throwable ignored) {
        }
        ar = null;
        th = null;

        double sec = pcmBytes / (rate * 2.0);
        try {
            if (out != null && out.isFile() && pcmBytes > 0) {
                writeWavHeader(out, rate);
            }
            JSONObject r = new JSONObject();
            r.put("ok", out != null && out.isFile() && pcmBytes > 0);
            r.put("path", out == null ? "" : "audio/" + out.getName());
            r.put("seconds", Math.round(sec));
            r.put("peak", Math.round(peak * 1000) / 1000.0);
            r.put("bytes", out == null ? 0 : out.length());
            r.put("rate", rate);
            if (!r.optBoolean("ok")) r.put("err", "一个字节都没录到");
            return r.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + esc(String.valueOf(t.getMessage())) + "\"}";
        }
    }

    /** 放弃这一段（删文件） */
    public synchronized String cancel() {
        if (running) {
            running = false;
            try {
                ar.stop();
            } catch (Throwable ignored) {
            }
            try {
                if (th != null) th.join(1000);
            } catch (InterruptedException ignored) {
            }
        }
        cleanup();
        if (out != null && out.isFile()) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
        return "ok";
    }

    /** 当前峰值 0~1（前端拿去算 dB 显示音量） */
    public double level() {
        return peak;
    }

    public long seconds() {
        if (!running || startedAt == 0) return 0;
        return (System.currentTimeMillis() - startedAt) / 1000;
    }

    /* ---------------- 内部实现 ---------------- */

    private boolean openRecorder() {
        int[] rates = new int[]{16000, 44100};
        for (int r : rates) {
            int min = AudioRecord.getMinBufferSize(r,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) {
                Log.w(TAG, r + "Hz 的 minBufferSize 不可用：" + min);
                continue;
            }
            AudioRecord cand = null;
            try {
                cand = new AudioRecord(MediaRecorder.AudioSource.MIC, r,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min * 4, 4096));
            } catch (Throwable t) {
                Log.w(TAG, "AudioRecord " + r + "Hz 建不起来", t);
            }
            if (cand != null && cand.getState() == AudioRecord.STATE_INITIALIZED) {
                ar = cand;
                rate = r;
                bufferSize = Math.max(min * 2, 3200);
                Log.i(TAG, "录音通道就绪：" + r + "Hz buffer=" + bufferSize);
                return true;
            }
            if (cand != null) {
                try {
                    cand.release();
                } catch (Throwable ignored) {
                }
            }
        }
        return false;
    }

    private void readLoop() {
        byte[] buf = new byte[bufferSize];
        while (running) {
            int n;
            try {
                n = ar.read(buf, 0, buf.length);
            } catch (Throwable t) {
                Log.w(TAG, "读麦克风失败", t);
                break;
            }
            if (n <= 0) continue;
            // 峰值：16bit 小端样本，取绝对值最大
            for (int i = 0; i + 1 < n; i += 2) {
                int v = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8));
                double a = (v < 0 ? -v : v) / 32768.0;
                if (a > peak) peak = a;
            }
            synchronized (ioLock) {
                if (raf != null) {
                    try {
                        raf.write(buf, 0, n);
                        pcmBytes += n;
                    } catch (Throwable t) {
                        Log.w(TAG, "写文件失败", t);
                        break;
                    }
                }
            }
        }
    }

    private void cleanup() {
        running = false;
        synchronized (ioLock) {
            try {
                if (raf != null) raf.close();
            } catch (Throwable ignored) {
            }
            raf = null;
        }
        try {
            if (ar != null) ar.release();
        } catch (Throwable ignored) {
        }
        ar = null;
        th = null;
    }

    /** 回填 WAV 头（44 字节标准 PCM） */
    private static void writeWavHeader(File f, int rate) throws Exception {
        RandomAccessFile r = new RandomAccessFile(f, "rw");
        long dataLen = r.length() - 44;
        byte[] h = new byte[44];
        putStr(h, 0, "RIFF");
        putInt(h, 4, (int) (36 + dataLen));
        putStr(h, 8, "WAVE");
        putStr(h, 12, "fmt ");
        putInt(h, 16, 16);
        putShort(h, 20, 1);                 // PCM
        putShort(h, 22, 1);                 // 单声道
        putInt(h, 24, rate);
        putInt(h, 28, rate * 2);            // byte rate
        putShort(h, 32, 2);                 // block align
        putShort(h, 34, 16);                // bits
        putStr(h, 36, "data");
        putInt(h, 40, (int) dataLen);
        r.seek(0);
        r.write(h);
        r.close();
    }

    private static void putStr(byte[] b, int o, String s) {
        for (int i = 0; i < s.length(); i++) b[o + i] = (byte) s.charAt(i);
    }

    private static void putInt(byte[] b, int o, int v) {
        b[o] = (byte) (v & 0xff);
        b[o + 1] = (byte) ((v >> 8) & 0xff);
        b[o + 2] = (byte) ((v >> 16) & 0xff);
        b[o + 3] = (byte) ((v >> 24) & 0xff);
    }

    private static void putShort(byte[] b, int o, int v) {
        b[o] = (byte) (v & 0xff);
        b[o + 1] = (byte) ((v >> 8) & 0xff);
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }

    /* ---------------- 诊断 ---------------- */

    /**
     * 麦克风体检：这一份 JSON 直接显示在「设置 → 麦克风诊断」里，
     * 出问题时用户截图发过来，就不用再猜了。
     */
    public static String info(Context ctx, boolean permGranted) {
        try {
            JSONObject o = new JSONObject();
            o.put("perm", permGranted ? "granted" : "denied");
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("device", android.os.Build.BRAND + " " + android.os.Build.MODEL);
            o.put("android", android.os.Build.VERSION.RELEASE);

            // 各种采样率下 AudioRecord 能不能建起来（最能说明"系统给不给录音通道"）
            JSONObject rates = new JSONObject();
            for (int r : new int[]{16000, 44100, 48000}) {
                int min = AudioRecord.getMinBufferSize(r,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                String st = "minBuffer=" + min;
                if (min > 0) {
                    AudioRecord t = null;
                    try {
                        t = new AudioRecord(MediaRecorder.AudioSource.MIC, r,
                                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                                Math.max(min * 2, 4096));
                        st += ", state=" + (t.getState() == AudioRecord.STATE_INITIALIZED ? "OK" : "初始化失败");
                    } catch (Throwable e) {
                        st += ", 异常=" + e.getClass().getSimpleName();
                    } finally {
                        if (t != null) {
                            try {
                                t.release();
                            } catch (Throwable ignored) {
                            }
                        }
                    }
                }
                rates.put(String.valueOf(r), st);
            }
            o.put("record", rates);

            // 系统看得见的输入设备（空 = 系统层面就没有麦克风给这个 App）
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                AudioDeviceInfo[] ins = am.getDevices(AudioManager.GET_DEVICES_INPUTS);
                org.json.JSONArray arr = new org.json.JSONArray();
                for (AudioDeviceInfo d : ins) {
                    arr.put(d.getType() + ":" + d.getProductName() + ":" + d.getSampleRates().length + "rate");
                }
                o.put("inputs", arr);
                o.put("inputs_n", ins.length);
            }
            return o.toString();
        } catch (Throwable t) {
            return "{\"err\":\"" + esc(String.valueOf(t.getMessage())) + "\"}";
        }
    }
}
