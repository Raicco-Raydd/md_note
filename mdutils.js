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

  return {
    parseHeadings: parseHeadings,
    extractSection: extractSection,
    replaceSection: replaceSection,
    deleteSection: deleteSection,
    insertAfterHeading: insertAfterHeading,
    insertSectionAfter: insertSectionAfter,
    updateFrontmatter: updateFrontmatter,
  };
});
