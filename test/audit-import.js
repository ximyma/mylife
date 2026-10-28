/**
 * 导入审计（服务端）：Word(.docx) 能不能读回成档案。
 *
 * 覆盖：
 *   ① 本程序导出的 Word —— 章标题、章头年份/阶段、章引语、正文段、图片 + 图注
 *   ② 没有标题样式的普通 Word —— 整篇兜成一章，并给出提示
 *   ③ 垃圾文件 / 空内容 / 未登录 —— 都要有明确说法，不能静默失败
 *
 * 用法： node test/audit-import.js
 */
'use strict';
const { startServer } = require('./_lib.js');
const docx = require('./_docx.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? ' << ' + String(d).slice(0, 240) : '')); }
};

(async () => {
  const S = startServer('import');
  await S.waitReady();
  const token = await S.register();

  /* ---------- 1. 本程序导出的 Word ---------- */
  console.log('[A] 我们自己导出的 Word');
  const buf = docx.likeExport({
    no: 'MS-2026-0009', name: '王小二', years: '1940—', intro: '一辈子种田，也教了几个学生。',
    chapters: [
      {
        title: '小时候', years: '1940', stage: '幼年', quote: '我记得那时候家家都点煤油灯。',
        paras: ['我 1940 年出生在这个村子，家里排行老三。', '七岁那年跟着父亲下地，学会了插秧。'],
        photoCaption: '1948 · 村里的老屋 · 王小二',
      },
      {
        title: '去县城读书', years: '1952', stage: '少年',
        paras: ['1952 年考上县中，走了四十里山路。'],
      },
    ],
  });
  console.log('   造出来的 docx：' + buf.length + ' 字节');

  const r = await S.post('/api/docx/parse', { base64: buf.toString('base64'), name: '王小二-20261028.docx' }, token);
  ck('读成功了', r.ok === true, r.message);
  ck('认出 2 章', r.chapters && r.chapters.length === 2, r.chapters && r.chapters.length);
  ck('第 1 章标题正确', r.chapters && r.chapters[0].title === '小时候', r.chapters && r.chapters[0].title);
  ck('章头年份与阶段拆开了',
    r.chapters && r.chapters[0].years === '1940' && r.chapters[0].stage === '幼年',
    r.chapters && (r.chapters[0].years + '/' + r.chapters[0].stage));
  ck('章引语没混进正文', r.chapters && r.chapters[0].quote === '我记得那时候家家都点煤油灯。',
    r.chapters && r.chapters[0].quote);
  ck('该章正文 2 段',
    r.chapters && r.chapters[0].blocks.filter(b => b.type === 'text').length === 2,
    r.chapters && r.chapters[0].blocks.length);
  const ph = r.chapters && r.chapters[0].blocks.filter(b => b.type === 'photo');
  ck('图片跟着回来了', ph && ph.length === 1, ph && ph.length);
  ck('图注也带上了', ph && ph[0].caption === '1948 · 村里的老屋 · 王小二', ph && ph[0].caption);
  ck('图片有真实内容（base64）', ph && ph[0].b64 && ph[0].b64.length > 60, ph && ph[0].b64 && ph[0].b64.length);
  ck('封面信息读到了：编号', r.archive && r.archive.archive_no === 'MS-2026-0009', r.archive && r.archive.archive_no);
  ck('封面信息读到了：姓名', r.archive && r.archive.subject_name === '王小二', r.archive && r.archive.subject_name);
  ck('封面信息读到了：出生年', r.archive && r.archive.birth_year === 1940, r.archive && r.archive.birth_year);
  ck('封面信息读到了：自序', r.archive && r.archive.intro === '一辈子种田，也教了几个学生。', r.archive && r.archive.intro);
  ck('「档案信息」「目录」没被当成正文',
    r.chapters && !r.chapters.some(c => /^(档案信息|目录)$/.test(c.title)),
    r.chapters && r.chapters.map(c => c.title).join('|'));
  ck('统计对得上：2 章 3 段 1 图',
    r.stats && r.stats.chapters === 2 && r.stats.paragraphs === 3 && r.stats.photos === 1,
    JSON.stringify(r.stats));
  ck('没读出来时不留警告', !r.warnings || !r.warnings.length, JSON.stringify(r.warnings));

  /* ---------- 2. 普通 Word（没有标题样式） ---------- */
  console.log('[B] 没有章节标题的普通 Word');
  const plain = docx.plain(['这是第一段回忆，写在小本子上的。', '这是第二段，说到了 1978 年的那场雪。']);
  const r2 = await S.post('/api/docx/parse', { base64: plain.toString('base64'), name: '零散回忆.docx' }, token);
  ck('兜底成 1 章', r2.ok === true && r2.chapters && r2.chapters.length === 1, JSON.stringify(r2.stats));
  ck('文字没丢（2 段）', r2.chapters && r2.chapters[0].blocks.filter(b => b.type === 'text').length === 2,
    r2.chapters && r2.chapters[0].blocks.length);
  ck('明确告诉用户"整篇当一章"', r2.warnings && r2.warnings.join('').indexOf('整篇') >= 0, JSON.stringify(r2.warnings));
  ck('文件名当姓名建议', r2.suggest_name === '零散回忆', r2.suggest_name);

  /* ---------- 3. 坏输入 ---------- */
  console.log('[C] 坏输入要说清楚');
  const bad = await S.post('/api/docx/parse', { base64: Buffer.from('这不是 zip').toString('base64'), name: 'x.docx' }, token);
  ck('非 docx 明确报错', bad.ok === false && /docx/i.test(bad.message || ''), bad.message);
  const empty = await S.post('/api/docx/parse', { base64: '', name: 'y.docx' }, token);
  ck('空内容明确报错', empty.ok === false && /没有收到|空/.test(empty.message || ''), empty.message);
  const noAuth = await S.post('/api/docx/parse', { base64: buf.toString('base64') });
  ck('没登录不给读', noAuth.__auth === '需要登录' || noAuth.ok === false, JSON.stringify(noAuth).slice(0, 80));

  /* ---------- 4. 从 docx 到档案包：形状能被导入流程接受 ---------- */
  console.log('[D] 解析结果能直接转成档案包（前端 docxToPack 的形状）');
  ck('返回 format 标记', r.format === 'mylife-docx', r.format);
  ck('每块都有 type', r.chapters.every(c => c.blocks.every(b => !!b.type)));

  S.stop();
  console.log('\n  ' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})();
