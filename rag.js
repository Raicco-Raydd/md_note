// rag.js —— 本地语义搜索（RAG 检索层）
// 完全本地：Transformers.js + bge-small-zh 向量化，无任何云 API
// 使用：搜索无结果时调用 semanticSearch() 做语义推荐；或主动触发
// ⚠️ 模型文件 ~90MB，首次使用需下载（走 hf-mirror 镜像，可缓存）
"use strict";

const RAG_MODEL = "Xenova/bge-small-zh-v1.5";
const RAG_CHUNK_SIZE = 500; // 每块字符数（约）
const RAG_TOP_K = 5; // 默认返回条数

let ragPipeline = null; // 懒加载的 embedding pipeline
let ragLoading = null; // 并发去重：加载中的 Promise
let ragIndex = null; // { path -> [ {text, vec} ] } 或 null（未构建）
let ragIndexBuiltAt = 0;
const RAG_INDEX_TTL_MS = 10 * 60 * 1000; // 索引 10 分钟过期重建

// ── 模型加载（懒加载 + 镜像） ──────────
async function getPipeline() {
  if (ragPipeline) return ragPipeline;
  if (ragLoading) return ragLoading;
  ragLoading = (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      // 国内网络：默认 huggingface.co 被墙，走镜像
      env.remoteHost = "https://hf-mirror.com";
      ragPipeline = await pipeline("feature-extraction", RAG_MODEL, {
        quantized: true,
        dtype: "q8",
      });
      return ragPipeline;
    } catch (e) {
      console.warn("⚠️ 语义搜索模型加载失败:", e.message);
      return null;
    } finally {
      ragLoading = null;
    }
  })();
  return ragLoading;
}

// ── 文本切块 ──────────────────────────
// 按标题(#/##/###)和段落边界切，每块约 RAG_CHUNK_SIZE 字符
function chunkText(text, chunkSize = 500) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    const t = cur.join("\n").trim();
    if (t) chunks.push(t);
    cur = [];
    curLen = 0;
  };
  for (const line of lines) {
    // 超长行（> chunkSize）行内切割，避免单块过大
    if (line.length > chunkSize) {
      flush();
      let rest = line;
      while (rest.length > chunkSize) {
        chunks.push(rest.slice(0, chunkSize).trim());
        rest = rest.slice(chunkSize);
      }
      if (rest.trim()) {
        cur.push(rest);
        curLen = rest.length;
      }
      continue;
    }
    const isHeading = /^#{1,6}\s+/.test(line.trim());
    if (isHeading && curLen > 0) flush();
    cur.push(line);
    curLen += line.length;
    if (curLen >= chunkSize) flush();
  }
  flush();
  return chunks;
}

// ── 构建语义索引 ───────────────────────
// items: 笔记树节点数组（与 buildSearchIndex 同构）
async function buildSemanticIndex(items) {
  const pipe = await getPipeline();
  if (!pipe) return null;

  const idx = new Map();
  const walk = async (its) => {
    for (const it of its) {
      if (it.kind === "file") {
        try {
          const handle = await resolveHandle(it.path);
          const text = await readFileText(handle);
          // 超大文件跳过正文（与关键词搜索一致，避免卡顿）
          if (text.length > 300000) {
            idx.set(it.path, [{ text: it.name, vec: null }]);
            continue;
          }
          const chunks = chunkText(text);
          const vecs = [];
          for (const c of chunks) {
            const out = await pipe(c, { pooling: "mean", normalize: true });
            vecs.push({ text: c, vec: Array.from(out.data) });
          }
          idx.set(it.path, vecs);
        } catch (e) {
          /* 读取失败跳过 */
        }
      } else {
        await walk(it.children);
      }
    }
  };
  await walk(items);
  ragIndex = idx;
  ragIndexBuiltAt = Date.now();
  return idx;
}

// ── 语义检索 ──────────────────────────
// 返回 [{path, title, chunk, score}] 按相似度降序
async function semanticSearch(query, items, { topK = RAG_TOP_K } = {}) {
  const q = String(query || "").trim();
  if (!q || q.length < 2) return [];

  // 索引过期或未构建 → 重建
  if (!ragIndex || Date.now() - ragIndexBuiltAt > RAG_INDEX_TTL_MS) {
    const idx = await buildSemanticIndex(items);
    if (!idx) return [];
  }

  const pipe = ragPipeline;
  if (!pipe) return [];

  const qOut = await pipe(q, { pooling: "mean", normalize: true });
  const qVec = Array.from(qOut.data);

  const hits = [];
  for (const [path, chunks] of ragIndex) {
    for (const c of chunks) {
      if (!c.vec) continue;
      let dot = 0;
      for (let i = 0; i < c.vec.length; i++) dot += c.vec[i] * qVec[i];
      hits.push({ path, chunk: c.text, score: dot });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

// 导出（浏览器全局用 window.RAG = {...}）
if (typeof window !== "undefined") {
  window.RAG = {
    getPipeline,
    buildSemanticIndex,
    semanticSearch,
    chunkText,
  };
}
