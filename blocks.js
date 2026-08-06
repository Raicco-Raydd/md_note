/*!
 * blocks.js — MindDepot Note 块编辑器引擎
 * markdown ↔ 块(block) 双向转换 + 行内格式化
 * 纯逻辑、无依赖，浏览器/Node 通用
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MdBlocks = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * markdown 文本 → 块数组
   * 块模型: { type, level?, content?, lang?, checked?, num? }
   * type: heading | paragraph | bullet | ordered | todo | quote | code | divider
   */
  function parseBlocks(md) {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      if (!t) { i++; continue; }

      // 代码块
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        const lang = fence[1];
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // 跳过闭合围栏
        blocks.push({ type: "code", lang: lang || "", content: codeLines.join("\n") });
        continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        blocks.push({ type: "divider" });
        i++;
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        blocks.push({ type: "heading", level: h[1].length, content: h[2].trim() });
        i++;
        continue;
      }

      // 引用（连续引用行合并为一个块）
      if (/^>\s?/.test(line)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", content: q.join("\n") });
        continue;
      }

      // 任务列表
      const todo = line.match(/^- \[( |x|X)\]\s+(.+)$/);
      if (todo) {
        blocks.push({ type: "todo", checked: todo[1] !== " ", content: todo[2] });
        i++;
        continue;
      }

      // 无序列表
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        blocks.push({ type: "bullet", content: bullet[1] });
        i++;
        continue;
      }

      // 有序列表
      const ordered = line.match(/^(\d+)\.\s+(.+)$/);
      if (ordered) {
        blocks.push({ type: "ordered", num: parseInt(ordered[1], 10) || 1, content: ordered[2] });
        i++;
        continue;
      }

      // 段落：连续非空行合并（软换行保留）
      const para = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const lt = l.trim();
        if (!lt ||
            /^(#{1,6})\s/.test(l) ||
            /^```/.test(lt) ||
            /^(-{3,}|\*{3,}|_{3,})$/.test(lt) ||
            /^>\s?/.test(l) ||
            /^- \[/.test(l) ||
            /^[-*]\s/.test(l) ||
            /^\d+\.\s/.test(l)) break;
        para.push(l);
        i++;
      }
      blocks.push({ type: "paragraph", content: para.join("\n") });
    }

    return blocks;
  }

  /** 块数组 → markdown 文本 */
  function serializeBlocks(blocks) {
    return blocks.map((b) => {
      switch (b.type) {
        case "heading": return "#".repeat(b.level || 1) + " " + b.content;
        case "paragraph": return b.content;
        case "bullet": return "- " + b.content;
        case "ordered": return (b.num || 1) + ". " + b.content;
        case "todo": return "- [" + (b.checked ? "x" : " ") + "] " + b.content;
        case "quote": return b.content.split("\n").map((l) => "> " + l).join("\n");
        case "code": return "```" + (b.lang || "") + "\n" + b.content + "\n```";
        case "divider": return "---";
        default: return "";
      }
    }).join("\n\n") + "\n";
  }

  /**
   * 行内 markdown → HTML（编辑器渲染用）
   * 支持：代码 `x`、加粗 **x**、斜体 *x*、删除线 ~~x~~、链接 [t](u)
   */
  function renderInline(text) {
    let s = String(text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  /** 块类型显示名（/ 菜单用） */
  const TYPE_LABELS = {
    paragraph: "正文",
    heading: "标题",
    bullet: "无序列表",
    ordered: "有序列表",
    todo: "任务列表",
    quote: "引用",
    code: "代码块",
    divider: "分割线",
  };

  /** 空块模板（新建/快捷输入转换用） */
  function emptyBlock(type) {
    switch (type) {
      case "heading": return { type: "heading", level: 2, content: "" };
      case "bullet": return { type: "bullet", content: "" };
      case "ordered": return { type: "ordered", num: 1, content: "" };
      case "todo": return { type: "todo", checked: false, content: "" };
      case "quote": return { type: "quote", content: "" };
      case "code": return { type: "code", lang: "", content: "" };
      case "divider": return { type: "divider" };
      default: return { type: "paragraph", content: "" };
    }
  }

  return {
    parseBlocks: parseBlocks,
    serializeBlocks: serializeBlocks,
    renderInline: renderInline,
    TYPE_LABELS: TYPE_LABELS,
    emptyBlock: emptyBlock,
  };
});
