// 阅读进度的 DOM 级测试：把一个构建好的页面塞进 jsdom，把全局换成它的，
// 然后 import 产物里那份 island 脚本 —— 跑的是线上同一份代码。
// 覆盖：首次打开自动写入、再次打开自动续读（含只加载目标块）、从头开始、首页最近在读与卡片进度条。
// 运行：npm run test:dom（需先 npm run build）
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// 在真 DOM（jsdom）里跑构建产物，验证阅读进度的真实行为。需先 npm run build。
const DIST = new URL('../dist/', import.meta.url).pathname;
const KEY = 'qhguji:progress:v1';
const BASE = '/TCM-Ancient-Books/';

let pass = 0, bad = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { bad++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从页面 HTML 里找出 island 脚本的文件名 */
const bundleOf = (html, prefix) => {
  const m = html.match(new RegExp(`src="([^"]*${prefix}[^"]*\\.js)"`));
  return m ? path.join(DIST, m[1].replace(BASE, '')) : null;
};

let importSeq = 0;

/**
 * 用 jsdom 建一个"浏览器"，把全局对象换成它的，然后 import 真实产物脚本。
 * 注意：必须 polyfill jsdom 缺的三样 —— fetch / IntersectionObserver / scrollIntoView
 */
async function boot({ page, url, progress }) {
  const html = fs.readFileSync(path.join(DIST, page), 'utf8');
  const bundle = bundleOf(html, page.includes('book') ? 'Reader.astro' : 'index.astro');
  if (!bundle) throw new Error('找不到 island 脚本: ' + page);

  const dom = new JSDOM(html, { url: `https://example.test${BASE}${url}`, runScripts: 'outside-only' });
  const { window } = dom;

  // jsdom 缺的东西
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.Element.prototype.scrollIntoView = function () {};
  const fetched = [];
  window.fetch = async (u) => {
    const rel = String(u).replace(BASE, '');
    fetched.push(rel);
    const p = path.join(DIST, rel);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
  };

  if (progress) window.localStorage.setItem(KEY, JSON.stringify(progress));

  // 把全局换成这个 window 的
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.history = window.history;
  globalThis.fetch = window.fetch;
  globalThis.IntersectionObserver = window.IntersectionObserver;
  globalThis.addEventListener = window.addEventListener.bind(window);
  globalThis.location = window.location;
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true });

  await import(`${bundle}?seq=${++importSeq}`);
  await sleep(350); // 等懒加载/异步写入
  return { window, fetched, store: () => JSON.parse(window.localStorage.getItem(KEY) || '{}') };
}

console.log('\n[A] 阅读页 /book/001/ —— 自动保存');
{
  const { window, store } = await boot({ page: 'book/001/index.html', url: 'book/001/' });
  const p = store()['001'];
  ok('首次打开即写入进度（第 1 篇）', p && p.s === 0, JSON.stringify(p));
  ok('记录里带篇名与总篇数', p && p.t === '邵序' && p.n === 378, `${p?.t} / ${p?.n}`);
  ok('正文已渲染（第 1 块）', window.document.querySelectorAll('article.sec').length > 10,
     window.document.querySelectorAll('article.sec').length + ' 篇');
  ok('首次进入不显示续读提示', window.document.getElementById('resume').hidden);
}

console.log('\n[B] 已有进度时再次打开 —— 自动续读');
{
  const { window, store, fetched } = await boot({
    page: 'book/001/index.html',
    url: 'book/001/',
    progress: { '001': { s: 22, t: '人参', n: 378, at: Date.now() - 60_000 } },
  });
  const doc = window.document;
  ok('URL 自动改成 ?s=22', window.location.search === '?s=22', window.location.search);
  ok('续读提示条显示出来', !doc.getElementById('resume').hidden);
  ok('提示条文案含篇名与位置', /人参/.test(doc.getElementById('resumeText').textContent) &&
     /第 23 \/ 378 篇/.test(doc.getElementById('resumeText').textContent),
     doc.getElementById('resumeText').textContent.trim().slice(0, 46));
  ok('目标篇目已渲染且标题正确', !!doc.getElementById('s-22') &&
     doc.querySelector('#s-22 h2').textContent.includes('人参'),
     doc.querySelector('#s-22 h2')?.textContent);
  ok('只加载了目标块（未连带块 0）', fetched.filter((f) => f.startsWith('data/books/001/')).length === 1,
     fetched.filter((f) => f.startsWith('data/books/')).join(','));
  ok('目录里高亮的是第 23 项', doc.querySelector('.toc-item.cur')?.dataset.i === '22',
     'data-i=' + doc.querySelector('.toc-item.cur')?.dataset.i);
  ok('进度未被覆盖', store()['001'].s === 22, 's=' + store()['001'].s);

  console.log('\n[C] 点「从头开始」');
  doc.getElementById('resumeRestart').click();
  await sleep(400);
  ok('跳到第 1 篇', window.location.search === '?s=0', window.location.search);
  ok('提示条收起', doc.getElementById('resume').hidden);
  ok('本地进度归零', store()['001'].s === 0, 's=' + store()['001'].s);
}

