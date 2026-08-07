/* search.test.js — 全文搜索核心算法测试
 * 直接从 app.js 提取真实函数体运行，确保测的是生产代码
 */
"use strict";
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/app.js", "utf8");

function grab(name) {
  // function 声明
  const m = src.match(new RegExp("(?:async )?function " + name + "\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}"));
  if (m) return m[0];
  // const 箭头函数
  const c = src.match(new RegExp("const " + name + "\\s*=\\s*([\\s\\S]*?);\\r?\\n"));
  if (c) return "(" + c[1] + ")";
  throw new Error("函数未找到: " + name);
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg); }
}

// 纯函数直接 eval
const escapeReg = eval("(" + grab("escapeReg") + ")");
const matchScore = eval("(" + grab("matchScore") + ")");
const makeSnippet = eval("(" + grab("makeSnippet") + ")");

// filterTree 依赖自由变量，用闭包注入（含其调用的纯函数）
const makeFT = (index, term, snips) =>
  new Function("searchIndex", "searchTerm", "searchSnippets", "matchScore", "makeSnippet", "escapeReg",
    "return " + grab("filterTree") + ";"
  )(index, term, snips, matchScore, makeSnippet, escapeReg);

console.log("== escapeReg ==");
ok(escapeReg("a.b") === "a\\.b", "正则特殊字符转义");
ok(escapeReg("密位") === "密位", "中文无需转义");

console.log("== matchScore ==");
ok(matchScore({ name: "README.md", title: "", text: "" }, "readme").where === "name", "文件名命中");
ok(matchScore({ name: "a.md", title: "学习方法论", text: "" }, "方法").where === "title", "标题命中");
ok(matchScore({ name: "b.md", title: "", text: "这是关于密位测距的记录" }, "密位").where === "text", "正文命中");
const t = matchScore({ name: "c.md", title: "", text: "一二三四五六七八九十" }, "五六");
ok(t && t.idx === 4, "正文命中位置正确（idx=4）");
ok(matchScore({ name: "d.md", title: "", text: "无相关内容" }, "不存在") === null, "未命中返回 null");
ok(matchScore(null, "x") === null, "空索引条目不崩溃");

console.log("== makeSnippet ==");
const long = "A".repeat(50) + "明月" + "B".repeat(50); // 关键词居中
const sn = makeSnippet(long, "明月");
ok(sn.includes("明月"), "摘要包含关键词");
ok(sn.startsWith("…") && sn.endsWith("…"), "长文截断带省略号");
ok(makeSnippet("短文本", "短") === "短文本", "短文不截断");
// 密度窗口：三处命中，前两处扎堆、第三处孤立 → 应选扎堆处
const dense = "X".repeat(30) + "关键词A" + "A".repeat(15) + "关键词A" + "B".repeat(80) + "关键词A" + "C".repeat(30);
const dsn = makeSnippet(dense, "关键词");
const dCnt = (dsn.match(/关键词/g) || []).length;
ok(dCnt >= 2, "多命中选密度窗口（摘要含 ≥2 处命中，实际 " + dCnt + "）");
ok(!dsn.includes("CCC"), "密度窗口避开孤立命中");
const single = makeSnippet("前面若干文字，后面出现唯一关键词在中间区域，其余无关内容填充。", "唯一关键词");
ok(single.includes("唯一关键词"), "单命中显示唯一命中处");

console.log("== filterTree ==");
const index = new Map([
  ["/notes/plan.md", { name: "plan.md", title: "暑假计划", text: "七月学 Python，八月做项目" }],
  ["/notes/math.md", { name: "math.md", title: "", text: "函数与导数笔记" }],
  ["/notes/other.md", { name: "other.md", title: "", text: "无关内容" }],
]);
const tree = [
  { kind: "dir", name: "notes", path: "/notes/", children: [
    { kind: "file", name: "plan.md", path: "/notes/plan.md" },
    { kind: "file", name: "math.md", path: "/notes/math.md" },
    { kind: "file", name: "other.md", path: "/notes/other.md" },
  ]},
];
let snippets = new Map();
const res = makeFT(index, "python", snippets)(tree);
ok(res.length === 1 && res[0].children.length === 1, "正文命中过滤出 1 个文件");
ok(snippets.get("/notes/plan.md").includes("Python"), "命中摘要已生成");
snippets = new Map();
const res2 = makeFT(index, "暑假", snippets)(tree);
ok(res2[0].children.length === 1 && snippets.get("/notes/plan.md").includes("标题命中"), "标题命中标记");
snippets = new Map();
const res3 = makeFT(index, "md", snippets)(tree);
ok(res3[0].children.length === 3, "文件名命中多个文件（.md 后缀）");

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
