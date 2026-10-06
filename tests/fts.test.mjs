// 全文检索的测试：直接跑 src/lib/fts.ts + **真索引文件**（用文件系统冒充 fetch）
// 需要先构建索引：python3 scripts/build_index.py
// 运行：npm run test:fts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DATA = path.join(ROOT, 'public', 'data');

if (!fs.existsSync(path.join(DATA, 'fts', 'manifest.json'))) {
  console.log('跳过：还没有 fts 索引，先跑 python3 scripts/build_index.py');
  process.exit(0);
}

// 用文件系统冒充 fetch —— 被测代码完全不知道自己在读盘
const fetchedUrls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchedUrls.push(u);
  const p = path.join(DATA, u.replace(/^.*?data\//, ''));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

const { searchFullText, bigramsOf, fnv1a, docToBook, getManifest } = await import(
  new URL('../src/lib/fts.ts', import.meta.url).href
);
const BASE = '/';

let pass = 0, bad = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { bad++; console.log('  ✗ ' + name + ' → ' + e.message); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { bad++; console.log('  ✗ ' + name + ' → ' + e.message); }
};

console.log('\n[1] bigram 切分规则（必须与 build_index.py 完全一致）');
t('两字词', () => assert.deepEqual(bigramsOf('人参'), ['人参']));
t('标点不参与、也不跨标点成词', () => assert.deepEqual(bigramsOf('人参、甘草'), ['人参', '甘草']));
t('拉丁/数字不参与', () => assert.deepEqual(bigramsOf('a人参1甘草'), ['人参', '甘草']));
t('重复只算一次', () => assert.deepEqual(bigramsOf('人参人参'), ['人参', '参人']));
t('单字没有 bigram（索引不覆盖）', () => assert.deepEqual(bigramsOf('参'), []));
t('四字词 = 3 个 bigram', () => assert.deepEqual(bigramsOf('本草纲目'), ['本草', '草纲', '纲目']));
t('乱码/空白不崩', () => assert.deepEqual(bigramsOf('  \n\t'), []));

console.log('\n[2] FNV-1a 与 Python 端一致（硬编码期望值）');
t('fnv1a("人参") = 1948312317', () => assert.equal(fnv1a('人参'), 1948312317));
t('fnv1a("甘草") = 566247914', () => assert.equal(fnv1a('甘草'), 566247914));
t('fnv1a("本草") = 109230502', () => assert.equal(fnv1a('本草'), 109230502));

console.log('\n[3] 全局篇号 → (书号, 篇序号)');
await ta('第 0 篇 = 001 书的第 0 篇', async () => {
  const man = await getManifest(BASE);
  assert.deepEqual(docToBook(man, 0), { book: '001', section: 0 });
});
await ta('最后一篇落在 701 书内且序号合法', async () => {
  const man = await getManifest(BASE);
  const r = docToBook(man, man.docs - 1);
  assert.equal(r.book, '701');
  const toc = JSON.parse(fs.readFileSync(path.join(DATA, 'toc', '701.json'), 'utf8'));
  assert.ok(r.section >= 0 && r.section < toc.length, `section=${r.section} / toc=${toc.length}`);
});

console.log('\n[4] 真索引检索：命中数与 Python 暴力扫描逐一比对');
const CASES = [
  ['岐黄', 295], ['人参', 23616], ['甘草', 34303], ['麻黄', 9302],
  ['青蒿', 1180], ['安息香', 660], ['四物汤', 3445], ['太阳病', 2380], ['本草纲目', 577],
];
for (const [term, expect] of CASES) {
  await ta(`「${term}」命中 ${expect} 篇`, async () => {
    const r = await searchFullText(BASE, term, 5);
    assert.equal(r.total, expect, `实际 ${r.total}`);
    assert.ok(r.shards.length >= 1 && r.shards.length <= 3, `取片数 ${r.shards.length}`);
  });
}

console.log('\n[5] 精度抽查：命中篇的原文里必须真的有这个词');
const sectionText = (book, section) => {
  const toc = JSON.parse(fs.readFileSync(path.join(DATA, 'toc', `${book}.json`), 'utf8'));
  const chunk = toc[section][2];
  const data = JSON.parse(fs.readFileSync(path.join(DATA, 'books', book, `${chunk}.json`), 'utf8'));
  return (data[toc[section][3]].p || []).join('\n');
};
await ta('「岐黄」295 篇逐篇核对原文（零误报）', async () => {
  const r = await searchFullText(BASE, '岐黄', 1000);
  assert.equal(r.hits.length, 295);
  const wrong = r.hits.filter((h) => !sectionText(h.book, h.section).includes('岐黄'));
  assert.equal(wrong.length, 0, `${wrong.length} 篇原文里没有「岐黄」，例如 ${JSON.stringify(wrong[0])}`);
});
await ta('「人参」随机 15 篇核对原文', async () => {
  const r = await searchFullText(BASE, '人参', 1000);
  const step = Math.floor(r.total / 15);
  const sample = Array.from({ length: 15 }, (_, i) => r.hits[i * step]).filter(Boolean);
  const wrong = sample.filter((h) => !sectionText(h.book, h.section).includes('人参'));
  assert.equal(wrong.length, 0, `${wrong.length}/15 篇对不上`);
});
await ta('「太阳病」召回不低于暴力扫描（bigram 只多不漏）', async () => {
  const r = await searchFullText(BASE, '太阳病', 3000);
  assert.ok(r.total >= 1971, `实际 ${r.total} < 1971`);
});

console.log('\n[6] 成本与缓存');
await ta('同一个词查两次，第二次不再下载分片', async () => {
  const first = await searchFullText(BASE, '桂枝汤', 5);
  const before = fetchedUrls.length;
  const second = await searchFullText(BASE, '桂枝汤', 5);
  assert.equal(second.total, first.total);
  assert.equal(second.fetched, 0, `第二次仍请求了 ${second.fetched} 片`);
  assert.equal(fetchedUrls.length, before, '不该有新请求');
});
await ta('单字查询返回空（UI 负责提示至少两个字）', async () => {
  const r = await searchFullText(BASE, '参', 5);
  assert.equal(r.total, 0);
});
await ta('查不到的词返回 0 而不是报错', async () => {
  const r = await searchFullText(BASE, '龘龘龘', 5);
  assert.equal(r.total, 0);
});

console.log('\n[7] 篇名索引扁平化下标 == 全局篇号（全文结果靠这个 join 篇名）');
await ta('抽查 5 个篇号：扁平化篇名 == toc 里的篇名', async () => {
  const man = await getManifest(BASE);
  const shardMetas = [];
  const m2 = JSON.parse(fs.readFileSync(path.join(DATA, 'search', 'manifest.json'), 'utf8'));
  for (const s of m2.shards) shardMetas.push(JSON.parse(fs.readFileSync(path.join(DATA, 'search', s.file), 'utf8')));
  const flat = shardMetas.flat();
  assert.equal(flat.length, man.docs, `扁平化 ${flat.length} != ${man.docs} 篇`);
  for (const doc of [0, 1000, 50000, 120000, man.docs - 1]) {
    const r = docToBook(man, doc);
    const toc = JSON.parse(fs.readFileSync(path.join(DATA, 'toc', `${r.book}.json`), 'utf8'));
    assert.equal(flat[doc][2], toc[r.section][0], `篇号 ${doc} → ${r.book}/${r.section} 篇名不一致`);
  }
});

console.log(`\n结果：${pass} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