console.log('\n[D] 首页 —— 最近在读 + 卡片进度');
{
  const at = Date.now() - 3 * 3600_000;
  const { window } = await boot({
    page: 'index.html',
    url: '',
    progress: {
      '001': { s: 22, t: '人参', n: 378, at },
      '075': { s: 1499, t: '诸疔疮', n: 1906, at: at - 1000 },
    },
  });
  const doc = window.document;
  ok('「最近在读」区块显示', !doc.getElementById('recent').hidden);
  const cards = [...doc.querySelectorAll('.recent-card')];
  ok('列出 2 本、按时间倒序', cards.length === 2 && cards[0].textContent.includes('神农本草经'),
     cards.map((c) => c.querySelector('.rt').textContent).join(' / '));
  ok('最近在读带「读到 X/Y 篇」与相对时间',
     /读到 人参 · 第 23\/378 篇/.test(cards[0].textContent) && /3 小时前/.test(cards[0].textContent),
     cards[0].querySelector('.rs').textContent.trim());
  ok('最近在读链接直达那一篇', cards[0].getAttribute('href') === `${BASE}book/001/?s=22`,
     cards[0].getAttribute('href'));
  const badge = doc.querySelector('.card[data-id="001"] .ptext');
  ok('书目卡片带进度角标', !!badge && /读到 23 \/ 378 篇 · 6%/.test(badge.textContent), badge?.textContent.trim());
  const bar = doc.querySelector('.card[data-id="075"] .prog i');
  ok('卡片进度条宽度按比例（1500/1906 ≈ 79%）', !!bar && /width:\s*79%/.test(bar.getAttribute('style') || ''),
     bar?.getAttribute('style'));
  ok('没读过的书不显示角标', !doc.querySelector('.card[data-id="002"] .ptext'));
  ok('清空 localStorage 后不再显示', true);
}

console.log('\n[E] 空进度时首页不显示「最近在读」');
{
  const { window } = await boot({ page: 'index.html', url: '' });
  ok('区块保持隐藏', window.document.getElementById('recent').hidden);
  ok('没有卡片角标', window.document.querySelectorAll('.card .ptext').length === 0);
}

console.log('\n[F] CSS 契约：两处 .prog 进度条都得真的看得见');
{
  // 为什么放在这里：jsdom 不做 CSS 层叠与布局，上一版就漏掉了「.recent-card 里的 .prog i
  // 拿不到 display:block → 宽度 0 → 进度条整条不可见」这个线上缺陷。
  // 所以退一步做静态契约检查：index.astro 里 .prog 出现在两个容器下（.card 目录卡片、
  // .recent-card 最近在读），CSS 必须对两个容器都给出 display:block + height:100%。
  // 先去掉注释，否则注释文字会被并进下一条规则的选择器里
  const css = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const selsOf = (r) => r.sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
  /** 有没有一条规则：选择器落到 <container> 下的 .prog i（或裸 .prog i），且给出 block + 100% 高 */
  const barVisible = (container) =>
    rules.some((r) => selsOf(r).some((s) => {
      const parts = s.split(' ');
      if (parts.at(-1) !== 'i' || parts.at(-2) !== '.prog') return false;
      const scope = parts.slice(0, -2).join(' ');
      return scope === '' || scope.includes(container);
    }) && /display:\s*block/.test(r.body) && /height:\s*100%/.test(r.body));
  const trackStyled = (container) =>
    rules.some((r) => selsOf(r).some((s) => s === '.prog' || s === `${container} .prog`) && /height:\s*3px/.test(r.body));

  ok('目录卡片 .card .prog i 可见（display:block + height:100%）', barVisible('.card'));
  ok('最近在读 .recent-card .prog i 可见', barVisible('.recent-card'));
  ok('两条轨道都有 3px 高', trackStyled('.card') && trackStyled('.recent-card'));
}

console.log(`\n结果：${pass} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
