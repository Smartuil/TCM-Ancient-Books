/**
 * 构建期读取 scripts/build_data.py 生成的语料（public/data/）。
 * 只在 Node 侧（astro dev / astro build）执行，浏览器端拿不到也不需要。
 * 注意：用 process.cwd() 而不是 import.meta.url —— 打包后的 SSR 入口不在 src/ 下，
 * 相对路径会指向 dist/chunks/ 而找不到 public/。
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'public', 'data');

export interface Book {
  id: string;
  title: string;
  author: string;
  dynasty: string;
  year: string;
  tags: string[];
  format: 'tagged' | 'plain';
  src: string;
  chars: number;
  sections: number;
  chunks: number;
}

export interface Catalog {
  generated: string;
  source: string;
  count: number;
  chars: number;
  sections: number;
  books: Book[];
}

function read<T = any>(rel: string): T {
  const p = path.join(DATA, rel);
  if (!fs.existsSync(p)) {
    throw new Error(`缺少语料文件 ${rel}。请先跑：npm run data（本地开发用 npm run data:local）`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export const catalog = read<Catalog>('catalog.json');

/** 单本目录：[[篇名, 分类, 块号, 块内序号], ...] */
export const tocOf = (id: string): [string, string, number, number][] => read(`toc/${id}.json`);

export const tagCounts = (): [string, number][] => {
  const m = new Map<string, number>();
  for (const b of catalog.books) {
    for (const t of b.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
