#!/usr/bin/env node
/* 蒋介石人生档案样本 —— 构建脚本
 * 用途：把一份"详细漂亮的人生档案"写入单机版数据库，作为 PDF/漫画/短片导出样本。
 * 数据来源：百度百科、台湾国史馆"蔣中正總統文物"小傳及多家公开史料，
 *          交叉核对后由本脚本原创撰写，仅使用已进入公共领域的史实，规避版权争议。
 * 产出：
 *   data/auth.db            —— 演示账号（管理员）：13800138000 / 123456
 *   data/users/1/archive.db —— 蒋介石档案（archives + chapters + entries）
 * 运行：node --experimental-sqlite scripts/build_jiang_sample.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SCHEMA_FILE = path.join(ROOT, 'server', 'schema.sql');

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), String(salt), 64).toString('hex');
}

/* ---------- 1. 演示登录账号（auth.db） ---------- */
function buildAuth() {
  const adbPath = path.join(DATA, 'auth.db');
  if (fs.existsSync(adbPath)) {
    console.log('[auth] 已存在，跳过（保留现有账号）');
    return;
  }
  fs.mkdirSync(DATA, { recursive: true });
  const adb = new DatabaseSync(adbPath);
  adb.exec('PRAGMA journal_mode = WAL');
  adb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      nickname TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      security_q TEXT,
      security_a TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
  `);
  const phone = '13800138000';
  const pw = '123456';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(pw, salt);
  adb.prepare(
    'INSERT INTO users (phone, password_hash, salt, nickname, is_admin) VALUES (?, ?, ?, ?, 1)'
  ).run(phone, hash, salt, '样本管理员');
  console.log('[auth] 演示账号已建：' + phone + ' / ' + pw + '（管理员）');
  adb.close();
}

/* ---------- 2. 蒋介石档案（archive.db, uid=1） ---------- */
const ARCHIVE = {
  subject_name: '蒋介石',
  birth_year: 1887,
  death_year: 1975,
  hometown: '浙江奉化',
  intro:
    '蒋介石（1887年10月31日—1975年4月5日），名中正，字介石，原名瑞元，浙江奉化人。' +
    '近代中国最具影响力的政治与军事人物之一。早年接受传统私塾教育，后赴日本学习军事，毕业于振武学校。' +
    '1911年辛亥革命爆发，他弃学回国投身革命，自此登上历史舞台。此后数十年间，他历任黄埔军校校长、' +
    '国民革命军总司令、南京国民政府主席、军事委员会委员长、中国国民党总裁，并于1948年当选行宪后第一任总统。' +
    '他是国民政府抗战时期的最高统帅，也是1949年后退守台湾、在台湾主政二十六年的政治领袖。' +
    '其一生横跨晚清、民国与台湾时期，褒贬毁誉交织，是中国近现代史无法绕开的关键人物。',
  facts_json: JSON.stringify({
    谱名: '周泰', 学名: '志清', 字: '介石', 名: '中正',
    配偶: '宋美龄', 子女: '蒋经国、蒋纬国',
    毕业院校: '日本振武学校', 籍贯: '浙江奉化',
    主要职务: '黄埔军校校长 / 国民革命军总司令 / 国民政府主席 / 军事委员会委员长 / 总统',
    关键节点: '1924黄埔建军 · 1926北伐 · 1936西安事变 · 1937全面抗战 · 1949退守台湾 · 1975病逝台北'
  })
};

const CHAPTERS = [
  {
    seq: 1, title: '少年与求学（1887—1911）', year_from: 1887, year_to: 1911,
    stage: '孕育', quote: '“雪耻。”——青年蒋介石日记常用二字，自勉发愤。',
    summary:
      '奉化溪口的盐商之家，丧父孤童，由母抚育；在传统经史与新学之间辗转求索，最终剪辫东渡，立志习武。',
    entries: [
      { at_year: 1887, text: '1887年10月31日生于浙江奉化溪口镇，父蒋肇聪经营玉泰盐铺，家境小康。八岁时父病逝，家道中落，由母王采玉独自抚养成人。' },
      { at_year: 1893, text: '六岁入塾，自《三字经》《百家姓》启蒙，继读四书五经、古文辞章。少年丧父、家计艰难，养成了他坚韧而敏感的性格，也埋下发愤自强之心。' },
      { at_year: 1903, text: '1903年入奉化凤麓学堂接受新学，因带头反对陈旧校规而获“红脸将军”绰号；后又转学龙津、箭金等学堂，从顾清廉读《孙子兵法》，始生习武报国之志。' },
      { at_year: 1906, text: '1906年剪去发辫，东渡日本，先入清华学校习日语，结识革命党人陈其美，深受反清思想熏陶，革命信念渐次坚定。' },
      { at_year: 1907, text: '1907年考入通国陆军速成学堂（保定军校前身）学炮兵；1908年选送日本振武学校，并加入同盟会，正式成为革命者。' },
      { at_year: 1910, text: '1910年振武学校毕业后编入日本陆军第十三师团野炮兵第十九联队为士官候补生，在新潟高田的严寒中经受军营磨炼，体认武士道精神。' }
    ]
  },
  {
    seq: 2, title: '投身革命（1911—1924）', year_from: 1911, year_to: 1924,
    stage: '崛起', quote: '“安危同仗，甘苦共尝。”——与陈其美、黄郛结拜誓词。',
    summary:
      '辛亥革命枪声响起，他自日本化装回国，率敢死队光复杭州；讨袁、护法、永丰舰侍卫孙中山，终获信任，被派赴苏考察，归国执掌黄埔。',
    entries: [
      { at_year: 1911, text: '1911年武昌起义爆发，蒋介石应陈其美之召回国，任杭州光复之役炸弹队指挥官，配合敢死队攻克巡抚衙门，崭露军事胆识与组织才干。' },
      { at_year: 1912, text: '沪军都督府成立后任第五团团长，结识陈其美、黄郛并结为异姓兄弟；亦奉命处置光复会领袖陶成章，从此紧密追随陈其美左右。' },
      { at_year: 1913, text: '1913年起参加“二次革命”讨袁，失败后再度流亡日本；1916年陈其美被刺，蒋介石顿失倚仗，转与张静江、许崇智等结拜，广结人脉以自固。' },
      { at_year: 1917, text: '1917年孙中山南下护法，蒋介石上书《对北军作战计划》，深受赏识；1918年入援闽粤军，屡任作战参谋与支队司令，积累实战经验。' },
      { at_year: 1922, text: '1922年陈炯明叛变炮轰总统府，孙中山登永丰舰，蒋介石闻讯赶赴侍卫四十余日，事后著《孙大总统广州蒙难记》，孙中山亲为作序，声誉大增。' },
      { at_year: 1923, text: '1923年率“孙逸仙博士代表团”赴苏联考察军政三个月，会晤苏共高层，归国呈《游俄报告书》，虽赞赏苏俄党治，亦埋下对共产国际的疑虑。' },
      { at_year: 1924, text: '1924年孙中山创办黄埔军校，蒋介石任校长兼粤军参谋长，亲手培植黄埔系嫡系，奠定日后执掌军权的根基。' }
    ]
  },
  {
    seq: 3, title: '黄埔建军与北伐（1924—1928）', year_from: 1924, year_to: 1928,
    stage: '掌权', quote: '“革命军当务之急，在打破利害之私，结成坚固之团体。”——黄埔精神。',
    summary:
      '以黄埔校长为起点，借中山舰事件与整理党务案攫取党军政大权；出掌国民革命军总司令，誓师北伐，底定中原。',
    entries: [
      { at_year: 1924, text: '任黄埔校长期间，蒋介石大量发表训话，标榜仿效俄共办法，同时重用何应钦、陈诚、刘峙、顾祝同等人为骨干，黄埔系由此成形。' },
      { at_year: 1926, text: '1926年3月制造“中山舰事件”，借机排挤中共与汪精卫等人；5月提出“整理党务案”，自任中央常务委员会主席等要职，党权在握。' },
      { at_year: 1926, text: '1926年7月就任国民革命军总司令，誓师北伐，连克武汉、南昌、南京，势如破竹，成为全国瞩目的军事领袖。' },
      { at_year: 1927, text: '1927年发动“四一二”清党，在上海等地镇压共产党人与工农群众，第一次国共合作公开破裂；4月18日于南京另立国民政府。' },
      { at_year: 1927, text: '同年8月因宁汉对立与军阀反扑一度下野，12月与宋美龄结婚，借宋氏家族与江浙财团巩固政治资本，旋即复职。' },
      { at_year: 1928, text: '1928年1月复职后继续“二次北伐”，击败奉系，年底实现形式上的全国统一，就任南京国民政府主席。' }
    ]
  },
  {
    seq: 4, title: '南京国民政府与剿共（1928—1937）', year_from: 1928, year_to: 1937,
    stage: '独裁', quote: '“攘外必先安内。”——九一八后的基本国策口号。',
    summary:
      '坐镇南京，集党政军大权于一身；新军阀混战连年，对日采取“攘外必先安内”，五次围剿红军，直至西安事变被迫转向。',
    entries: [
      { at_year: 1930, text: '统一未久，1930年爆发蒋冯阎“中原大战”，双方百万兵力厮杀，以蒋介石胜利告终，中央权威一时鼎盛却也树敌无数。' },
      { at_year: 1931, text: '1931年“九一八事变”日军侵占东北，蒋介石以“攘外必先安内”为方针，对日采取不抵抗，将主力用于围剿红军。' },
      { at_year: 1932, text: '1932年“一·二八”淞沪抗战后复出，任军事委员会委员长，集军权于一身，对内积极剿共，对外整军备战。' },
      { at_year: 1934, text: '1933至1934年对中央苏区发动五次“围剿”，红军被迫长征；同时推行保甲、特务组织，强化独裁统治。' },
      { at_year: 1936, text: '1936年12月西安事变，张学良、杨虎城兵谏挟持蒋介石，迫其停止内战、联共抗日；事平后蒋返南京，剿共基本停顿。' }
    ]
  },
  {
    seq: 5, title: '抗日战争（1937—1945）', year_from: 1937, year_to: 1945,
    stage: '抗战', quote: '“地无分南北，年无分老幼，无论何人，皆有守土抗战之责任。”——庐山谈话（1937）。',
    summary:
      '卢沟桥事变点燃全面抗战，蒋介石以最高统帅身份领导八年血战，跻身世界反法西斯同盟中国战区统帅，至1945年迎来胜利。',
    entries: [
      { at_year: 1937, text: '1937年7月卢沟桥事变，全面抗战爆发；蒋介石发表庐山谈话，号召全国抗战，并任国防最高会议主席，统筹军政。' },
      { at_year: 1937, text: '8月组织淞沪会战，粉碎日军“三个月亡华”迷梦，虽伤亡惨重却振奋民心；随后首都南京沦陷，发生惨烈浩劫。' },
      { at_year: 1938, text: '1938年武汉会战后在战略上转入相持，蒋介石任国民党总裁，以“以空间换时间”的方针持久消耗日军。' },
      { at_year: 1941, text: '1941年珍珠港事件后，中国正式对日宣战，与美英苏结盟；蒋介石任盟军中国战区最高统帅，国际地位空前提高。' },
      { at_year: 1943, text: '1943年赴开罗与罗斯福、丘吉尔会晤，签署《开罗宣言》，明确战后台湾、澎湖归还中国，奠定战后秩序话语权。' },
      { at_year: 1945, text: '抗战期间亦曾多次掀起反共摩擦，但在民族存亡关头维持了抗日民族统一战线的大局，直至1945年日本投降。' }
    ]
  },
  {
    seq: 6, title: '国共内战与退守台湾（1946—1975）', year_from: 1946, year_to: 1975,
    stage: '退台', quote: '“反攻大陆。”——退台后念兹在兹，终成未竟之志。',
    summary:
      '抗战胜利后撕毁协定挑起内战，终致败退；1949年退守台湾，主政二十六载，推动改造与土改，1975年病逝台北。',
    entries: [
      { at_year: 1946, text: '1945年抗战胜利后，蒋介石坚持独裁方针，1946年撕毁停战协定与政协决议，大举进攻解放区，内战全面爆发。' },
      { at_year: 1948, text: '1946年单独召开“制宪国大”通过宪法；1948年当选行宪后第一任总统并就职，然战场形势急转直下。' },
      { at_year: 1949, text: '1949年1月21日被迫下野，由李宗仁代行总统；同年秋国民党军溃败，蒋介石率残部退守台湾。' },
      { at_year: 1950, text: '1950年3月在台“复行视事”，发动国民党改造运动，整肃党内派系，并支持陈诚推动“耕者有其田”等土地改革。' },
      { at_year: 1960, text: '在台期间连任多任“总统”（1954、1960、1966、1972等），以“动员戡乱”体制维持统治，同时整军经武、经营台海防务。' },
      { at_year: 1975, text: '1972年重病后国政渐由蒋经国代理；1975年4月5日清明节，蒋介石因心脏病突发病逝于台北，享寿八十九岁，灵柩暂厝慈湖。' }
    ]
  }
];

function buildArchive() {
  const uid = 1;
  const userDir = path.join(DATA, 'users', String(uid));
  const filesDir = path.join(userDir, 'files');
  for (const sub of ['photo', 'audio', 'video', 'derived', 'ai', 'exports']) {
    fs.mkdirSync(path.join(filesDir, sub), { recursive: true });
  }
  const dbPath = path.join(userDir, 'archive.db');
  fs.rmSync(dbPath, { force: true });
  if (fs.existsSync(dbPath + '-wal')) fs.rmSync(dbPath + '-wal', { force: true });
  if (fs.existsSync(dbPath + '-shm')) fs.rmSync(dbPath + '-shm', { force: true });

  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  for (const stmt of schema.split(';')) {
    const clean = stmt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (!clean) continue;
    try { d.exec(clean); } catch (e) {
      const msg = String(e && e.message || '');
      if (!/duplicate column name|already exists/i.test(msg)) console.warn('[schema] 跳过：', clean.slice(0, 40), msg);
    }
  }

  const insArc = d.prepare(
    'INSERT INTO archives (user_id, subject_name, birth_year, death_year, hometown, intro, facts_json, status, visibility) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
  );
  const res = insArc.run(uid, ARCHIVE.subject_name, ARCHIVE.birth_year, ARCHIVE.death_year,
    ARCHIVE.hometown, ARCHIVE.intro, ARCHIVE.facts_json, 'published');
  const archiveId = Number(res.lastInsertRowid);

  const insCh = d.prepare(
    'INSERT INTO chapters (archive_id, seq, title, year_from, year_to, stage, quote, summary) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insEn = d.prepare(
    'INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, at_year, at_precision, at_label) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let chSeq = 10;
  for (const ch of CHAPTERS) {
    const cr = insCh.run(archiveId, ch.seq, ch.title, ch.year_from, ch.year_to, ch.stage, ch.quote, ch.summary);
    const chapterId = Number(cr.lastInsertRowid);
    let eSeq = 10;
    for (const en of ch.entries) {
      insEn.run(archiveId, chapterId, eSeq, 'text', en.text, 'human', en.at_year, 'year', String(en.at_year) + '年');
      eSeq += 10;
    }
    chSeq += 10;
  }

  const counts = {
    chapters: Number(d.prepare('SELECT count(*) n FROM chapters WHERE archive_id=?').get(archiveId).n),
    entries: Number(d.prepare('SELECT count(*) n FROM entries WHERE archive_id=?').get(archiveId).n)
  };
  d.close();
  console.log('[archive] 蒋介石档案已建：chapters=' + counts.chapters + ' entries=' + counts.entries + ' archiveId=' + archiveId);
}

buildAuth();
buildArchive();
console.log('完成。请用演示账号登录：13800138000 / 123456');
