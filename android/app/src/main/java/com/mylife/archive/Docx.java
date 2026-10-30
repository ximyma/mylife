package com.mylife.archive;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 导入 Word（.docx）：把文档读回成档案草稿。
 *
 * 与 Node 端 parseDocx 同一套规则（v0.9.22 平移）：
 *   · 认两种文档——本程序导出的 Word（「档案信息」「目录」页 + 「第 N 章」），
 *     和别人随便写的 Word（靠「标题 1」样式分章，没样式就整篇当一章）。
 *   · 图片走 word/_rels 的 rId 关系表找包内路径，解码后压到长边 1600px / JPEG q82
 *     再转 base64（桌面版直接给原图；安卓内存金贵，不压会 OOM）。
 *   · docx 本体是 zip，用 java.util.zip 解，不用桌面那套手写解包。
 *
 * 返回 { ok, format:'mylife-docx', archive, chapters, stats, warnings, suggest_name }，
 * 前端 showWordPreview / DB.docxToPack 直接吃。
 */
public class Docx {

    private static final String TAG = "Docx";
    private static final int MAX_IMGS = 40;
    private static final int MAX_IMG_BYTES = 8 * 1024 * 1024;
    private static final int MAX_SIDE = 1600;

    private Docx() {}

    public static String parse(String payload) {
        try {
            JSONObject in = Json.obj(payload);
            String b64 = Json.sv(in, "base64");
            int comma = b64.indexOf(',');
            if (b64.startsWith("data:") && comma > 0) b64 = b64.substring(comma + 1);
            if (b64.length() == 0) return err("没有收到文件内容，可能选文件时被取消了");
            byte[] buf;
            try {
                buf = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            } catch (Exception e) {
                return err("文件内容读不出来");
            }
            if (buf.length == 0) return err("文件是空的");
            if (buf.length > 80L * 1024 * 1024) {
                return err("这个 Word 超过 80MB，先用 Word 压一下里面的图片再导");
            }
            JSONObject r = parseDocx(buf, Json.sv(in, "name"));
            r.put("ok", true);
            return r.toString();
        } catch (Exception e) {
            // 读不出来是常事（选错文件、加密文档、扫描件），如实说，不抛给前端当异常
            Log.w(TAG, "docx 解析失败", e);
            return err(e.getMessage() == null ? "这个 Word 读不出来" : e.getMessage());
        }
    }

    private static String err(String m) {
        try {
            return new JSONObject().put("ok", false).put("message", m).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"message\":\"这个 Word 读不出来\"}";
        }
    }

    /* ---------------- zip 解包 ---------------- */

