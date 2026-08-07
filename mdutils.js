/*!
 * mdutils.js — mdutils Python 包的浏览器移植版
 * 纯文本操作，无依赖，可在浏览器与 Node.js 中运行。
 * 行为与 Python 版 mdutils（v2.1.0）保持一致。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Mdutils = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#*)?$/;
  var HEADING_PREFIX_RE = /^(#{1,6})\s+/;

  function splitLines(text) {
    return text.replace(/\r\n?/g, "\n").split("\n");
  }

  function joinLines(lines) {
    return lines.join("\n").trim() + "\n";
  }

  /** 提取所有标题，返回 [{level, title}, ...] */
  function parseHeadings(text) {
    var headings = [];
    splitLines(text).forEach(function (line) {
      var m = line.trim().match(HEADING_RE);
      if (m) headings.push({ level: m[1].length, title: m[2].trim() });
    });
    return headings;
  }

  /** 提取指定标题下的区块内容（到下一个任意级别标题为止） */
  function extractSection(text, headingText) {
    var lines = splitLines(text);
    var startIdx = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].trim().match(HEADING_RE);
      if (m && m[2].trim() === headingText) { startIdx = i; break; }
    }
    if (startIdx === null) return "";
    var content = [];
    for (var j = startIdx + 1; j < lines.length; j++) {
      if (HEADING_PREFIX_RE.test(lines[j].trim())) break;
      content.push(lines[j]);
    }
    return content.join("\n").trim();
  }

  /** 替换指定标题下的区块内容（未找到则返回原文） */
  function replaceSection(text, headingText, newContent) {
    var lines = splitLines(text);
    var startIdx = null, endIdx = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].trim().match(HEADING_RE);
      if (m) {
        if (m[2].trim() === headingText && startIdx === null) { startIdx = i; continue; }
        if (startIdx !== null) { endIdx = i; break; }
      }
    }
    if (startIdx === null) return text;
    if (endIdx === null) endIdx = lines.length;
    return joinLines(lines.slice(0, startIdx + 1).concat([newContent], lines.slice(endIdx)));
  }

  /** 删除指定标题下的区块内容（保留标题行） */
  function deleteSection(text, headingText) {
    return replaceSection(text, headingText, "");
  }

  /** 在指定标题行之后插入内容（未找到则抛错） */
  function insertAfterHeading(text, headingText, content) {
    var lines = splitLines(text);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].trim().match(HEADING_RE);
      if (m && m[2].trim() === headingText) {
        return joinLines(lines.slice(0, i + 1).concat([content], lines.slice(i + 1)));
      }
    }
    throw new Error("指定标题未找到");
  }

  /** 在指定区块之后插入新区块（新标题级别继承锚点；未找到锚点则抛错） */
  function insertSectionAfter(text, anchorHeading, newHeading, content) {
    var lines = splitLines(text);
    var anchorIdx = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].trim().match(HEADING_RE);
      if (m && m[2].trim() === anchorHeading) { anchorIdx = i; break; }
    }
    if (anchorIdx === null) throw new Error("锚点标题未找到");
    var endIdx = lines.length;
    for (var j = anchorIdx + 1; j < lines.length; j++) {
      if (HEADING_PREFIX_RE.test(lines[j].trim())) { endIdx = j; break; }
    }
    var level = lines[anchorIdx].trim().match(HEADING_PREFIX_RE)[1].length;
    var block = ("\n" + new Array(level + 1).join("#") + " " + newHeading + "\n\n" + content).trim();
    return joinLines(lines.slice(0, endIdx).concat([block], lines.slice(endIdx)));
  }

  /** 更新 YAML frontmatter（不存在则创建；键已存在则更新，否则追加） */
  function updateFrontmatter(text, key, value) {
    var lines = splitLines(text);
    if (lines.length && lines[0].trim() === "---") {
      var endIdx = null;
      for (var i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { endIdx = i; break; }
      }
      if (endIdx !== null) {
        var fm = lines.slice(1, endIdx);
        var re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:");
        var updated = false;
        for (var j = 0; j < fm.length; j++) {
          if (re.test(fm[j])) { fm[j] = key + ": " + value; updated = true; break; }
        }
        if (!updated) fm.push(key + ": " + value);
        return joinLines(["---"].concat(fm, ["---"], lines.slice(endIdx + 1)));
      }
    }
    return "---\n" + key + ": " + value + "\n---\n" + text;
  }

  // ========== HTML 清洗（XSS 防御 · 白名单制）==========
  // 仅保留常用排版标签；属性按标签白名单放行；事件属性/危险协议一律丢弃。
  // 用于 marked.parse() 输出注入 innerHTML 之前的最后一道闸。
  var SANITIZE_ALLOWED_TAGS = {
    p: 1, br: 1, hr: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    ul: 1, ol: 1, li: 1, dl: 1, dt: 1, dd: 1,
    blockquote: 1, pre: 1, code: 1, em: 1, strong: 1, b: 1, i: 1,
    a: 1, img: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1,
    mark: 1, del: 1, s: 1, sub: 1, sup: 1, span: 1, div: 1,
    details: 1, summary: 1, kbd: 1, samp: 1, var: 1, abbr: 1, cite: 1,
    small: 1, figure: 1, figcaption: 1, input: 1
  };
  var SANITIZE_ATTR_RULES = {
    a: { href: /^(https?:|mailto:|#|\.{0,2}\/)/i, title: 1, target: /^_blank$/i, rel: 1 },
    img: { src: /^(https?:|data:image\/|\.{0,2}\/)/i, alt: 1, title: 1, width: /^\d+$/, height: /^\d+$/ },
    code: { class: /^language-[a-z0-9_+-]+$/i },
    pre: { class: /^language-[a-z0-9_+-]+$/i },
    th: { colspan: /^\d+$/, rowspan: /^\d+$/ },
    td: { colspan: /^\d+$/, rowspan: /^\d+$/ },
    mark: { class: /^[a-z0-9_-]+$/i },
    span: { class: /^[a-z0-9_ -]+$/i },
    input: { type: /^checkbox$/i, disabled: 1, checked: 1 }
  };
  var SANITIZE_TAG_RE = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  var SANITIZE_ATTR_RE = /([a-zA-Z-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

  function sanitizeHtml(input) {
    if (!input) return "";
    var out = "";
    var last = 0;
    var m;
    while ((m = SANITIZE_TAG_RE.exec(input)) !== null) {
      out += input.slice(last, m.index).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      var closing = m[1] === "/";
      var tag = m[2].toLowerCase();
      var attrsRaw = m[3] || "";
      if (closing) {
        if (Object.prototype.hasOwnProperty.call(SANITIZE_ALLOWED_TAGS, tag)) out += "</" + tag + ">";
      } else if (Object.prototype.hasOwnProperty.call(SANITIZE_ALLOWED_TAGS, tag)) {
        var rules = SANITIZE_ATTR_RULES[tag];
        var attrs = "";
        var am;
        SANITIZE_ATTR_RE.lastIndex = 0;
        while ((am = SANITIZE_ATTR_RE.exec(attrsRaw)) !== null) {
          var name = am[1].toLowerCase();
          if (/^on/i.test(name)) continue; // 事件属性一律丢弃
          if (!rules || !Object.prototype.hasOwnProperty.call(rules, name)) continue;
          var val = "";
          if (am[2]) {
            var q = am[2].charAt(0);
            val = (q === '"' || q === "'") ? am[2].slice(1, -1) : am[2];
          }
          var ok = rules[name] === 1 ? true : rules[name].test(val);
          if (!ok) continue;
          if (rules[name] === 1 && val === "") {
            attrs += " " + name;
          } else {
            attrs += " " + name + '="' + val.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '"';
          }
        }
        out += "<" + tag + attrs + ">";
      }
      last = m.index + m[0].length;
    }
    out += input.slice(last).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return out;
  }

  return {
    parseHeadings: parseHeadings,
    extractSection: extractSection,
    replaceSection: replaceSection,
    deleteSection: deleteSection,
    insertAfterHeading: insertAfterHeading,
    insertSectionAfter: insertSectionAfter,
    updateFrontmatter: updateFrontmatter,
    sanitizeHtml: sanitizeHtml,
  };
});
