/* sanitize.test.js — HTML 清洗（XSS 防御）测试
 * 直接测试 mdutils.js 引擎的 Mdutils.sanitizeHtml（浏览器 + Node 双端同源）
 */
"use strict";
const Mdutils = require("./mdutils.js");
const s = (h) => Mdutils.sanitizeHtml(h);

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

console.log("== sanitizeHtml 测试 ==");

// ── 事件属性 ──
t("img onerror 被剥离", !/onerror/i.test(s('<img src="x" onerror="alert(1)">')));
t("svg/onload 整体丢弃", !/<svg/i.test(s('<svg onload="alert(1)"><circle/></svg>')));
t("p onclick 被剥离", !/onclick/i.test(s('<p onclick="x()">y</p>')));
t("style 属性被剥离", !/style=/i.test(s('<b style="color:red">x</b>')));
t("大小写 OnError 被剥离", !/onerror/i.test(s('<IMG SRC=x OnError=alert(1)>')));

// ── 危险协议 ──
t("javascript: href 被剥离", !/javascript:/i.test(s('<a href="javascript:alert(1)">x</a>')));
t("data:text href 被剥离", !/data:text/i.test(s('<a href="data:text/html;base64,xxx">x</a>')));
t("data:image src 保留", /data:image/i.test(s('<img src="data:image/png;base64,xxx">')));
t("外链 https src 保留", /src="https:\/\//.test(s('<img src="https://a.com/b.png">')));

// ── 危险标签 ──
t("script 整体丢弃", !/<script/i.test(s('<script>alert(1)</script>')));
t("iframe 整体丢弃", !/<iframe/i.test(s('<iframe src="https://evil"></iframe>')));

// ── 允许标签保留 ──
t("排版标签保留", s('<h1>标题</h1><p><strong>粗</strong><em>斜</em></p><ul><li>项</li></ul>')
  === '<h1>标题</h1><p><strong>粗</strong><em>斜</em></p><ul><li>项</li></ul>');
t("code 语言类保留", /class="language-js"/.test(s('<pre class="language-js"><code>var a=1;</code></pre>')));
t("details/summary 保留", /<details>/.test(s('<details><summary>标题</summary>内容</details>')));
t("table colspan 保留", /colspan="2"/.test(s('<table><tr><td colspan="2">x</td></tr></table>')));
t("任务列表 checkbox 保留", /<input type="checkbox" disabled>/.test(s('<input type="checkbox" disabled>')));

// ── 文本/实体 ──
t("实体不双重转义", s('<p>&amp;</p>') === '<p>&amp;</p>');
t("游离 < 转义", s('a < b') === 'a &lt; b');
t("无标签原样", s('hello world') === 'hello world');

// ── 绕过尝试 ──
t("嵌套 script 绕过失败", !/<script/i.test(s('<scr<script>ipt>alert(1)</scr</script>ipt>')));
t("属性值内 > 不逃逸", !/onerror/i.test(s('<img alt="a>b" src="x" onerror="alert(1)">')));

// ── 边界 ──
t("空输入", s('') === '');
t("null 输入", s(null) === '');
t("constructor 标签不误放行", !/<constructor/i.test(s('<constructor>x</constructor>')));

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
