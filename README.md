# 岐黄古籍 · 中医药古籍全文阅读站

**[🔖 在线站点 https://smartuil.github.io/TCM-Ancient-Books/](https://smartuil.github.io/TCM-Ancient-Books/)**

把 [xiaopangxia/TCM-Ancient-Books](https://github.com/xiaopangxia/TCM-Ancient-Books) 的 701 部中医古籍纯文本
（8,104 万字）编译成可检索、可竖排阅读的静态站。零后端、零数据库，全站跑在 GitHub Pages 上。

- Astro **7.3.5** 静态构建 · Node **>= 22.12**
- 构建产物：**703 个静态页**，构建耗时 **约 2.4 秒**；站点总产物 ~420 MB（< Pages 的 1 GB 上限）
- 检索：**篇名 148,197 条** + **全文 8,104 万字**（bigram 倒排，512 分片）
- 部署：push 到 `master` → GitHub Actions 自动「编译语料 → 建全文索引 → 构建 → 发布」，**全程约 5 分钟**

---

## 在线站点有什么

| 页面 | 内容 |
|---|---|
| [`/`](https://smartuil.github.io/TCM-Ancient-Books/) | 701 部典籍书目（编号 001–701），按序号／篇幅／朝代／作者排序，14 个分类筛选，书名·作者·朝代即时过滤（全部 SSG 成真 HTML，利于收录） |
| [`/search/`](https://smartuil.github.io/TCM-Ancient-Books/search/) | 两种模式：**篇名**跨书检索 148,197 条（药名、方名、证候、序跋）；**全文**检索 8,104 万字正文。支持 `?q=人参`、`?q=人参&m=full` 直达 |
| `/book/<id>/` | 阅读页：完整目录（按卷分组）+ 正文按块懒加载 + **竖排**（`writing-mode: vertical-rl`）+ 日夜 + 字号 + `[` `]` 翻篇 |

例：[《神农本草经》](https://smartuil.github.io/TCM-Ancient-Books/book/001/) ·
[《普济方》1906 篇 / 23 个正文块](https://smartuil.github.io/TCM-Ancient-Books/book/075/) ·
[《本草纲目》](https://smartuil.github.io/TCM-Ancient-Books/book/014/)

## 语料体检（实测，它决定了整个架构）

| 指标 | 数值 |
|---|---|
| 文本文件 | 701 个 `.txt`，171.5 MB |
| 编码 | **700 个 GB18030/GBK，1 个连 GB18030 都解不开**（`203-婴童类萃.txt`，需 `errors='replace'` 兜底） |
| 正文字数 | **81,045,114 字**（约 8,104 万字） |
| 篇目数 | **148,197 篇**（`<篇名>` 级） |
| 源格式 | 631 本带标签（`<篇名>` / `<目录>` / `内容：`），70 本无标签纯文本（中医瑰宝苑导出） |
| 单本最大 | 《普济方》492 万字 / 1,906 篇 / 23 个正文块 |
| 单本最小 | 2.2 KB（歌诀类） |
| 站点书号 | **001–701**（上游文件名从 `000-` 起，站点统一 +1 顺移；原始文件名保留在 catalog 的 `src` 字段里可追溯，如 `001 ← 000-神农本草经.txt`） |

**为什么不能用文档站框架直接吃 markdown**：148,197 篇 × 每页约 20 KB HTML ≈ **3 GB 产物**，
远超 GitHub Pages 的 1 GB 仓库建议上限，构建时间也会到小时级。
所以 VitePress / Docusaurus / Starlight / mdBook / Pagefind 这条路在这里全部不成立。

## 架构

```
构建期 Python（约 2 分钟）           构建期 Astro（约 2.4 秒）             运行期（浏览器）
700 本 GB18030 txt ──► public/data/ ──► 703 个静态页 ──────────────► 按块取正文
  · catalog.json   0.14 MB  书目        · /             首页（701 卡片 SSG）
  · authors.json   0.02 MB  作者        · /search/      篇名检索
  · toc/<id>.json  7.18 MB  每本目录    · /book/<id>/   目录 SSG + 阅读器 island
  · books/<id>/<n>.json 246 MB  分块正文
  · search/titles-*.json 3.84 MB  篇名索引（8 分片）
  · fts/<k>.json   147 MB   全文索引（bigram 倒排，512 分片，gzip 65 MB）
```

**四条关键设计**

1. **目录 SSG，正文 island。** 每本书的完整目录在构建期渲染成真链接（SEO 友好、无 JS 也能读、首屏立刻可见），
   正文由 island 按块拉取。首屏 ≈ 目录 20–30 KB + 第一块正文（gzip 约 190 KB）。
2. **分块占位架构。** 每本书的正文块在 DOM 里先占好座位，块顺序天然正确。
   跳到第 1500 篇只加载目标块（实测只请求 1 个 JSON、**1.2 秒到位**），不会白白下载前面 5 MB；
   未载入的块显示「第 X–Y 篇尚未载入 · 载入这一块」，点一下就能补。
3. **自动续载用「滚动停稳 + 最近优先」，不用 IntersectionObserver。**
   占位条只有几十像素高，用 IO 会让几十个占位同时落进观察带 —— 实测一打开《普济方》就并发拉下 1,308 篇。
   改成滚动停稳后载入离视口中心最近的未载入块，正常阅读、拖到底、深跳后回滚三种情形都对。
4. **gzip 是主要成本杠杆。** 正文块 599 KB → **194 KB**（32%），catalog 143 KB → 26 KB。
   打开任意一本书的首屏流量 ≈ 200 KB。
5. **阅读进度存在浏览器本地，没有账号系统。** 读到哪一篇自动写进 `localStorage`
   （键 `qhguji:progress:v1`，按书号索引，超 300 本按时间淘汰最旧的）。
   再次打开同一本书会自动续读到上次的位置，并给一条可关闭的提示条 +「从头开始」按钮；
   首页顶部出现「最近在读」卡片，书目卡片上带进度条。**不上传任何数据、不埋点。**
   相关代码：`src/lib/progress.ts`（纯函数，可单测）。
6. **全文检索用 bigram 倒排，不用分词词典。** 中文没有词边界，二元组最省事：
   只索引「汉字+汉字」相邻对、同一篇去重（古籍术语高度重复，这一步把倒排压掉一大截），
   再按 `fnv1a(bigram) % 512` 分片 —— **查两字词只取 1 片（gzip ~130 KB）**，
   四字词 ≤3 片（~380 KB），片有缓存。实测索引 147 MB（gzip 65 MB）/ 36,382,153 条，
   与暴力扫描逐词比对**零漏召回**（bigram 交集只会多、不会少）。相关代码：`src/lib/fts.ts`。

## 本地开发

需要 **Python 3**（语料编译，无第三方依赖）和 **Node >= 22.12**。

```bash
npm install

# 1) 把 701 本 GB18030 txt 编译成 public/data/*.json（约 2 分钟，产物 258 MB，已 gitignore）
npm run data            # = python3 scripts/build_data.py --src . --out public/data

# 2) 开发 / 构建
npm run dev             # http://localhost:4321/TCM-Ancient-Books/（base 前缀是必须的）
npm run build           # 产物在 dist/：703 页，约 2.4 秒
npm run preview
# 3) 全文检索索引（bigram 倒排 + 512 分片，约 2 分钟，147 MB）
npm run data:index      # = python3 scripts/build_index.py --shards 512

npm test                # 单测：进度模块 10 条 + 全文检索 27 条（都无需浏览器）
```

若本地 txt 不在仓库根目录，用 `npm run data:local`（指向 `../books`）。

`public/data/` 不存在时构建会明确报错并提示先跑 `npm run data`。

## 部署

**已经部署好了**，站点：<https://smartuil.github.io/TCM-Ancient-Books/>

更新流程就是 `git push`：

```
push → actions/checkout → Compile corpus（2 分钟）→ setup-node 22 → npm ci → npm run build → deploy-pages
```

最近两次 CI：`143 s / success`、`148 s / success`。

一次性设置（本仓库已完成）：**Settings → Pages → Build and deployment → Source = GitHub Actions**
（对应 API 状态 `build_type: workflow`）。

> 编译产物 258 MB **不入库**（`.gitignore` 里的 `public/data/`）。
> 所以本仓库相对上游只多 **17 个文件 / 198 KB** 代码，CI 每次现编译换来仓库干净。

## 目录结构

```
├─ *.txt                        上游 701 本古籍原文（一字未改，md5 与上游 701/701 一致）
├─ scripts/build_data.py        语料编译器：GB18030 → JSON（纯 stdlib Python）
├─ scripts/build_index.py       全文索引编译器：bigram 倒排 + 分片（纯 stdlib Python）
├─ src/
│  ├─ data.ts                   构建期读取 public/data（用 process.cwd()，别用 import.meta.url）
│  ├─ paths.ts                  base 前缀归一化（Astro 的 BASE_URL 不带结尾斜杠，是个坑）
│  ├─ layouts/Base.astro        主题 / 字号 / 竖排的首屏还原脚本（防闪动）
│  ├─ lib/progress.ts           阅读进度的本地存取（纯函数，可单测）
│  ├─ lib/fts.ts                全文检索的客户端实现（切词/取片/求交，与 Python 端规则必须一致）
│  ├─ components/Reader.astro   阅读器 island：分块占位 + 最近优先续载 + 竖排/日夜/字号 + 进度自动保存
│  ├─ pages/index.astro         首页：701 卡片 SSG + 客户端过滤排序
│  ├─ pages/search.astro        篇名全站检索：8 分片流式加载 + 高亮
│  ├─ pages/book/[id].astro     阅读页：目录 SSG + island
│  └─ styles/global.css         古籍视觉：宣纸 #f7f2e6 / 墨 #2a2118 / 朱砂 #9c2c1f
├─ tests/                       单测：progress.test.mjs、fts.test.mjs（用真索引跑）
├─ public/                      favicon.svg、.nojekyll、data/（编译产物）
└─ .github/workflows/pages.yml
```

## 检索能力（v1 范围）

| 方式 | 实现 | 实测 |
|---|---|---|
| 书名 / 作者 / 朝代 | `catalog.json`，纯前端即时过滤 | 零等待 |
| 分类筛选 | 构建期按书名关键词归类（本草、方书、伤寒金匮、针灸、医案……14 类） | 伤寒金匮 57 部 |
| **篇名全站检索** | `search/titles-*.json` 8 分片，首次输入才并发拉取，**边到边出结果** | 索引 gzip 合计 1.18 MB；载入+解析 107 ms、单次检索 15–42 ms；线上首屏出结果约 2.5 s |
| 单书内查找 | 阅读页侧栏即时过滤本书篇名 | — |
| **阅读进度** | `localStorage` 按书号记录篇序号 + 篇名 + 时间，自动保存/自动续读，无后端 | 键 `qhguji:progress:v1`，超 300 本按时间淘汰 |
| **全文检索**（v2） | bigram 倒排 + 512 分片，客户端取片求交集；命中落到「书名 · 第 N/M 篇」，跳过去自动高亮 | 人参 23,616 篇 / 甘草 34,303 篇 / 太阳病 2,380 篇；单次查 1–3 片 124–379 KB gzip |

命中示例：「人参」515 篇、「甘草」570 篇、「伤寒」1677 篇、「四物汤」98 篇。结果限 300 条，前缀命中优先 + 短标题优先。

## 改东西时注意

- **换仓库名 / 换域名**：只改 `astro.config.mjs` 里的 `site` 和 `base` 两行，
  其余链接全部走 `src/paths.ts` 的 `BASE`（`BASE_URL` 不带结尾斜杠，别自己拼）。
- **GitHub Pages 项目站点下，所有运行期 `fetch` 都要带 base 前缀**，否则会 404。
- **字体想要更像古籍**：把 `--serif` / `--kai` 换成自托管的
  [霞鹜文楷 LXGW WenKai](https://github.com/lxgw/LxgwWenKai)（OFL）+ 思源宋体 woff2 子集
  （`fonttools pyftsubset`）。别直接挂 Google Fonts，国内不稳。
- 上游自带两个垃圾文件（`290-外科证治全书.txt.baiduyun.downloading*`）是历史遗留，
  不以 `.txt` 结尾，编译器会跳过；为保持与上游一致没有删除。

## 路线图

- ✅ **v1（已上线）**：书目 SSG + 篇名/作者检索 + 分块阅读器 + 竖排
- ✅ **阅读进度**：本地自动保存 / 自动续读 / 最近在读 / 卡片进度条（无账号、无后端）
- ✅ **v2（已上线）**：全站**全文**检索 —— bigram 倒排 + 512 分片，零漏召回，单次查询 124–379 KB
- ⬜ 旧设想（已被上面的实现取代）：全站**全文**检索（8,104 万字）。Pagefind 只吃已生成的 HTML，吃 JSON 会让索引膨胀到几百 MB；
  更实际的做法是 Python 预生成 **bigram 倒排 + 分片**按需拉取，或外挂 Meilisearch / Cloudflare Worker（此时已不是纯静态）
- ⬜ 可选：自托管字体（霞鹜文楷）、书目 OCR 校勘标注、进度跨设备同步（需要账号，暂不做）

## 上游与许可

古籍原文来自 [xiaopangxia/TCM-Ancient-Books](https://github.com/xiaopangxia/TCM-Ancient-Books)。
本仓库是它的 fork：**701 本 txt 原文一字未改**，只在上游基础上新增了上面的构建与站点代码
（上游那份两行的 README 已被本文档替换）。代码以 MIT 发布；古籍文本本身属于公有领域，
具体使用请自行核对上游说明。
