#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全站全文检索索引编译器（v2）。

思路：中文没有词边界，用 **bigram（二元组）倒排** 最省事且不依赖词典。

  分词    只索引「汉字+汉字」相邻二元组（标点/数字/拉丁不参与，但保留在文流里用于判断相邻）
  粒度    篇（section），全站共 148,197 篇，篇号按书籍顺序全局连续
  去重    同一篇里同一个 bigram 只记一次（古籍里术语高度重复，这一条能把倒排压掉 2~3 倍）
  分片    按 FNV-1a(bigram) % SHARDS 分片。查 2 字词只取 1 片、4 字词取 ≤3 片，
          不必下载整份索引
  编码    片内按 bigram 排序；每条的篇号列表用 **相邻差值 + 逗号** 写，交给传输层 gzip

输出（public/data/fts/）：
  manifest.json     {shards, docs, offsets: 每本书的起始篇号, sample: 抽样校验用}
  <k>.json          [[bigram, "d1,d2,...", docCount], ...]

纯 stdlib，无依赖。用法：
  python3 scripts/build_index.py --data public/data --out public/data/fts
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from array import array

SHARDS = 64

# 参与索引的汉字范围（都属 BMP，保证 Python 与 JS 的码点一致）
CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))


def is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in CJK_RANGES)


def fnv1a(s: str) -> int:
    """与前端 src/lib/fts.ts 里的实现必须完全一致。"""
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h


def bigrams_of(text: str) -> set[str]:
    """索引用：相邻两字都属汉字才算一个 bigram。"""
    out: set[str] = set()
    prev = ""
    for ch in text:
        if prev and is_cjk(prev) and is_cjk(ch):
            out.add(prev + ch)
        prev = ch
    return out


def build(data_dir: str, out_dir: str, shards: int = SHARDS) -> dict:
    t0 = time.time()
    catalog = json.load(open(os.path.join(data_dir, "catalog.json"), encoding="utf8"))
    os.makedirs(out_dir, exist_ok=True)

    postings: dict[str, array] = {}
    offsets: list[int] = []          # 每本书的起始篇号（全局篇号 = offsets[i] + 篇内序号）
    doc = 0
    sections_total = 0
    bigram_occurrences = 0

    for b in catalog["books"]:
        offsets.append(doc)
        bid = b["id"]
        for n in range(b["chunks"]):
            chunk = json.load(open(os.path.join(data_dir, "books", bid, f"{n}.json"), encoding="utf8"))
            for sec in chunk:
                text = "\n".join(sec.get("p") or [])
                for g in bigrams_of(text):
                    lst = postings.get(g)
                    if lst is None:
                        postings[g] = array("i", [doc])
                    else:
                        if lst[-1] != doc:      # 同一篇只记一次（篇号递增，所以比一次即可）
                            lst.append(doc)
                    bigram_occurrences += 1
                doc += 1
                sections_total += 1

    offsets.append(doc)  # 收尾哨兵，便于二分
    assert doc == sections_total, (doc, sections_total)

    # 分片写出
    buckets: list[list] = [[] for _ in range(shards)]
    for g, lst in postings.items():
        k = fnv1a(g) % shards
        deltas, prev = [], 0
        for d in lst:
            deltas.append(str(d - prev))
            prev = d
        buckets[k].append([g, ",".join(deltas), len(lst)])

    sizes = []
    for k, rows in enumerate(buckets):
        rows.sort(key=lambda r: r[0])
        p = os.path.join(out_dir, f"{k}.json")
        with open(p, "w", encoding="utf8") as f:
            json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        sizes.append(os.path.getsize(p))

    manifest = {
        "v": 1,
        "shards": shards,
        "docs": doc,
        "bigrams": len(postings),
        "postings": sum(len(v) for v in postings.values()),
        "offsets": offsets,
        "books": [b["id"] for b in catalog["books"]],
        "rule": "bigram：相邻两字皆为汉字；同一篇去重；分片 = fnv1a(bigram) % shards",
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    return {
        "docs": doc,
        "bigram_keys": len(postings),
        "postings(去重后)": manifest["postings"],
        "bigram_occurrences(未去重)": bigram_occurrences,
        "shards": shards,
        "shard_bytes_min/avg/max": (min(sizes), sum(sizes) // len(sizes), max(sizes)),
        "total_MB": round(sum(sizes) / 1e6, 1),
        "manifest_KB": round(os.path.getsize(os.path.join(out_dir, "manifest.json")) / 1024, 1),
        "elapsed": round(time.time() - t0, 1),
    }


if __name__ == "__main__":
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(here, "public", "data"))
    ap.add_argument("--out", default=os.path.join(here, "public", "data", "fts"))
    ap.add_argument("--shards", type=int, default=SHARDS)
    a = ap.parse_args()
    info = build(a.data, a.out, a.shards)
    print(json.dumps(info, ensure_ascii=False, indent=2))
