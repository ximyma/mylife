# -*- coding: utf-8 -*-
"""代码备份包：全部源码 + EXE + APK，不含用户数据与临时目录。

版本号唯一来源：android/app/build.gradle 的 versionName（与 EXE/APK 命名一致）。
输出：dist/mylife-v<ver>-backup-YYYYMMDD.zip

用法： python tools/make-backup.py
"""
import io
import os
import re
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- 版本号：读 build.gradle，别在脚本里写死 ----
_gradle = io.open(os.path.join(ROOT, 'android', 'app', 'build.gradle'),
                  encoding='utf-8').read()
VER = (re.search(r'versionName\s+"([^"]+)"', _gradle) or [None, '0.0.0'])[1]
VCODE = (re.search(r'versionCode\s+(\d+)', _gradle) or [None, '?'])[1]

# ---- 里程碑标注 ----
if VER.startswith('0.4'):
    MILE = '里程碑 2'
elif VER.startswith('0.2'):
    MILE = '里程碑 1'
else:
    MILE = ''

DATE = time.strftime('%Y%m%d')
STAMP = time.strftime('%Y-%m-%d %H:%M')
OUT = os.path.join(ROOT, 'dist', 'mylife-v%s-backup-%s.zip' % (VER, DATE))

INCLUDE_DIRS = ['server', 'web', 'tools', 'test', 'docs']
INCLUDE_FILES = ['README.md', 'CHANGELOG.md', 'build-apk.bat', 'package.json']
ANDROID = os.path.join(ROOT, 'android')
EXE = os.path.join(ROOT, 'dist', 'MyLife-v%s-windows.exe' % VER)
EXE_FALLBACK = os.path.join(ROOT, 'dist', 'win', 'MyLife.exe')
APK = os.path.join(ROOT, 'dist', 'MyLife-v%s-android.apk' % VER)
APK_FALLBACK = os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')

SKIP_DIRS = {'node_modules', '.gradle', 'build', '.git', '__pycache__', 'dist', 'tmp', 'data'}


def git(*args):
    try:
        return subprocess.check_output(['git'] + list(args), cwd=ROOT,
                                       stderr=subprocess.DEVNULL).decode('utf-8').strip()
    except Exception:
        return ''


def pick(*paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


commit = git('rev-parse', '--short', 'HEAD')
branch = git('rev-parse', '--abbrev-ref', 'HEAD')
dirty = '（有未提交改动）' if git('status', '--porcelain') else ''

exe_path = pick(EXE, EXE_FALLBACK)
apk_path = pick(APK, APK_FALLBACK)
if not exe_path or not apk_path:
    print('缺少产物：exe=%s apk=%s' % (exe_path, apk_path))
    print('先跑 node tools/build-exe.js 与 build-apk.bat')
    sys.exit(1)

n = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    info = (
        '我的人生档案 · The Story of My Life\n'
        '================================================================\n'
        '版本      v%s%s\n' % (VER, ('（' + MILE + '）') if MILE else '') +
        '打包时间  %s\n' % STAMP +
        'git       %s @ %s%s\n' % (branch, commit or '(未初始化)', dirty) +
        '安卓      versionCode %s / versionName %s\n' % (VCODE, VER) +
        '\n'
        '内容清单\n'
        '----------------------------------------------------------------\n'
        '  source/                 全部源码与文档\n'
        '    server/               网页端宿主 + schema.sql\n'
        '    web/                  一套前端（两端共用）\n'
        '    android/app/src/      安卓宿主（Java + Manifest + assets）\n'
        '    android/*.gradle      构建配置\n'
        '    tools/                sync / build-exe / make-backup\n'
        '    test/                 8 个审计脚本，197 项\n'
        '    docs/                 升级方案与里程碑存档\n'
        '  MyLife-v%s.exe   Windows 单文件版（界面已内置）\n' % VER +
        '  MyLife-v%s.apk   安卓版（versionCode %s）\n' % (VER, VCODE) +
        '\n'
        '不含\n'
        '----------------------------------------------------------------\n'
        '  data/（用户档案、照片、录音）、dist/ 中间产物、node_modules、.gradle、build/。\n'
        '\n'
        '还原开发环境\n'
        '----------------------------------------------------------------\n'
        '  1. 装 Node 22+（用内置 node:sqlite，零 npm 依赖，不需要 npm install）\n'
        '  2. node server/server.js   →  http://127.0.0.1:4321\n'
        '  3. 出 EXE：node tools/build-exe.js\n'
        '  4. 出 APK：build-apk.bat（需 JDK 17 + Android SDK + Gradle 8.x）\n'
        '\n'
        '详细变更见 source/CHANGELOG.md；里程碑 2 的验收记录见 source/docs/MILESTONE-2.md。\n'
    )
    zf.writestr('BACKUP-INFO.txt', info)

    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS]
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                arc = 'source/' + os.path.relpath(fp, ROOT).replace('\\', '/')
                zf.write(fp, arc)
                n += 1

    # 安卓：源码树（含 assets 里的前端副本）+ 构建配置
    for dirpath, dirnames, filenames in os.walk(os.path.join(ANDROID, 'app', 'src')):
        dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arc = 'source/android/app/src/' + os.path.relpath(
                fp, os.path.join(ANDROID, 'app', 'src')).replace('\\', '/')
            zf.write(fp, arc)
            n += 1

    for fn in ['build.gradle', 'settings.gradle', 'gradle.properties']:
        fp = os.path.join(ANDROID, fn)
        if os.path.exists(fp):
            zf.write(fp, 'source/android/' + fn)
            n += 1
    fp = os.path.join(ANDROID, 'app', 'build.gradle')
    if os.path.exists(fp):
        zf.write(fp, 'source/android/app/build.gradle')
        n += 1
    for fn in os.listdir(os.path.join(ANDROID, 'app')):
        if fn.endswith('.pro'):
            zf.write(os.path.join(ANDROID, 'app', fn), 'source/android/app/' + fn)
            n += 1

    # 根文档
    for fn in INCLUDE_FILES:
        fp = os.path.join(ROOT, fn)
        if os.path.exists(fp):
            zf.write(fp, 'source/' + fn)
            n += 1

    # 产物（顶层，拿到就能用）
    zf.write(exe_path, 'MyLife-v%s.exe' % VER)
    n += 1
    zf.write(apk_path, 'MyLife-v%s.apk' % VER)
    n += 1

print('版本    v%s%s' % (VER, ('（' + MILE + '）') if MILE else ''))
print('文件数  %d' % n)
print('大小    %.1f MB' % (os.path.getsize(OUT) / 1048576.0))
print('位置    %s' % OUT)
