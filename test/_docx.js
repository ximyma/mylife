/**
 * 造 .docx 的小工具（审计用）。
 *
 * 只造 Word 真正会读的那几个部件：正文、关系表、两张图。
 * zip 自己写：store 与 deflate 两种都支持 —— 真实 Word/WPS 用 deflate，
 * 有些导出工具用 store，两种都得能读。
 */
'use strict';
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/** files: [{ name, data: Buffer, method?: 0|8 }] -> Buffer(.docx) */
function zip(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const method = f.method === undefined ? 8 : f.method;
    const data = method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const crc = crc32(f.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);           // 文件名按 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cd, eocd]));
}

/* 1×1 的红点 PNG，够当"照片"用 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function xe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function P(text, style) {
  return '<w:p>' + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') +
    '<w:r><w:t xml:space="preserve">' + xe(text) + '</w:t></w:r></w:p>';
}

function PImg(rid) {
  return '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0"><wp:extent cx="1000" cy="1000"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:blipFill><a:blip r:embed="' + rid + '"/></pic:blipFill></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

function documentXml(bodyParas) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + bodyParas.join('') +
    '<w:sectPr><w:pgSz w:w="8391" w:h="11906"/></w:sectPr></w:body></w:document>';
}

function docs(files) {
  return [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(files.body, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(files.rels, 'utf8') },
  ].concat(files.media || []);
}

/**
 * 仿本程序导出的 Word：封面 + 档案信息 + 目录 + 各章（章头年份/引语/正文/图+图注）
 * opts: { no, name, years, hometown, intro, chapters:[{title, years, stage, quote, paras:[], photoCaption}] }
 */
function likeExport(opts) {
  const o = opts || {};
  const chapters = o.chapters || [];
  const body = [];
  body.push(P(o.no || 'MS-2026-0009'));
  body.push(P(o.name || '王小二'));
  body.push(P(o.years || '1940—'));
  if (o.intro) body.push(P('「' + o.intro + '」'));
  body.push(P('档案信息', 'Heading1'));
  body.push(P('档案编号：' + (o.no || 'MS-2026-0009')));
  body.push(P('篇幅：共 ' + chapters.length + ' 章'));
  body.push(P('整理日期：2026-10-28'));
  body.push(P('目录', 'Heading1'));
  chapters.forEach((c, i) => {
    body.push(P((i + 1) + '　' + c.title + (c.years ? '（' + c.years + '）' : '')));
  });

  const media = [];
  let rid = 5;
  chapters.forEach((c, i) => {
    body.push(P('第 ' + (i + 1) + ' 章　' + c.title, 'Heading1'));
    if (c.years || c.stage) body.push(P([c.years, c.stage].filter(Boolean).join(' · ')));
    if (c.quote) body.push(P('「' + c.quote + '」'));
    (c.paras || []).forEach(t => body.push(P(t)));
    if (c.photoCaption !== undefined) {
      const id = 'rId' + (rid++);
      body.push(PImg(id));
      if (c.photoCaption) body.push(P(c.photoCaption));
      const n = media.length + 1;
      media.push({ name: 'word/media/image' + n + '.png', data: PNG, method: n === 1 ? 0 : 8 });
      media['rel' + id] = 'media/image' + n + '.png';
    }
  });

  const relLines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
  Object.keys(media).filter(k => k.indexOf('rel') === 0).forEach(k => {
    relLines.push('<Relationship Id="' + k.slice(3) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + media[k] + '"/>');
  });
  relLines.push('</Relationships>');

  return zip(docs({ body: documentXml(body), rels: relLines.join(''), media: media.filter(x => x.name) }));
}

/** 没有任何标题样式的普通 Word：只有一段段文字 */
function plain(paragraphs, opts) {
  const body = (paragraphs || []).map(t => P(t));
  const media = [{ name: 'word/media/pic.png', data: PNG }];
  body.push(PImg('rId9'));
  return zip(docs({
    body: documentXml(body),
    rels: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>' +
      '</Relationships>',
    media: media,
  }));
}

module.exports = { zip, crc32, PNG, likeExport, plain, documentXml, P };
