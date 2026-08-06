/* blocks.js 引擎测试 */
"use strict";
const B = require("./blocks.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

const DOC = [
  "# 标题一",
  "",
  "这是第一段。",
  "同一段换行（软换行）。",
  "",
  "## 二级标题",
  "",
  "- 列表甲",
  "- 列表乙",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "- [ ] 待办",
  "- [x] 已完成",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "```python",
  "print('hi')",
  "```",
  "",
  "---",
  "",
  "结尾段落。",
].join("\n");

console.log("== parseBlocks ==");
const blocks = B.parseBlocks(DOC);
check("总块数 13", blocks.length === 13, blocks.length);

const b0 = blocks[0];
check("块0 标题 H1", b0.type === "heading" && b0.level === 1 && b0.content === "标题一");

const p = blocks[1];
check("段落合并软换行", p.type === "paragraph" && p.content.includes("\n"));

const b2 = blocks[2];
check("H2 标题", b2.type === "heading" && b2.level === 2);

check("无序列表两条", blocks[3].type === "bullet" && blocks[4].type === "bullet");
check("有序列表带编号", blocks[5].type === "ordered" && blocks[5].num === 1 && blocks[6].num === 2);
check("待办未完成", blocks[7].type === "todo" && blocks[7].checked === false);
check("待办已完成", blocks[8].type === "todo" && blocks[8].checked === true);
check("引用合并", blocks[9].type === "quote" && blocks[9].content.includes("\n"));
check("代码块", blocks[10].type === "code" && blocks[10].lang === "python" && blocks[10].content === "print('hi')");
check("分割线", blocks[11].type === "divider");
check("结尾段落", blocks[12].type === "paragraph" && blocks[12].content === "结尾段落。");

console.log("== serializeBlocks 往返 ==");
const out = B.serializeBlocks(blocks);
// 列表项为独立块，序列化后块间空行分隔（渲染等价）；改为语义往返比对
const blocks2 = B.parseBlocks(out);
const same = blocks.length === blocks2.length && blocks.every((b, i) => {
  const c = blocks2[i];
  return b.type === c.type &&
    (b.content || "") === (c.content || "") &&
    (b.level || 1) === (c.level || 1) &&
    (b.checked || false) === (c.checked || false) &&
    (b.num || 1) === (c.num || 1);
});
check("往返语义一致（逐块比对）", same);

console.log("== renderInline ==");
const ri = B.renderInline("**粗** 和 *斜* 与 `代码`、~~删~~ [链接](https://x.com)");
check("加粗", ri.includes("<strong>粗</strong>"));
check("斜体", ri.includes("<em>斜</em>"));
check("代码", ri.includes("<code>代码</code>"));
check("删除线", ri.includes("<del>删</del>"));
check("链接", ri.includes('<a href="https://x.com"'));
check("HTML 转义", B.renderInline("<script>").includes("&lt;script&gt;"));

console.log("== emptyBlock ==");
check("空标题 H2", B.emptyBlock("heading").level === 2);
check("空正文", B.emptyBlock("paragraph").type === "paragraph");
check("空分割线", B.emptyBlock("divider").type === "divider");

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
