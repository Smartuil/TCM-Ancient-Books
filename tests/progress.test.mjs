// 阅读进度模块的单元测试：node tests/progress.test.mjs（无需浏览器、无依赖）
// 进度模块单元测试：直接跑真代码（node 22 原生支持 .ts 类型擦除），用假的 localStorage
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// node 22 原生支持 .ts 的类型擦除，不需要编译步骤
const P = await import(new URL('../src/lib/progress.ts', import.meta.url).href);
const KEY = 'qhguji:progress:v1';

let n = 0, bad = 0;
const t = (name, fn) => {
  try { fn(); n++; console.log('  ✓ ' + name); }
  catch (e) { bad++; console.log('  ✗ ' + name + ' → ' + e.message); }
};

console.log('\n[进度模块] src/lib/progress.ts');

t('空状态：无记录', () => {
  assert.equal(P.getProgress('001'), undefined);
  assert.deepEqual(P.allProgress(), {});
});

t('写入后能读回', () => {
  P.saveProgress('001', { s: 22, t: '人参', n: 378, at: Date.now() });
  const p = P.getProgress('001');
  assert.equal(p.s, 22);
  assert.equal(p.t, '人参');
  assert.equal(p.n, 378);
});

t('覆盖同一本书不新增条目', () => {
  P.saveProgress('001', { s: 30, t: '甘草', n: 378, at: Date.now() });
  assert.equal(Object.keys(P.allProgress()).length, 1);
  assert.equal(P.getProgress('001').s, 30);
});

t('百分比：第 1 篇至少显示 1%，最后一篇 100%', () => {
  assert.equal(P.percent({ s: 0, t: '', n: 378, at: 0 }), 1);
  assert.equal(P.percent({ s: 377, t: '', n: 378, at: 0 }), 100);
  assert.equal(P.percent({ s: 188, t: '', n: 378, at: 0 }), 50);
});

t('相对时间文案', () => {
  const now = Date.now();
  assert.equal(P.ago(now - 30_000, now), '刚刚');
  assert.equal(P.ago(now - 12 * 60_000, now), '12 分钟前');
  assert.equal(P.ago(now - 90 * 60_000, now), '1 小时前');
  assert.equal(P.ago(now - 26 * 3600_000, now), '昨天');
  assert.equal(P.ago(now - 5 * 86400_000, now), '5 天前');
});

t('最近在读按时间倒序、可限量', () => {
  store.clear();                       // 这一条自建干净状态
  P.saveProgress('002', { s: 5, t: 'A', n: 10, at: 2000 });
  P.saveProgress('003', { s: 9, t: 'B', n: 10, at: 3000 });
  P.saveProgress('004', { s: 9, t: 'C', n: 10, at: 1000 });
  const all = P.recentProgress(10).map(([id]) => id);
  assert.deepEqual(all.slice(0, 3), ['003', '002', '004'], '按 at 倒序');
  assert.equal(P.recentProgress(2).length, 2, '可限量');
});

t('清除单本进度', () => {
  P.clearProgress('002');
  assert.equal(P.getProgress('002'), undefined);
  assert.ok(P.getProgress('003'));
});

t('超过 300 本时按时间淘汰最旧的（不会无限增长）', () => {
  for (let i = 0; i < 305; i++) {
    P.saveProgress(String(1000 + i), { s: i, t: 'x', n: 100, at: 1_600_000_000_000 + i });
  }
  const keys = Object.keys(P.allProgress());
  assert.equal(keys.length, 300, `实际 ${keys.length}`);
  assert.ok(!keys.includes('1000'), '最旧的那本应被淘汰');
  assert.ok(keys.includes('1304'), '最新的那本应保留');
});

t('本地数据被改坏时不抛错（静默降级）', () => {
  store.set(KEY, '{这不是 json');
  assert.deepEqual(P.allProgress(), {});
  assert.equal(P.getProgress('001'), undefined);
});

t('localStorage 抛异常也不影响阅读（隐私模式）', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.deepEqual(P.allProgress(), {});
  P.saveProgress('001', { s: 1, t: 'x', n: 10, at: 1 }); // 不抛
  P.clearProgress('001');                                // 不抛
});

console.log(`\n结果：${n} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
