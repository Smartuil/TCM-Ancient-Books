# 岐黄古籍 · 中医药古籍全文阅读站

把 [xiaopangxia/TCM-Ancient-Books](https://github.com/xiaopangxia/TCM-Ancient-Books)（700 部中医古籍纯文本）
编译成可检索、可竖排阅读的静态站，部署在 GitHub Pages。

**站点地址（fork 后）**：`https://<你的用户名>.github.io/TCM-Ancient-Books/`

---

## 它长什么样

| 页面 | 说明 |
|---|---|
| `/` 首页 | 701 部典籍，按序号／篇幅／朝代／作者排序，14 个分类筛选，书名·作者·朝代即时检索 |
| `/search/` 篇名全站检索 | 148,197 个篇目条目（药名、方名、证候、序跋）跨书检索，支持 `?q=` 直达 |
| `/book/<id>/` 阅读页 | 完整目录（按卷分组）+ 正文分块懒加载 + 竖排 + 日夜 + 字号 + `[` `]` 翻篇 |

## 架构：为什么不是普通的文档站

语料体检结果决定了架构：

| 指标 | 实测 |
|---|---|
| 文本文件 | 701 个，171.5 MB，**700 个 GB18030 / 1 个含非法字节** |
| 正文字数 | **8,104 万字** |
| 篇目数 | **148,197 篇** |
| 单本最大 | 《普济方》492 万字 / 1,906 篇 / 23 个正文块 |

一页一篇 = 148,197 页 × ~20 KB ≈ **3 GB 产物**，Pagefind / VitePress / Docusaurus 这类
"文档站框架直接吃 markdown"的路子在这里全都不成立。所以：

```
构建期（Python，~2 分钟）              构建期（Astro，~2.5 秒）              运行期（浏览器）
700 本 GB18030 txt  ──►  public/data/  ──►  703 个静态页 + 内联 island  ──►  按块取正文
  · catalog.json  143 KB   书目          · /            首页（701 卡片 SSG）
  · toc/<id>.json 7.2 MB   每本目录      · /search/     检索页
  · books/<id>/<n>.json    正文分块      · /book/<id>/  目录 SSG + 阅读器 island
  · search/titles-*.json   篇名索引
```

**关键设计**

1. **目录 SSG，正文 island**：每本书的完整目录在构建期渲染成真 HTML（SEO 友好、无 JS 也能读、首屏立刻可见），
   正文由 island 按块拉取。首屏 ≈ 目录 20–30 KB + 第 1 块正文。
2. **分块占位架构**：每本书的正文块在 DOM 里先占好座位，跳转（如从检索结果跳到第 1500 篇）只加载目标块，
   不会白白下载前面 5 MB；缺的块显示「第 X–Y 篇尚未载入 · 载入这一块」。
3. **自动续载用「最近优先」而不是 IntersectionObserver**：占位条只有几十像素高，
   用 IO 会让几十个占位同时落进观察带 —— 实测一打开《普济方》就并发拉下 1,308 篇。
   改成滚动停稳后载入离视口中心最近的未载入块，正常阅读、拖到底、深跳后回滚三种情形都对。
4. **脚本体积**：island 只有几 KB，`_astro/` 里只有一个 CSS + 一个阅读器脚本。

## 本地开发

```bash
# 1. 语料编译：把 700 本 GB18030 txt 编译成 JSON（约 2 分钟，产物 254 MB，已 gitignore）
npm run data:local      # 等价于 python3 scripts/build_data.py --src ../books --out public/data
                        # 仓库里 txt 都在根目录时用：npm run data

# 2. 开发 / 构建
npm install
npm run dev             # http://localhost:4321/TCM-Ancient-Books/
npm run build           # 产物在 dist/（703 页，约 2.5 秒；需要 Node >= 22.12）
npm run preview
```

`public/data/` 不存在时构建会明确报错提示先跑 `npm run data`。

## 部署到 GitHub Pages

仓库已配好 `.github/workflows/pages.yml`：push 到 `master`/`main` 后自动
「编译语料 → Astro 构建 → 发布 Pages」，全程约 3–5 分钟。

一次性设置：仓库 **Settings → Pages → Build and deployment → Source = GitHub Actions**。

> 语料编译产物 254 MB 不入库（`.gitignore` 里是 `public/data/`），
> 所以你的 fork 只比上游多几十 KB 代码。CI 每次重新编译（2 分钟），换来仓库干净。

## 目录结构

```
├─ *.txt                    上游 701 本古籍原文（未改动）
├─ scripts/build_data.py    语料编译器：GB18030 → JSON（纯 Python，无依赖）
├─ src/
│  ├─ data.ts               构建期读取 public/data（用 process.cwd()，别用 import.meta.url）
│  ├─ paths.ts              base 前缀归一化（Astro 的 BASE_URL 不带结尾斜杠，是个坑）
│  ├─ layouts/Base.astro    主题/字号/竖排的首屏还原脚本
│  ├─ components/Reader.astro  自研阅读器 island（分块占位 + 最近优先续载）
│  ├─ pages/index.astro     首页（701 卡片 SSG + 客户端过滤排序）
│  ├─ pages/search.astro    篇名全站检索
│  ├─ pages/book/[id].astro 阅读页（目录 SSG + island）
│  └─ styles/global.css     古籍视觉：宣纸 / 墨 / 朱砂
├─ public/                  favicon、.nojekyll、data/（编译产物）
└─ .github/workflows/pages.yml
```

## 改东西时注意

- **换仓库名 / 换域名**：只改 `astro.config.mjs` 里的 `site` 和 `base` 两行，
  其余链接全部走 `src/paths.ts` 的 `BASE`。
- **字体想要更像古籍**：把 `--serif` / `--kai` 换成自托管的
  [霞鹜文楷 LXGW WenKai](https://github.com/lxgw/LxgwWenKai)（OFL）和思源宋体 woff2 子集
  （`fonttools pyftsubset`），别直接挂 Google Fonts（国内不稳）。
- **想要全站全文检索（v2）**：Pagefind 只吃已生成的 HTML，吃 JSON 会让索引膨胀到几百 MB。
  更实际的是 Python 预生成 bigram 倒排 + 分片按需拉取，或外挂 Meilisearch / Cloudflare Worker。

## 上游与许可

古籍原文来自 [xiaopangxia/TCM-Ancient-Books](https://github.com/xiaopangxia/TCM-Ancient-Books)（MIT），
本站代码同样以 MIT 发布。古籍文本本身属于公有领域，请自行核对原站说明。
