# -*- coding: utf-8 -*-
"""静态站发布包：给 index.html 里的资源引用注入版本戳，再打 zip。

为什么要这么做：
  阶跃星辰等静态托管会给 *.js / *.css 回 `cache-control: public, max-age=31536000, immutable`，
  而 index.html 是 no-cache。资源地址不变 → 浏览器一年内都吃旧缓存，怎么传新代码都看不到新界面。
  打包时把 app.js 改成 app.js?v=v0.9.42-202611021120，地址一变缓存自然失效。
  （index.html 自身 no-cache，每次都会重新取，所以能带动新地址。）

用法：
  python tools/pack-static.py                 # 版本取 app.js 的 APP_VERSION，戳取当前时间
  python tools/pack-static.py --stamp 手工A    # 自定义戳
"""
import argparse
import io
import os
import re
import sys
import time
import zipfile

SRC = r'D:\works\mylife-static'
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dist')

SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.playwright-cli', 'tmp', '.workbuddy',
             '.gradle', 'build', '_up'}
# 平台拒收的文件类型，链路已内嵌（wasm -> b64，schema -> schema.js）
SKIP_EXT = {'.wasm', '.sql'}
# 本机自用、不必上传的
SKIP_NAMES = {'启动静态站.bat', '_localserver.py'}

ASSET_RE = re.compile(r'(src|href)="([A-Za-z0-9_\-./]+\.(?:js|css))"')


def build_index(html, ver):
    """给本地 js/css 引用加 ?v=，已经是完整 URL 或带参数的不动"""
    count = [0]

    def repl(m):
        attr, path = m.group(1), m.group(2)
        count[0] += 1
        return '%s="%s?v=%s"' % (attr, path, ver)

    out = ASSET_RE.sub(repl, html)
    return out, count[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--stamp', default=time.strftime('%Y%m%d%H%M'))
    args = ap.parse_args()

    src = args.src
    app_js = os.path.join(src, 'app.js')
    with io.open(app_js, encoding='utf-8') as f:
        head = f.read(200000)
    m = re.search(r"APP_VERSION = '([^']+)'", head)
    if not m:
        print('读不到 APP_VERSION，中止')
        return 1
    ver = '%s-%s' % (m.group(1), args.stamp)

    idx_path = os.path.join(src, 'index.html')
    with io.open(idx_path, encoding='utf-8') as f:
        html = f.read()
    new_html, n = build_index(html, ver)
    if n == 0:
        print('index.html 里没匹配到资源引用，检查正则')
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    name = '岁月记录助手-静态站-%s.zip' % ver
    out = os.path.join(OUT_DIR, name)

    files = 0
    skipped = []
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, names in os.walk(src):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fn in names:
                ext = os.path.splitext(fn)[1].lower()
                if ext in SKIP_EXT or fn in SKIP_NAMES:
                    skipped.append(fn)
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, src).replace('\\', '/')
                if rel == 'index.html':
                    zf.writestr(rel, new_html.encode('utf-8'))
                else:
                    zf.write(full, rel)
                files += 1

        zf.writestr('版本说明.txt', (
            '岁月记录助手 · 静态网站\n'
            '版本：%s\n'
            '打包时间：%s\n'
            '资源引用已带版本戳（?v=%s），上传后普通刷新即可看到新版，\n'
            '不用再担心平台给 js/css 打的一年强缓存。\n' % (m.group(1), time.strftime('%Y-%m-%d %H:%M'), ver)
        ))

    size = os.path.getsize(out) / 1048576
    print('版本戳：%s' % ver)
    print('改写资源引用：%d 处' % n)
    print('打包 %d 个文件，跳过 %s' % (files, skipped or '无'))
    print('产物：%s  (%.2f MB)' % (out, size))

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert 'index.html' in names, '根目录缺 index.html'
        inner = z.read('index.html').decode('utf-8')
        hits = inner.count('?v=' + ver)
        assert hits == n, 'zip 内 index.html 版本戳数量不对'
        print('校验：根目录 index.html ✓，内部版本戳 %d 处 ✓' % hits)
        if any(nm.endswith(('.wasm', '.sql')) for nm in names):
            print('警告：包内仍含 .wasm/.sql，平台可能拒收')
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
