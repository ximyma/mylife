# -*- coding: utf-8 -*-
"""v0.2.0 代码备份包：全部源码 + EXE + APK，不含用户数据与临时目录。"""
import os, zipfile, time

ROOT = r'D:\works\mylife1'
OUT = os.path.join(ROOT, 'dist', 'mylife-v0.2.0-backup-20261023.zip')

INCLUDE_DIRS = ['server', 'web', 'tools', 'test', 'docs']
INCLUDE_FILES = ['README.md', 'CHANGELOG.md']
ANDROID_SRC = os.path.join(ROOT, 'android', 'app', 'src')
ANDROID_GRADLE = os.path.join(ROOT, 'android', 'app', 'build.gradle')
ANDROID_MANIFEST_DIR = os.path.join(ROOT, 'android', 'app')
EXE = os.path.join(ROOT, 'dist', 'win', 'MyLife.exe')
APK = os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')

def add(zf, arc, fp):
    zf.write(fp, arc)

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    # 顶层说明
    info = (
        '我的人生档案 · The Story of My Life\n'
        f'版本 v{VER}（备份时间见下行）\n'
        'commit 16f17db + 打包时间 ' + time.strftime('%Y-%m-%d %H:%M') + '\n'
        '\n'
        '内容清单：\n'
        '  source/            全部源码（server / web / tools / test / docs）\n'
        '  source/android/    安卓宿主（Java + Gradle 配置 + Manifest）\n'
        '  MyLife.exe         Windows 单文件版（v0.2，界面内置，83MB）\n'
        '  mylife-v0.2.apk    安卓调试包（versionCode 2）\n'
        '\n'
        '不含：data/（用户数据）、tmp/、dist/ 中间产物。\n'
        '还原开发环境：解压后 npm 无需安装（零依赖），node server/server.js 即可跑。\n'
        '详细变更见 source/CHANGELOG.md。\n'
    )
    zf.writestr('BACKUP-INFO.txt', info)

    n = 0
    # 源码目录
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in ('node_modules', '.gradle', 'build')]
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                arc = 'source/' + os.path.relpath(fp, ROOT).replace('\\', '/')
                add(zf, arc, fp); n += 1
    # 安卓源码与配置
    for dirpath, dirnames, filenames in os.walk(ANDROID_SRC):
        dirnames[:] = [x for x in dirnames if x not in ('build',)]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arc = 'source/android/app/src/' + os.path.relpath(fp, ANDROID_SRC).replace('\\', '/')
            add(zf, arc, fp); n += 1
    add(zf, 'source/android/app/build.gradle', ANDROID_GRADLE); n += 1
    for fn in os.listdir(ANDROID_MANIFEST_DIR):
        if fn.endswith('.pro'):
            add(zf, 'source/android/app/' + fn, os.path.join(ANDROID_MANIFEST_DIR, fn)); n += 1
    for fn in ['settings.gradle', 'build.gradle', 'gradle.properties']:
        fp = os.path.join(ROOT, 'android', fn)
        if os.path.exists(fp):
            add(zf, 'source/android/' + fn, fp); n += 1
    # 根文档
    for fn in INCLUDE_FILES:
        fp = os.path.join(ROOT, fn)
        if os.path.exists(fp):
            add(zf, 'source/' + fn, fp); n += 1
    # 产物
    add(zf, 'MyLife.exe', EXE); n += 1
    add(zf, 'mylife-v0.2.apk', APK); n += 1

print('文件数:', n)
print('大小: %.1f MB' % (os.path.getsize(OUT) / 1048576))
print('位置:', OUT)
