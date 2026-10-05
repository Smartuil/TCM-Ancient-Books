#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 TCM-Ancient-Books 的 700 本 GB18030 纯文本，编译成静态站点可直接消费的 JSON 数据。

输出（默认 site/data/）：
  catalog.json              书目索引：书名 / 作者 / 朝代 / 字数 / 篇数 / 分块数
  toc/<id>.json             目录：[篇名, 分类, 块号, 块内序号]
  books/<id>/<n>.json       正文分块（每块 <= MAX_CHUNK_BYTES）

两种源格式都能吃：
  A. tagged  —— <篇名>xxx / <目录>卷X / 内容：...   （631 本）
  B. plain   —— 中医瑰宝苑导出的纯文本，短行即标题  （70 本）

用法:
  python3 scripts/build_data.py [--src books] [--out site/data]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter

MAX_CHUNK_BYTES = 600_000  # 单个正文块的目标上限（gzip 后约 180KB）
SHARDS = 8                  # 篇名检索索引分片数（每片 raw ~900KB / gzip ~180KB）
ENCODINGS = ("utf-8-sig", "utf-8", "gb18030")

# 标签行
RE_TAG = re.compile(r"^<([^<>\n]{1,12})>\s*(.*)$")
META_KEYS = ("书名", "作者", "朝代", "年份")
# 正文里出现的、需要丢掉的行
RE_JUNK = re.compile(r"^(?:-{4,}|={4,}|<目录>|中医瑰宝苑\s*$|瑰宝苑\s*$)")
# 句读：出现这些字符基本可以断定是正文而不是标题
SENT_PUNCT = set("。！？；，、：…—～·“”‘’（）《》〈〉【】%,.;:!?\"'()[]")
RE_FOOTNOTE = re.compile(r"^\(\d+\)|^［\d+］")
# 源库里每段开头的字段名（“内容：”“属性：”…），渲染时不需要
RE_FIELD = re.compile(r"^(?:内容|属性|组成|用法|主治|功效|摘录|别名|来源|出处|"
                      r"备注|说明|附注|原方|方名|处方|用法用量)\s*[：:]\s*")
RE_TITLE_JUNK = re.compile(r"(?<=[\u4e00-\u9fff])[A-Za-z0-9]{1,6}$")


# 目录用的粗分类：按书名关键词命中，最多两个
TAGS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("针灸", ("针灸", "甲乙经", "灸", "铜人", "穴位", "明堂", "针经", "经络")),
    ("伤寒金匮", ("伤寒", "金匮", "长沙")),
    ("本草", ("本草", "药性", "药征", "药鉴", "炮炙", "药材", "滇南")),
    ("方书", ("方论", "良方", "验方", "秘方", "奇方", "丹方", "局方", "普济", "圣惠",
              "圣济", "医方", "要方", "翼方", "济生", "本事方", "备急方", "千金", "方")),
    ("医案", ("医案", "类案", "案", "按")),
    ("诊法", ("脉", "诊", "舌", "望色")),
    ("儿科", ("幼", "婴", "小儿", "童")),
    ("妇科", ("妇科", "妇人", "女科", "产", "胎")),
    ("外科", ("外科", "疡", "疮", "痔", "跌打", "正骨", "伤科", "救伤")),
    ("五官", ("眼", "目", "喉", "口齿", "鼻科", "眼科")),
    ("养生食疗", ("养生", "摄生", "延年", "导引", "修真", "食疗", "饮膳", "食鉴",
                  "服气", "颐生", "寿世")),
    ("医经", ("内经", "素问", "灵枢", "难经", "黄帝", "医经", "运气", "神农本草经")),
    ("医论医话", ("医论", "医话", "医述", "医贯", "医原", "医略", "医学", "医门",
                  "医宗", "全书", "总录", "大成", "心悟", "心得")),
)


def tags_of(title: str) -> list[str]:
    t = title.replace("《", "").replace("》", "")
    out = [name for name, kws in TAGS if any(k in t for k in kws)]
    return out[:2] or ["其他"]


def decode(raw: bytes) -> tuple[str, str]:
    """返回 (文本, 编码名)。逐级降级，最后用 replace 兜底，保证 700 本全过。"""
    for enc in ENCODINGS:
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("gb18030", errors="replace"), "gb18030(replace)"


def clean_line(s: str) -> str:
    return s.replace("\u3000", " ").replace("\xa0", " ").rstrip()


def paragraphs_from_lines(lines: list[str]) -> list[str]:
    """源文本每行都是一个软换行（行尾留空格），连续非空行合成一段。"""
    out: list[str] = []
    buf: list[str] = []
    for ln in lines:
        if ln.strip():
            buf.append(ln.strip())
        elif buf:
            out.append("".join(buf))
            buf = []
    if buf:
        out.append("".join(buf))
    # 去掉源文件里的脚注编号 / 空白段
    res = []
    for p in out:
        p = p.strip()
        if not p or RE_JUNK.match(p):
            continue
        p = RE_FIELD.sub("", p).strip()
        if p:
            res.append(p)
    return res