    private static HashMap<String, byte[]> unzip(byte[] buf) throws Exception {
        HashMap<String, byte[]> out = new HashMap<String, byte[]>();
        ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(buf));
        try {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                String name = e.getName();
                if (name.startsWith("/") || name.contains("..")) continue;
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] tmp = new byte[8192];
                int n;
                while ((n = zis.read(tmp)) > 0) bo.write(tmp, 0, n);
                out.put(name, bo.toByteArray());
                zis.closeEntry();
            }
        } finally {
            try { zis.close(); } catch (Exception ignored) {}
        }
        return out;
    }

    /* ---------------- XML 小件 ---------------- */

    private static String xmlUnescape(String s) {
        StringBuffer sb = new StringBuffer();
        Matcher m = Pattern.compile("&#x([0-9a-fA-F]+);|&#(\\d+);").matcher(s);
        while (m.find()) {
            String rep = "";
            try {
                int cp = m.group(1) != null
                        ? Integer.parseInt(m.group(1), 16)
                        : Integer.parseInt(m.group(2));
                rep = new String(Character.toChars(cp));
            } catch (Exception ignored) {}
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        return sb.toString()
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                .replace("&apos;", "'").replace("&amp;", "&");
    }

    private static final Pattern P_WT = Pattern.compile("<w:t(?:\\s[^>]*)?>[\\s\\S]*?</w:t>");
    private static final Pattern P_WT_OPEN = Pattern.compile("^<w:t(?:\\s[^>]*)?>");
    private static final Pattern P_WT_CLOSE = Pattern.compile("</w:t>\\s*$");

    /** 一个 <w:p> 里的可见文字：Word 会把一句话切成很多 run，都拼起来 */
    private static String paraText(String chunk) {
        Matcher m = P_WT.matcher(chunk);
        StringBuilder s = new StringBuilder();
        while (m.find()) {
            String t = P_WT_OPEN.matcher(m.group()).replaceFirst("");
            t = P_WT_CLOSE.matcher(t).replaceFirst("");
            s.append(xmlUnescape(t));
        }
        return s.toString().replace("\u00a0", " ").trim();
    }

    private static int headLevel(String style) {
        if (style == null || style.length() == 0) return 0;
        Matcher m = Pattern.compile("^(?:heading|Heading|HEADING)\\s*([1-6])$").matcher(style);
        if (m.find()) return Integer.parseInt(m.group(1));
        m = Pattern.compile("^标题\\s*([1-6])$").matcher(style);
        if (m.find()) return Integer.parseInt(m.group(1));
        m = Pattern.compile("^([1-6])$").matcher(style);
        if (m.find()) return Integer.parseInt(m.group(1));
        return 0;
    }

    /** 「1921 · 江西石城 · 父亲李前裕」这种图注 */
    private static boolean looksLikeCaption(String t) {
        return t != null && t.length() <= 80 && t.matches("^[0-9]{4}.*") && t.indexOf('·') > 0;
    }

    /* ---------------- 主解析 ---------------- */

    private static JSONObject parseDocx(byte[] buf, String fileName) throws Exception {
        HashMap<String, byte[]> files = unzip(buf);
        byte[] docBuf = files.get("word/document.xml");
        if (docBuf == null) {
            throw new Exception("这个 .docx 里没有正文（可能不是 Word 文档，或者是加密的）。老的 .doc 请先用 Word/WPS 另存为 .docx");
        }
        String xml = new String(docBuf, "UTF-8");

        // 关系表：rId -> 包内路径（图片靠它找）
        HashMap<String, String> rels = new HashMap<String, String>();
        byte[] relBuf = files.get("word/_rels/document.xml.rels");
        if (relBuf != null) {
            String s = new String(relBuf, "UTF-8");
            Matcher m = Pattern.compile("<Relationship\\b[^>]*>").matcher(s);
            while (m.find()) {
                String tag = m.group();
                String id = grp(tag, "Id=\"([^\"]+)\"");
                String tg = grp(tag, "Target=\"([^\"]+)\"");
                if (id == null || tg == null) continue;
                if (tg.matches("(?i)^https?:.*")) continue;      // 外链图片不取
                String t;
                if (tg.startsWith("/")) t = tg.substring(1);
                else if (tg.startsWith("word/")) t = tg;
                else t = "word/" + tg;
                rels.put(id, t);
            }
        }

        int bodyAt = xml.indexOf("<w:body>");
        String bodyXml = xml.substring(bodyAt < 0 ? 0 : bodyAt);
        String[] chunks = bodyXml.split("</w:p>");

        JSONArray items = new JSONArray();
        for (String c : chunks) {
            String st = grp(c, "<w:pStyle\\b[^>]*w:val=\"([^\"]+)\"");
            String text = paraText(c);
            JSONArray imgs = new JSONArray();
            Matcher m2 = Pattern.compile("r:embed=\"([^\"]+)\"").matcher(c);
            while (m2.find()) {
                String p = rels.get(m2.group(1));
                if (p != null && files.containsKey(p)
                        && p.matches("(?i).*\\.(jpe?g|png|gif|webp|bmp)$")) {
                    imgs.put(p);
                }
            }
            if (text.length() == 0 && imgs.length() == 0) continue;   // 空段落直接丢
            JSONObject it = new JSONObject();
            it.put("style", st == null ? "" : st);
            it.put("text", text);
            it.put("imgs", imgs);
            items.put(it);
        }

        JSONObject meta = new JSONObject();
        meta.put("subject_name", "");
        meta.put("archive_no", "");
        meta.put("birth_year", JSONObject.NULL);
        meta.put("years", "");
        meta.put("hometown", "");
        meta.put("intro", "");
        JSONArray chapters = new JSONArray();
        JSONArray warnings = new JSONArray();
        JSONArray headItems = new JSONArray();
        JSONObject cur = null;
        boolean skipping = false;    // 处在「档案信息」「目录」这种不算正文的块里
        int imgCount = 0;

        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            String style = Json.sv(it, "style");
            String text = Json.sv(it, "text");
            JSONArray imgs = it.optJSONArray("imgs");
            int lv = headLevel(style);

            if (lv == 1) {
                String t = text.replaceAll("[\\s　]+", " ").trim();
                if (t.matches("^(档案信息|目\\s*录)$")) { skipping = true; cur = null; continue; }
                skipping = false;
                String title = t.replaceFirst("^第\\s*[0-9一二三四五六七八九十百千]+\\s*章\\s*", "");
                String years = "";
                // 第三方文档的「第一章 出生（1921）」：把括注里的年份挪到章头
                Matcher my = Pattern.compile("[（(]\\s*([0-9]{4}(?:\\s*[-—–~至]\\s*[0-9]{4})?)\\s*[）)]\\s*$")
                        .matcher(title);
                if (my.find()) {
                    years = my.group(1);
                    title = title.substring(0, my.start()).trim();
                }
                cur = new JSONObject();
                cur.put("title", title.length() > 0 ? title : "第 " + (chapters.length() + 1) + " 章");
                cur.put("years", years);
                cur.put("stage", "");
                cur.put("quote", "");
                cur.put("blocks", new JSONArray());
                chapters.put(cur);
                continue;
            }
            if (skipping) continue;
            if (cur == null) { headItems.put(it); continue; }

            // 图片：单独成块，紧跟的那行「年 · 地点 · 说明」当图注
            if (imgs != null && imgs.length() > 0) {
                String cap = "";
                if (i + 1 < items.length()) {
                    JSONObject nx = items.getJSONObject(i + 1);
                    JSONArray nxImgs = nx.optJSONArray("imgs");
                    if ((nxImgs == null || nxImgs.length() == 0) && looksLikeCaption(Json.sv(nx, "text"))) {
                        cap = Json.sv(nx, "text");
                        i++;
                    }
                }
                for (int k = 0; k < imgs.length(); k++) {
                    if (imgCount >= MAX_IMGS) {
                        if (!hasWarning(warnings, "图片太多")) {
                            warnings.put("图片太多，只导入了前 " + MAX_IMGS + " 张");
                        }
                        continue;
                    }
                    String p = imgs.optString(k, "");
                    byte[] bytes = files.get(p);
                    if (bytes == null || bytes.length > MAX_IMG_BYTES) continue;
                    String b64 = shrinkImage(bytes);
                    if (b64 == null) continue;
                    imgCount++;
                    String name = p;
                    int slash = name.lastIndexOf('/');
                    if (slash >= 0) name = name.substring(slash + 1);
                    JSONObject block = new JSONObject();
                    block.put("type", "photo");
                    block.put("name", name);
                    block.put("caption", cap);
                    block.put("b64", b64);
                    cur.getJSONArray("blocks").put(block);
                }
                continue;
            }

            String t = text;
            if (t.length() == 0) continue;

            // 章头下一行「1921 · 幼年」
            JSONArray blocks = cur.getJSONArray("blocks");
            if (Json.sv(cur, "years").length() == 0 && blocks.length() == 0
                    && t.matches("^[0-9]{4}(?:\\s*[-—–~至]\\s*[0-9]{0,4})?\\s*(?:·.*)?$")) {
                String[] parts = t.split("·");
                cur.put("years", parts.length > 0 ? parts[0].trim() : "");
                cur.put("stage", parts.length > 1 ? parts[1].trim() : "");
                continue;
            }
            // 「……」：第一个当章引语，其余当引文块
            if (t.startsWith("「") && t.endsWith("」") && t.length() >= 2) {
                String inner = t.substring(1, t.length() - 1).trim();
                if (Json.sv(cur, "quote").length() == 0 && blocks.length() == 0) {
                    cur.put("quote", inner);
                } else {
                    JSONObject q = new JSONObject();
                    q.put("type", "quote");
                    q.put("text", inner);
                    blocks.put(q);
                }
                continue;
            }
            JSONObject b = new JSONObject();
            b.put("type", "text");
            b.put("text", t);
            blocks.put(b);
        }

        /* 章之前的内容 = 封面 + 档案信息。只有在真有章节时才当封面读 */
        if (chapters.length() > 0) {
            for (int i = 0; i < headItems.length(); i++) {
                String t = Json.sv(headItems.getJSONObject(i), "text");
                if (t.length() == 0) continue;
                Matcher mno = Pattern.compile("^档案编号\\s*[：:]\\s*(.+)$").matcher(t);
                if (mno.find()) { meta.put("archive_no", mno.group(1).trim()); continue; }
                if (t.matches("^(篇幅|整理日期|共\\s*\\d+\\s*章)\\s*[：:].*$")) continue;
                Matcher my = Pattern.compile("^([0-9]{4}(?:\\s*[-—–~至]\\s*[0-9]{0,4})?)\\s*(?:·\\s*(.*))?$").matcher(t);
                if (my.find() && Json.sv(meta, "years").length() == 0) {
                    meta.put("years", my.group(1));
                    meta.put("hometown", my.group(2) == null ? "" : my.group(2).trim());
                    continue;
                }
                if (t.startsWith("「") && t.endsWith("」") && Json.sv(meta, "intro").length() == 0) {
                    meta.put("intro", t.substring(1, t.length() - 1).trim());
                    continue;
                }
                if (Json.sv(meta, "archive_no").length() == 0 && t.matches("^[A-Za-z]{1,8}[-0-9]{2,}$")) {
                    meta.put("archive_no", t);
                    continue;
                }
                // 人名：短、且不像句子（不带句读）
                if (Json.sv(meta, "subject_name").length() == 0 && t.length() <= 24
                        && !t.matches(".*[。！？，、；：].*")) {
                    meta.put("subject_name", t);
                    continue;
                }
            }
        }
        String years = Json.sv(meta, "years");
        if (years.length() > 0) {
            try { meta.put("birth_year", Integer.parseInt(years.substring(0, 4))); }
            catch (Exception ignored) {}
        }

        /* 一章都没认出来：整篇当一章，别让用户白选一次文件 */
        JSONObject stat = new JSONObject();
        stat.put("chapters", 0);
        stat.put("paragraphs", 0);
        stat.put("words", 0);
        stat.put("photos", 0);
        if (chapters.length() == 0) {
            JSONArray all = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String t = Json.sv(it, "text");
                if (t.length() > 0) {
                    JSONObject b = new JSONObject();
                    b.put("type", "text");
                    b.put("text", t);
                    all.put(b);
                }
                JSONArray imgs = it.optJSONArray("imgs");
                if (imgs == null) continue;
                for (int k = 0; k < imgs.length(); k++) {
                    if (imgCount >= MAX_IMGS) break;
                    String p = imgs.optString(k, "");
                    byte[] bytes = files.get(p);
                    if (bytes == null || bytes.length > MAX_IMG_BYTES) continue;
                    String b64 = shrinkImage(bytes);
                    if (b64 == null) continue;
                    imgCount++;
                    String name = p;
                    int slash = name.lastIndexOf('/');
                    if (slash >= 0) name = name.substring(slash + 1);
                    JSONObject b = new JSONObject();
                    b.put("type", "photo");
                    b.put("name", name);
                    b.put("caption", "");
                    b.put("b64", b64);
                    all.put(b);
                }
            }
            if (all.length() > 0) {
                JSONObject c = new JSONObject();
                c.put("title", Json.sv(meta, "subject_name").length() > 0
                        ? Json.sv(meta, "subject_name") : "全文");
                c.put("years", "");
                c.put("stage", "");
                c.put("quote", "");
                c.put("blocks", all);
                chapters.put(c);
                warnings.put("没找到章节标题，把整篇当成一章导入了");
            } else {
                throw new Exception("这个 Word 里没读到文字（可能是扫描件或纯图片）");
            }
        }

        int nCh = 0, nPara = 0, nWords = 0, nPhotos = 0;
        for (int i = 0; i < chapters.length(); i++) {
            nCh++;
            JSONArray blocks = chapters.getJSONObject(i).getJSONArray("blocks");
            for (int k = 0; k < blocks.length(); k++) {
                JSONObject b = blocks.getJSONObject(k);
                if ("photo".equals(Json.sv(b, "type"))) nPhotos++;
                else {
                    nPara++;
                    nWords += Json.sv(b, "text").length();
                }
            }
        }
        stat.put("chapters", nCh);
        stat.put("paragraphs", nPara);
        stat.put("words", nWords);
        stat.put("photos", nPhotos);

        JSONObject r = new JSONObject();
        r.put("format", "mylife-docx");
        r.put("archive", meta);
        r.put("chapters", chapters);
        r.put("stats", stat);
        r.put("warnings", warnings);
        String suggest = Json.sv(meta, "subject_name");
        if (suggest.length() == 0 && fileName != null && fileName.length() > 0) {
            suggest = fileName.replaceFirst("\\.[a-zA-Z0-9]+$", "").replaceFirst("[-_]\\d{6,8}$", "");
        }
        r.put("suggest_name", suggest);
        return r;
    }

    private static boolean hasWarning(JSONArray arr, String prefix) {
        for (int i = 0; i < arr.length(); i++) {
            if (arr.optString(i, "").startsWith(prefix)) return true;
        }
        return false;
    }

    private static String grp(String s, String re) {
        Matcher m = Pattern.compile(re).matcher(s);
        return m.find() ? m.group(1) : null;
    }

    /**
     * 图片压到长边 1600px / JPEG q82 再转 base64。
     * 桌面版给原图（8MB 封顶），安卓内存金贵：40 张 8MB 原图的 base64 能把堆撑爆。
     */
    private static String shrinkImage(byte[] bytes) {
        try {
            BitmapFactory.Options bo = new BitmapFactory.Options();
            bo.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bo);
            int w = bo.outWidth, h = bo.outHeight;
            if (w <= 0 || h <= 0) return null;
            int sample = 1;
            while (w / (sample * 2) >= MAX_SIDE / 2 && h / (sample * 2) >= MAX_SIDE / 2) sample *= 2;
            bo = new BitmapFactory.Options();
            bo.inSampleSize = sample;
            Bitmap bm = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bo);
            if (bm == null) return null;
            int sw = bm.getWidth(), sh = bm.getHeight();
            int longSide = Math.max(sw, sh);
            if (longSide > MAX_SIDE) {
                double scale = MAX_SIDE / (double) longSide;
                Bitmap small = Bitmap.createScaledBitmap(bm,
                        Math.max(1, (int) (sw * scale)), Math.max(1, (int) (sh * scale)), true);
                if (small != bm) bm.recycle();
                bm = small;
            }
            ByteArrayOutputStream jpg = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 82, jpg);
            bm.recycle();
            return android.util.Base64.encodeToString(jpg.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "图片压缩失败", e);
            return null;
        }
    }
}
