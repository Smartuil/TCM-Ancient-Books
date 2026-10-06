/**
 * 阅读进度的本地存储。
 *
 * 纯客户端：所有数据只写在浏览器的 localStorage 里，不上传、不埋点、没有后端。
 * 每条记录 = { 篇序号, 篇名, 总篇数, 时间戳 }，按书号索引。
 */

export interface Progress {
  /** 篇序号，0 起 */
  s: number;
  /** 篇名，用于在首页/续读提示里展示 */
  t: string;
  /** 总篇数，用来算百分比 */
  n: number;
  /** 最后阅读时间戳 */
  at: number;
}

const KEY = 'qhguji:progress:v1';
const MAX_BOOKS = 300; // 只保留最近读的若干部，避免 localStorage 无限长

type Store = Record<string, Progress>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Store) : {};
  } catch {
    return {}; // 隐私模式 / 数据被改坏 —— 静默降级，不影响阅读
  }
}

function writeAll(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 配额满或隐私模式：忽略 */
  }
}

export function getProgress(id: string): Progress | undefined {
  return readAll()[id];
}

export function saveProgress(id: string, p: Progress) {
  const s = readAll();
  s[id] = p;
  const keys = Object.keys(s);
  if (keys.length > MAX_BOOKS) {
    keys
      .sort((a, b) => (s[a].at || 0) - (s[b].at || 0))
      .slice(0, keys.length - MAX_BOOKS)
      .forEach((k) => delete s[k]);
  }
  writeAll(s);
}

export function clearProgress(id: string) {
  const s = readAll();
  delete s[id];
  writeAll(s);
}

/** 最近在读，按时间倒序 */
export function recentProgress(limit = 4): [string, Progress][] {
  return Object.entries(readAll())
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, limit);
}

export function allProgress(): Store {
  return readAll();
}

export function percent(p: Progress): number {
  if (!p.n) return 0;
  return Math.max(1, Math.min(100, Math.round(((p.s + 1) / p.n) * 100)));
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 5 天前 / 2026-10-05 */
export function ago(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const m = d / 60000;
  if (m < 1) return '刚刚';
  if (m < 60) return `${Math.floor(m)} 分钟前`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} 小时前`;
  const day = Math.floor(h / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