def parse_tagged(text: str, fallback_title: str) -> tuple[str, dict, list[dict]]:
    lines = [clean_line(l) for l in text.splitlines()]
    title, meta = fallback_title, {}
    cur_cat, secs = "", []
    in_head = True  # 头部还没进入正文

    for ln in lines:
        if not ln.strip():
            continue
        m = RE_TAG.match(ln)
        if m:
            tag, val = m.group(1), m.group(2).strip()
            if tag == "篇名":
                if in_head and not secs:
                    title = val or fallback_title
                    in_head = False
                    secs.append({"t": val or title, "c": "", "raw": []})
                    continue
                secs.append({"t": val, "c": cur_cat, "raw": []})
            elif tag == "目录":
                if val:
                    cur_cat = val.replace("\\", "／")
                    if secs:
                        secs[-1]["c"] = cur_cat
                else:
                    in_head = False
            continue
        for k in META_KEYS:
            if ln.startswith(k + "：") or ln.startswith(k + ":"):
                meta[k] = ln.split("：", 1)[-1].split(":", 1)[-1].strip()
                ln = ""
                break
        if not ln or RE_JUNK.match(ln):
            continue
        if secs:
            secs[-1]["raw"].append(ln)
    if secs:
        secs[0]["t"] = title  # 首个 <篇名> 是书名，不是篇名
        secs[0]["raw"] = [l for l in secs[0]["raw"] if not any(
            l.startswith(k + "：") for k in META_KEYS)]
    return title, meta, secs


def looks_like_heading(s: str) -> bool:
    t = s.strip(" *_#　")
    if not t or len(t) > 18:
        return False
    if any(ch in SENT_PUNCT for ch in t):
        return False
    return True


def parse_plain(text: str, fallback_title: str) -> tuple[str, dict, list[dict]]:
    lines = [clean_line(l) for l in text.splitlines()]
    title, meta = fallback_title, {}
    # 1) 头部书名：把“中医瑰宝苑/瑰宝苑”前缀剥掉
    head_idx = 0
    for i, ln in enumerate(lines[:8]):
        if ln.strip():
            head_idx = i
            break
    head = lines[head_idx].strip()
    head = re.sub(r"^(?:中医)?瑰宝苑", "", head).strip(" 　|-_")
    if not head and head_idx + 1 < len(lines):
        head = lines[head_idx + 1].strip()
    if head and len(head) <= 30 and not any(c in SENT_PUNCT for c in head):
        title = RE_TITLE_JUNK.sub("", head).strip() or fallback_title
    body = lines[head_idx + 1:]

    # 2) 作者/朝代行
    for ln in body[:12]:
        for k in META_KEYS:
            if ln.startswith(k + "："):
                meta[k] = ln.split("：", 1)[1].strip()

    # 3) 断篇：前后都是空行的短行 = 标题
    secs: list[dict] = [{"t": title, "c": "", "raw": []}]
    for i, ln in enumerate(body):
        if RE_JUNK.match(ln):
            continue
        if any(ln.startswith(k + "：") for k in META_KEYS):  # 元信息不进正文
            continue
        if len(ln.strip()) <= 6 and not re.search(r"[\u4e00-\u9fff]", ln):  # 'er' 'yi' 之类导出噪声
            continue
        prev_blank = (i == 0) or (not body[i - 1].strip())
        nxt_blank = (i == len(body) - 1) or (not body[i + 1].strip())
        if prev_blank and looks_like_heading(ln) and (nxt_blank or len(ln.strip()) <= 12):
            if secs[-1]["raw"]:  # 上一节有内容才开新节，避免连续标题
                secs.append({"t": ln.strip(" *_#　"), "c": "", "raw": []})
            continue
        if ln.strip():
            secs[-1]["raw"].append(ln)
    return title, meta, secs


