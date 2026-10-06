/**
 * 全站全文检索（客户端）。
 *
 * 索引由 scripts/build_index.py 生成：bigram 倒排 + 按 fnv1a(bigram) % 512 分片。
 * 本文件里的 bigramsOf / fnv1a / 分片规则必须与那个 Python 脚本**完全一致**，
 * 否则会查不到东西（tests/fts.test.mjs 会拿真索引校验这一点）。
 *
 * 成本：查一个两字词只取 1 片（gzip ~130 KB），四字词取 ≤3 片（~380 KB），片有缓存。
 */

export interface FtsManifest {
  v: number;
  shards: number;
  docs: number;
  bigrams: number;
  postings: number;
  offsets: number[]; // 每本书的起始篇号，末尾多一个哨兵
  books: string[]; // 书号，按顺序
  rule: string;
}

export interface FtsHit {
  doc: number; // 全局篇号
  book: string; // 书号
  section: number; // 书内篇序号（0 起）
}

// 与 build_index.py 的 CJK_RANGES 一致（都属 BMP，故 Python 码点 == JS 码元）
const isCJK = (cp: number) =>
  (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);

/** 相邻两字皆为汉字的二元组（与 Python 端同规则） */
export function bigramsOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let prev = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (prev && isCJK(prev.codePointAt(0)!) && isCJK(cp)) {
      const g = prev + ch;
      if (!seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    }
    prev = ch;
  }
  return out;
}

/** FNV-1a 32 位（与 Python 端同实现） */
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

/** 把 "差值,差值,…" 解回递增的篇号数组 */
export function decodeDeltas(s: string): Int32Array {
  const parts = s.split(',');
  const out = new Int32Array(parts.length);
  let prev = 0;
  for (let i = 0; i < parts.length; i++) {
    prev += +parts[i];
    out[i] = prev;
  }
  return out;
}

const manifestCache = new Map<string, Promise<FtsManifest>>();
export function getManifest(base: string): Promise<FtsManifest> {
  if (!manifestCache.has(base)) {
    manifestCache.set(
      base,
      fetch(`${base}data/fts/manifest.json`).then((r) => r.json())
    );
  }
  return manifestCache.get(base)!;
}

const shardCache = new Map<string, Promise<Map<string, Int32Array>>>();
export function loadShard(base: string, k: number): Promise<Map<string, Int32Array>> {
  const key = `${base}|${k}`;
  if (!shardCache.has(key)) {
    shardCache.set(
      key,
      fetch(`${base}data/fts/${k}.json`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: [string, string, number][]) => {
          const m = new Map<string, Int32Array>();
          for (const [g, deltas] of rows) m.set(g, decodeDeltas(deltas));
          return m;
        })
    );
  }
  return shardCache.get(key)!;
}

/** 全局篇号 → (书号, 书内篇序号)：在 offsets 里二分 */
export function docToBook(man: FtsManifest, doc: number): { book: string; section: number } | null {
  const o = man.offsets;
  let lo = 0;
  let hi = o.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (o[mid] <= doc) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= man.books.length) return null;
  return { book: man.books[lo], section: doc - o[lo] };
}

export interface FtsResult {
  hits: FtsHit[];
  total: number;
  shards: number[]; // 这次实际抓取的分片（已缓存的会命中缓存）
  fetched: number; // 其中需要真正下载的片数
  ms: number;
}

/**
 * 全文检索。单个汉字没有 bigram，无法用本索引回答（UI 需提示至少两个字）。
 */
export async function searchFullText(base: string, query: string, limit = 200): Promise<FtsResult> {
  const t0 = Date.now();
  const man = await getManifest(base);
  const gs = bigramsOf(query);
  if (!gs.length) return { hits: [], total: 0, shards: [], fetched: 0, ms: Date.now() - t0 };

  const shardIds = [...new Set(gs.map((g) => fnv1a(g) % man.shards))].sort((a, b) => a - b);
  const fetched = shardIds.filter((k) => !shardCache.has(`${base}|${k}`)).length;
  const maps = await Promise.all(shardIds.map((k) => loadShard(base, k)));

  const byShard = new Map<number, Map<string, Int32Array>>();
  shardIds.forEach((k, i) => byShard.set(k, maps[i]));

  const lists: Int32Array[] = [];
  for (const g of gs) {
    const lst = byShard.get(fnv1a(g) % man.shards)?.get(g);
    if (!lst) return { hits: [], total: 0, shards: shardIds, fetched, ms: Date.now() - t0 };
    lists.push(lst);
  }
  lists.sort((a, b) => a.length - b.length);

  let acc: Int32Array = lists[0];
  for (let i = 1; i < lists.length && acc.length; i++) {
    const other = lists[i];
    const out = new Int32Array(Math.min(acc.length, other.length));
    let a = 0, b = 0, n = 0;
    while (a < acc.length && b < other.length) {
      const x = acc[a], y = other[b];
      if (x === y) { out[n++] = x; a++; b++; }
      else if (x < y) a++;
      else b++;
    }
    acc = out.subarray(0, n) as Int32Array;
  }

  const total = acc.length;
  const hits: FtsHit[] = [];
  for (let i = 0; i < acc.length && hits.length < limit; i++) {
    const r = docToBook(man, acc[i]);
    if (r) hits.push({ doc: acc[i], ...r });
  }
  return { hits, total, shards: shardIds, fetched, ms: Date.now() - t0 };
}
