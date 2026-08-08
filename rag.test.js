/* rag.test.js —— rag.js 单元测试（切块逻辑纯函数，无需浏览器）
 * 运行: node rag.test.js
 */
"use strict";
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/rag.js", "utf8");

// 从源码提取纯函数（chunkText），避开浏览器环境依赖
function grab(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("找不到函数 " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const chunkTextSrc = grab("chunkText");
const fn = new Function(chunkTextSrc + "\nreturn chunkText;")();

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
};

console.log("== chunkText 切块 ==");
const md = [
  "# 密位测距法",
  "密位公式：利用密位估算目标距离。",
  "",
  "## 原理",
  "1 密位 = 1/6000 圆周角。",
  "距离 = 目标尺寸 / 密位数 × 1000。",
  "",
  "## 示例",
  "身高 1.8m 的人占 5 密位，距离 = 1.8/5×1000 = 360m。",
].join("\n");

const chunks = fn(md);
t("普通文档切出 ≥2 块", chunks.length >= 2);
t("第一块以标题开头", chunks[0].startsWith("# 密位测距法"));
t("块不含首尾空白", chunks.every((c) => c === c.trim() && c.length > 0));
t("所有内容都被保留（拼接长度 ≥ 原文）", chunks.join("\n").replace(/\s+/g, "") === md.replace(/\s+/g, ""));

// 大段文本按长度切
const big = "# 标题\n" + "这是一段很长的文本内容。".repeat(100);
const bigChunks = fn(big);
t("超长文本切成多块", bigChunks.length >= 3);
t("每块 ≤ RAG_CHUNK_SIZE + 余量", bigChunks.every((c) => c.length <= 520));

// 空/异常输入
t("空字符串返回 []", fn("").length === 0);
t("null 返回 []", fn(null).length === 0);

// 标题分隔
const h = ["# A", "内容A", "# B", "内容B"].join("\n");
const hChunks = fn(h);
t("标题触发分块", hChunks.length === 2 && hChunks[0].includes("A") && hChunks[1].includes("B"));

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
