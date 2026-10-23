# -*- coding: utf-8 -*-
"""把「能直接给用户的东西」打包到桌面：EXE + APK + 使用说明。

单独拷贝三个文件（方便直接拿手机装），同时打成一个 zip（方便整包发送）。
版本号读 android/app/build.gradle 的 versionName。

用法：
    python tools/make-release.py                    # 默认 D:\\Users\\ximym\\Desktop
    python tools/make-release.py D:\\somewhere      # 指定输出目录
"""
import io
import os
import re
import shutil
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_gradle = io.open(os.path.join(ROOT, 'android', 'app', 'build.gradle'),
                  encoding='utf-8').read()
VER = (re.search(r'versionName\s+"([^"]+)"', _gradle) or [None, '0.0.0'])[1]
VCODE = (re.search(r'versionCode\s+(\d+)', _gradle) or [None, '?'])[1]

MILE = '里程碑 2' if VER.startswith('0.4') else ('里程碑 1' if VER.startswith('0.2') else '')

DESKTOP = sys.argv[1] if len(sys.argv) > 1 else r'D:\Users\ximym\Desktop'

EXE = os.path.join(ROOT, 'dist', 'MyLife-v%s-windows.exe' % VER)
APK = os.path.join(ROOT, 'dist', 'MyLife-v%s-android.apk' % VER)
README = os.path.join(ROOT, 'dist', 'win', '使用说明.txt')

for p, name in ((EXE, 'EXE'), (APK, 'APK'), (README, '使用说明')):
    if not os.path.exists(p):
        print('缺少 %s：%s' % (name, p))
        print('先跑 node tools/build-exe.js（它会把 APK 一起同步过来）')
        sys.exit(1)

if not os.path.isdir(DESKTOP):
    os.makedirs(DESKTOP)

exe_out = os.path.join(DESKTOP, 'MyLife-v%s-windows.exe' % VER)
apk_out = os.path.join(DESKTOP, 'MyLife-v%s-android.apk' % VER)
readme_out = os.path.join(DESKTOP, 'MyLife-v%s-使用说明.txt' % VER)

shutil.copyfile(EXE, exe_out)
shutil.copyfile(APK, apk_out)
shutil.copyfile(README, readme_out)

# zip 里的使用说明用原名，打开就是「使用说明」而不是一长串文件名
zip_out = os.path.join(DESKTOP, 'MyLife-v%s-发布包.zip' % VER)


def human(n):
    return '%.1f MB' % (n / 1048576.0) if n >= 1048576 else '%.0f KB' % (n / 1024.0)


with zipfile.ZipFile(zip_out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    zf.writestr('发布说明.txt', (
        '我的人生档案 · The Story of My Life\n'
        '================================================================\n'
        '版本      v%s%s\n' % (VER, ('（' + MILE + '）') if MILE else '') +
        '打包时间  %s\n' % time.strftime('%Y-%m-%d %H:%M') +
        '安卓      versionCode %s / versionName %s\n' % (VCODE, VER) +
        '\n'
        '这个包里有什么\n'
        '----------------------------------------------------------------\n'
        '  MyLife-v%s-windows.exe   Windows 单文件版，双击即用，界面已内置\n' % VER +
        '  MyLife-v%s-android.apk   安卓版，传到手机点开安装\n' % VER +
        '  使用说明.txt             两端的完整用法、录音排查步骤\n' +
        '\n'
        '三句话上手\n'
        '----------------------------------------------------------------\n'
        '  Windows：双击 exe → 浏览器自动打开 → 黑窗口别关\n'
        '  安卓   ：传 apk 到手机 → 安装（允许一次"未知来源"）→ 打开\n'
        '  先注册（手机号 + 密码 + 验证码填 1234），再进设置填模型 Key\n'
        '\n'
        '每个账号一个独立数据库，互相看不到；备份只需备份 data 目录，或用「导出」。\n'
        '详细变更见项目里的 CHANGELOG.md，里程碑 2 的验收记录见 docs/MILESTONE-2.md。\n'
    ))
    zf.write(exe_out, 'MyLife-v%s-windows.exe' % VER)
    zf.write(apk_out, 'MyLife-v%s-android.apk' % VER)
    zf.write(readme_out, '使用说明.txt')

print('版本    v%s%s' % (VER, ('（' + MILE + '）') if MILE else ''))
print('目录    %s' % DESKTOP)
for p in (exe_out, apk_out, readme_out):
    print('  %-40s %s' % (os.path.basename(p), human(os.path.getsize(p))))
print('  %-40s %s' % (os.path.basename(zip_out), human(os.path.getsize(zip_out))))