def build(src: str, out: str) -> dict:
    files = sorted(f for f in os.listdir(src) if f.lower().endswith(".txt"))
    books_dir = os.path.join(out, "books")
    toc_dir = os.path.join(out, "toc")
    os.makedirs(books_dir, exist_ok=True)
    os.makedirs(toc_dir, exist_ok=True)

    catalog, stats = [], Counter()
    titles: list[list] = []  # 全局篇名索引：[书号(int|str), 篇序号, 篇名]
    used_ids: set[str] = set()
    t0 = time.time()

    for fn in files:
        stem = os.path.splitext(fn)[0]
        m = re.match(r"^\s*(\d+)\s*[-_.．、·]\s*(.*)$", stem)  # 既吃 000-书名，也吃 700.书名
        if m:
            bid, fallback = m.group(1).zfill(3), m.group(2).strip()
        else:  # 没有任何编号前缀：用文件名兜底，并保证 URL 安全
            bid, fallback = re.sub(r"[^0-9A-Za-z_-]", "", stem[:8]) or "x", stem.strip()
        while bid in used_ids:  # 极小概率的编号碰撞
            bid += "b"
        used_ids.add(bid)
        raw = open(os.path.join(src, fn), "rb").read()
        text, enc = decode(raw)
        stats[("enc", enc)] += 1

        if "<篇名>" in text:
            title, meta, secs = parse_tagged(text, fallback)
            fmt = "tagged"
        else:
            title, meta, secs = parse_plain(text, fallback)
            fmt = "plain"

        sections, chars, toc, chunk, chunk_no, cbytes = [], 0, [], [], 0, 2
        for s in secs:
            paras = paragraphs_from_lines(s["raw"])
            if not paras:
                continue
            c = sum(len(p) for p in paras)
            chars += c
            idx = len(chunk)
            chunk.append({"t": s["t"], "c": s["c"], "p": paras})
            toc.append([s["t"], s["c"], chunk_no, idx])
            cbytes = len(json.dumps(chunk, ensure_ascii=False).encode())
            if cbytes > MAX_CHUNK_BYTES:
                d = os.path.join(books_dir, bid)
                os.makedirs(d, exist_ok=True)
                json.dump(chunk, open(os.path.join(d, f"{chunk_no}.json"), "w"),
                          ensure_ascii=False, separators=(",", ":"))
                chunk, chunk_no = [], chunk_no + 1
        if chunk:
            d = os.path.join(books_dir, bid)
            os.makedirs(d, exist_ok=True)
            json.dump(chunk, open(os.path.join(d, f"{chunk_no}.json"), "w"),
                      ensure_ascii=False, separators=(",", ":"))
            chunk_no += 1
        if not toc:
            stats["empty"] += 1
            continue

        json.dump(toc, open(os.path.join(toc_dir, f"{bid}.json"), "w"),
                  ensure_ascii=False, separators=(",", ":"))
        if bid.isdigit():
            titles.extend([int(bid), i, x[0]] for i, x in enumerate(toc))
        catalog.append({
            "id": bid, "title": title or fallback,
            "author": meta.get("作者", ""), "dynasty": meta.get("朝代", ""),
            "year": meta.get("年份", ""), "tags": tags_of(title or fallback),
            "format": fmt, "src": fn,
            "chars": chars, "sections": len(toc), "chunks": chunk_no,
        })
        stats["books"] += 1
        stats["chars"] += chars
        stats["sections"] += len(toc)

    catalog.sort(key=lambda b: b["id"])
    out_catalog = {
        "generated": time.strftime("%Y-%m-%d"),
        "source": "https://github.com/xiaopangxia/TCM-Ancient-Books",
        "count": len(catalog), "chars": stats["chars"], "sections": stats["sections"],
        "books": catalog,
    }
    json.dump(out_catalog, open(os.path.join(out, "catalog.json"), "w"),
              ensure_ascii=False, separators=(",", ":"))

    # ---- 篇名检索索引（分片，前端按需拉取）----
    search_dir = os.path.join(out, "search")
    os.makedirs(search_dir, exist_ok=True)
    n_shards = max(1, min(SHARDS, (len(titles) + 9999) // 10000))
    per = -(-len(titles) // n_shards)
    shard_files = []
    for k in range(n_shards):
        part = titles[k * per:(k + 1) * per]
        name = f"titles-{k}.json"
        json.dump(part, open(os.path.join(search_dir, name), "w"),
                  ensure_ascii=False, separators=(",", ":"))
        shard_files.append({"file": name, "n": len(part)})
    json.dump({"count": len(titles), "shards": shard_files,
               "note": "条目格式 [书号, 篇序号, 篇名]，书号补零三位后对应 toc/<id>.json"},
              open(os.path.join(search_dir, "manifest.json"), "w"),
              ensure_ascii=False, separators=(",", ":"))

    # ---- 作者索引 ----
    by_author: dict[str, dict] = {}
    for b in catalog:
        a = b["author"] or "佚名"
        e = by_author.setdefault(a, {"a": a, "d": b["dynasty"], "b": []})
        e["b"].append(b["id"])
    json.dump(sorted(by_author.values(), key=lambda x: -len(x["b"])),
              open(os.path.join(out, "authors.json"), "w"),
              ensure_ascii=False, separators=(",", ":"))

    def du(p):
        return sum(os.path.getsize(os.path.join(r, f))
                   for r, _, fs in os.walk(p) for f in fs)

    info = {
        "books": stats["books"],
        "sections": stats["sections"],
        "chars": stats["chars"],
        "encodings": {k[1]: v for k, v in stats.items() if isinstance(k, tuple)},
        "empty_books": stats["empty"],
        "catalog_bytes": os.path.getsize(os.path.join(out, "catalog.json")),
        "toc_bytes": du(toc_dir),
        "books_bytes": du(books_dir),
        "search_bytes": du(search_dir),
        "search_shards": len(shard_files),
        "elapsed": round(time.time() - t0, 1),
    }
    return info


if __name__ == "__main__":
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(here, "books"))
    ap.add_argument("--out", default=os.path.join(here, "site", "data"))
    a = ap.parse_args()
    info = build(a.src, a.out)
    print(json.dumps(info, ensure_ascii=False, indent=2))
