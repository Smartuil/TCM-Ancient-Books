/**
 * 部署路径前缀（GitHub Pages 项目站点跑在 /<repo>/ 下）。
 *
 * 坑：astro.config 里写 base: '/TCM-Ancient-Books' 时，
 * import.meta.env.BASE_URL 是 **不带结尾斜杠** 的 '/TCM-Ancient-Books'，
 * 直接 `${BASE}data/x.json` 会拼成 '/TCM-Ancient-Booksdata/x.json'。
 * 所有手写链接都从这一个地方取 base，避免各写各的。
 */
const raw = import.meta.env.BASE_URL || '/';
export const BASE = raw.endsWith('/') ? raw : raw + '/';
