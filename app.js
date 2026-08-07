/* MindDepot Note — 应用逻辑
 * 数据层：FSA 真实文件夹（PC/安卓 Chrome/Edge）与 OPFS（iOS）共用同一套目录句柄 API
 */
"use strict";

const $ = (id) => document.getElementById(id);
const hasFSA = "showDirectoryPicker" in window;

// ── 状态 ──
let vaultRoot = null;    // FileSystemDirectoryHandle（FSA 或 OPFS）
let vaultMode = null;    // "fs" | "opfs"
let treeData = [];
let searchTerm = "";
let searchTerms = [];           // 按分隔符拆分的独立关键词（AND 匹配）
let searchIndex = null;        // 全文搜索索引：Map<path, {name, title, text}>
let searchSnippets = new Map(); // 搜索结果摘要：Map<path, snippet>
let selectMode = false;        // 批量选择模式（导出勾选）
let selected = new Set();      // 已勾选的笔记路径
// 排序配置（localStorage 持久化）
let sortMode = "name";        // "name" | "time"
let sortDir = "asc";          // "asc" | "desc"
try {
  const s = localStorage.getItem("md_note_sort") || "name-asc";
  const [m, d] = s.split("-");
  if (m === "name" || m === "time") sortMode = m;
  if (d === "asc" || d === "desc") sortDir = d;
} catch (e) { /* 忽略 */ }
function saveSort() { try { localStorage.setItem("md_note_sort", sortMode + "-" + sortDir); } catch (e) { /* 忽略 */ } }

// 排序比较器：目录始终在前，组内按配置排序
function sortItems(a, b) {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  if (sortMode === "time") {
    const d = sortDir === "asc" ? a.mtime - b.mtime : b.mtime - a.mtime;
    if (d !== 0) return d;
    return a.name.localeCompare(b.name, "zh-CN"); // 时间相同按名称
  }
  const n = a.name.localeCompare(b.name, "zh-CN");
  return sortDir === "asc" ? n : -n;
}
let currentNote = null;  // {name, path, handle, content}
let activeRow = null;
let blocks = [];          // 块编辑器状态

function setMsg(text, isErr) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = isErr ? "err" : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── 笔记库（统一数据层） ───────────────
async function openVault() {
  try {
    if (hasFSA) {
      vaultRoot = await window.showDirectoryPicker({ mode: "readwrite" });
      vaultMode = "fs";
      $("vaultName").textContent = vaultRoot.name;
      setMsg("✅ 已打开真实文件夹笔记库");
    } else {
      vaultRoot = await navigator.storage.getDirectory();
      vaultMode = "opfs";
      $("vaultName").textContent = "📦 本地沙箱笔记库";
      setMsg("✅ 已打开浏览器私有笔记库（当前环境不支持真实文件夹）");
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setMsg("打开笔记库失败: " + err.message, true);
    return;
  }
  $("newNoteBtn").disabled = false;
  $("vaultName").title = vaultMode === "fs" ? vaultRoot.name : "OPFS 沙箱（浏览器私有存储）";
  await refreshTree();
}

async function walkDir(dir, path) {
  const items = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "directory") {
      items.push({ kind: "dir", name, path: path + name + "/", children: await walkDir(handle, path + name + "/") });
    } else if (/\.(md|markdown|txt)$/i.test(name)) {
      let mtime = 0;
      try { mtime = (await handle.getFile()).lastModified; } catch (e) { /* 忽略 */ }
      items.push({ kind: "file", name, path: path + name, mtime });
    }
  }
  items.sort(sortItems);
  return items;
}

async function refreshTree() {
  treeData = await walkDir(vaultRoot, "");
  searchIndex = null; // 目录变更 → 索引失效，下次搜索时重建
  await renderTree(treeData);
}

// ── 路径解析 ──────────────────────────
async function resolveHandle(path) {
  const parts = path.split("/").filter(Boolean);
  let dir = vaultRoot;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function readFileText(handle) {
  const buf = await (await handle.getFile()).arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("\uFFFD")) return utf8;
  try { return new TextDecoder("gbk").decode(buf); } catch (e) { return utf8; }
}

// ── 笔记树 ────────────────────────────
async function renderTree(items) {
  const ul = $("tree");
  ul.innerHTML = "";
  let filtered = items;
  searchSnippets = new Map();
  if (searchTerm) {
    searchTerms = toTerms(searchTerm);
    if (!searchIndex) searchIndex = await buildSearchIndex(items);
    filtered = filterTree(items);
  }
  if (!filtered.length) {
    // 无强匹配：尝试弱匹配推荐（“您是否想要找”）
    if (searchTerm) {
      const sugg = suggestSimilar(searchTerm);
      if (sugg.length) {
        ul.innerHTML = '<li class="tree-empty">无匹配笔记。💡 是否想找：</li>' +
          sugg.map((s) => `<li class="search-suggest" data-path="${escapeHtml(s.path)}">📄 ${escapeHtml(s.title || s.name.replace(/\.(md|markdown|txt)$/i, ""))}</li>`).join("");
        ul.querySelectorAll(".search-suggest").forEach((el) => {
          el.addEventListener("click", () => {
            const node = findSubtree(treeData, el.dataset.path);
            if (node) {
              searchTerm = "";
              const sb = $("searchBox");
              if (sb) sb.value = "";
              openNote(node, null);
            }
          });
        });
        return;
      }
    }
    ul.innerHTML = '<li class="tree-empty">' + (searchTerm ? "无匹配笔记" : "笔记库为空，点 ➕ 新建") + "</li>";
    return;
  }
  filtered.forEach((item) => ul.appendChild(buildNode(item)));
}

// 弱匹配：搜索词字符覆盖度（Jaccard 风格），用于无结果时的推荐
function charCoverage(q, cand) {
  const sq = new Set(q), sc = new Set(cand);
  let hit = 0;
  for (const c of sq) if (sc.has(c)) hit++;
  return sq.size ? hit / sq.size : 0;
}

// 候选 = 文件名 + 标题（大文件标题为空则只剩文件名）
function suggestSimilar(q, limit = 3) {
  const ql = q.toLowerCase();
  const cands = [];
  const walk = (its) => {
    for (const it of its) {
      if (it.kind === "file") {
        const idx = searchIndex && searchIndex.get(it.path);
        const title = idx && idx.title ? idx.title : "";
        const score = charCoverage(ql, (it.name + " " + title).toLowerCase());
        if (score >= 0.5) cands.push({ path: it.path, name: it.name, title, score });
      } else walk(it.children);
    }
  };
  walk(treeData);
  cands.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return cands.slice(0, limit);
}

// ── 全文搜索索引 ──────────────────────
async function buildSearchIndex(items) {
  const idx = new Map();
  const walk = async (its) => {
    for (const it of its) {
      if (it.kind === "file") {
        let entry = { name: it.name, title: "", text: "" };
        try {
          const handle = await resolveHandle(it.path);
          const text = await readFileText(handle);
          if (text.length <= 300000) { // 大文件只按文件名匹配，避免卡顿
            const t = text.split("\n").find((l) => /^#\s+/.test(l.trim()));
            entry.title = t ? t.trim().replace(/^#+\s*/, "") : "";
            entry.text = text;
          }
        } catch (e) { /* 读取失败按空索引处理 */ }
        idx.set(it.path, entry);
      } else await walk(it.children);
    }
  };
  await walk(items);
  return idx;
}

const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 关键词分隔符：英文/中文逗号、分号、顿号、空白（符号本身不参与匹配）
const SEARCH_SEP = /[,，;；、\s]+/;
function toTerms(x) { return Array.isArray(x) ? x : String(x || "").split(SEARCH_SEP).filter(Boolean); }

function matchTerm(entry, q) {
  if (!entry) return null;
  if (entry.name.toLowerCase().includes(q)) return { score: 3, where: "name", q };
  if (entry.title && entry.title.toLowerCase().includes(q)) return { score: 2, where: "title", idx: entry.title.toLowerCase().indexOf(q), q };
  if (entry.text) {
    const i = entry.text.toLowerCase().indexOf(q);
    if (i >= 0) return { score: 1, where: "text", idx: i, q };
  }
  return null;
}

// 多关键词 AND 匹配：所有词都必须命中，取最高分命中作为代表（决定摘要）
function matchScore(entry, terms) {
  if (!entry || !terms || !terms.length) return null;
  let best = null;
  for (const q of terms) {
    const h = matchTerm(entry, q);
    if (!h) return null;
    if (!best || h.score > best.score) best = h;
  }
  return best;
}

function makeSnippet(text, q) {
  // 收集所有命中位置（升序）
  const lower = text.toLowerCase();
  const positions = [];
  let from = 0;
  while (from < text.length) {
    const i = lower.indexOf(q, from);
    if (i < 0) break;
    positions.push(i);
    from = i + q.length;
  }
  if (!positions.length) return "";
  // 滑窗选“命中密度最高”的窗口中心（多命中时更代表正文讨论点，避免总截开头）
  const W = 60;
  let best = positions[0], bestCnt = 1, l = 0, r = 0;
  for (let k = 0; k < positions.length; k++) {
    while (l < k && positions[k] - positions[l] > W) l++;
    while (r < positions.length && positions[r] - positions[k] <= W) r++;
    if (r - l > bestCnt) { bestCnt = r - l; best = positions[k]; }
  }
  // 窗口对齐到行边界：关键词在行首时从该行行首开始，且不越过该行行尾
  const lineStart = text.lastIndexOf("\n", best) + 1;
  let start = (best - lineStart <= 80) ? lineStart : Math.max(lineStart, best - 26);
  let end = Math.min(text.length, best + q.length + 40);
  const lineEnd = text.indexOf("\n", best);
  if (lineEnd >= 0 && lineEnd - best <= 120) end = Math.min(end, lineEnd);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s += "…";
  return s;
}

function filterTree(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === "file") {
      const e = searchIndex.get(it.path);
      const hit = matchScore(e, searchTerms);
      if (hit) {
        out.push(it);
        if (hit.where === "text") searchSnippets.set(it.path, makeSnippet(e.text, hit.q));
        else if (hit.where === "title") searchSnippets.set(it.path, "标题命中：" + e.title);
        else searchSnippets.set(it.path, "");
      }
    } else {
      const kids = filterTree(it.children);
      if (kids.length) out.push({ ...it, children: kids });
    }
  }
  return out;
}

function buildNode(item) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row" + (item.kind === "dir" ? " dir" : "");
  const arrow = document.createElement("span");
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = item.kind === "dir" ? "📁" : "📄";
  const label = document.createElement("span");
  label.className = "tlabel";
  label.textContent = item.name;

  // 批量选择模式：行首插 checkbox，点击行 = 切换勾选
  let cb = null;
  if (selectMode) {
    cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sel-cb";
    cb.dataset.path = item.path;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => { toggleSelect(item); updateSelUI(); });
    row.classList.add("selecting");
    row.prepend(cb);
  }

  if (item.kind === "dir") {
    // 收起/展开箭头
    arrow.className = "arrow";
    arrow.textContent = collapsedDirs.has(item.path) ? "▸" : "▾";
    row.append(arrow, ic, label);
    if (selectMode) {
      row.addEventListener("click", () => { const c = row.querySelector(".sel-cb"); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event("change")); } });
    } else {
      row.addEventListener("click", () => toggleDir(item.path, row));
    }
  } else {
    row.append(ic, label);
    if (selectMode) {
      row.addEventListener("click", () => { const c = row.querySelector(".sel-cb"); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event("change")); } });
    } else {
      row.addEventListener("click", () => openNote(item, row));
    }
  }
  row.title = item.path;

  // 悬停操作按钮（勾选模式下隐藏，避免误触）
  const acts = document.createElement("span");
  acts.className = "row-actions";
  if (!selectMode) {
    const addAct = (icon, title, cls, fn) => {
      const b = document.createElement("button");
      b.textContent = icon;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      acts.appendChild(b);
    };
    if (item.kind === "file") {
      addAct("✏️", "重命名", "", () => renameItem(item));
      addAct("🗑", "删除", "del", () => doDelete(item));
    } else {
      addAct("➕", "在此新建笔记", "", () => showNameModal({
        title: "➕ 新建笔记（在 " + item.name + " 内）",
        placeholder: "笔记名称（.md 自动补全）",
        okText: "创建",
        onSubmit: (n) => doCreateNote(n, item.path),
      }));
      addAct("📁", "在此新建文件夹", "", () => showNameModal({
        title: "📁 新建文件夹（在 " + item.name + " 内）",
        placeholder: "文件夹名称",
        okText: "创建",
        onSubmit: (n) => doCreateFolder(item.path, n),
      }));
      addAct("✏️", "重命名", "", () => renameItem(item));
      addAct("🗑", "删除", "del", () => doDelete(item));
    }
    row.appendChild(acts);
  }

  // 右键菜单
  row.addEventListener("contextmenu", (e) => showCtxMenu(e, item));

  li.appendChild(row);

  // 搜索结果摘要（全文命中时显示上下文片段；点击跳转到文内位置并高亮）
  if (item.kind === "file" && searchTerm) {
    const snip = searchSnippets.get(item.path);
    if (snip) {
      const div = document.createElement("div");
      div.className = "search-snippet";
      div.innerHTML = escapeHtml(snip).replace(new RegExp(escapeReg(searchTerm), "gi"), (m) => "<mark>" + m + "</mark>");
      div.title = "点击跳转到命中位置";
      div.addEventListener("click", (e) => {
        e.stopPropagation();
        openNote(item, findRow(item.path), { scrollTo: searchTerm });
      });
      li.appendChild(div);
    }
  }

  if (item.kind === "dir" && item.children.length) {
    const ul = document.createElement("ul");
    item.children.forEach((c) => ul.appendChild(buildNode(c)));
    if (collapsedDirs.has(item.path)) ul.classList.add("collapsed");
    li.appendChild(ul);
  }
  return li;
}

// 文件夹收起/展开（会话内记忆）
const collapsedDirs = new Set();

function toggleDir(path, row) {
  const ul = row.parentElement.querySelector(":scope > ul");
  if (!ul) return;
  const arrow = row.querySelector(".arrow");
  if (collapsedDirs.has(path)) {
    collapsedDirs.delete(path);
    ul.classList.remove("collapsed");
    if (arrow) arrow.textContent = "▾";
  } else {
    collapsedDirs.add(path);
    ul.classList.add("collapsed");
    if (arrow) arrow.textContent = "▸";
  }
}

// ── 右键菜单 ──────────────────────────
const ctxMenu = $("ctxMenu");
let ctxItem = null;

function showCtxMenu(e, item) {
  e.preventDefault();
  ctxItem = item;
  const html = item.kind === "file"
    ? `<button data-act="open">📖 打开</button>` +
      `<button data-act="export">📤 导出</button>` +
      `<button data-act="rename">✏️ 重命名</button>` +
      `<button data-act="del" class="del">🗑 删除</button>`
    : `<button data-act="note">➕ 新建笔记</button>` +
      `<button data-act="folder">📁 新建文件夹</button>` +
      `<button data-act="export">📤 导出文件夹</button>` +
      `<button data-act="rename">✏️ 重命名</button>` +
      `<button data-act="del" class="del">🗑 删除</button>`;
  ctxMenu.innerHTML = html;
  const mw = 175, mh = item.kind === "dir" ? 215 : 175;
  ctxMenu.style.left = Math.min(e.clientX, innerWidth - mw - 8) + "px";
  ctxMenu.style.top = Math.min(e.clientY, innerHeight - mh - 8) + "px";
  ctxMenu.classList.add("show");
}

ctxMenu.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || !ctxItem) return;
  const act = b.dataset.act;
  const item = ctxItem;
  ctxMenu.classList.remove("show");
  if (act === "open") openNote(item, null);
  else if (act === "rename") renameItem(item);
  else if (act === "del") doDelete(item);
  else if (act === "note") showNameModal({
    title: "➕ 新建笔记（在 " + item.name + " 内）",
    placeholder: "笔记名称（.md 自动补全）",
    okText: "创建",
    onSubmit: (n) => doCreateNote(n, item.path),
  });
  else if (act === "folder") showNameModal({
    title: "📁 新建文件夹（在 " + item.name + " 内）",
    placeholder: "文件夹名称",
    okText: "创建",
    onSubmit: (n) => doCreateFolder(item.path, n),
  });
  else if (act === "export") exportBackup(item.path);
});

document.addEventListener("click", () => ctxMenu.classList.remove("show"));

// ── 打开 / 编辑 / 保存 ─────────────────
async function openNote(item, row, opts = {}) {
  try {
    saveNotePos(); // 离开上一个笔记前记录位置
    const handle = await resolveHandle(item.path);
    const content = await readFileText(handle);
    currentNote = { name: item.name, path: item.path, handle, content };
    $("editorText").disabled = false;
    $("noteTitle").disabled = false;
    $("saveBtn").disabled = false;
    $("editorText").value = content;
    blocks = MdBlocks.parseBlocks(content);
    renderBlocks();
    syncTitleFromContent();
    if (activeRow) activeRow.classList.remove("active");
    activeRow = row || null;
    if (activeRow) activeRow.classList.add("active");
    setMsg(`📄 ${item.path}`);
    pushRecent(item);
    if (opts.scrollTo) {
      flashToBlock(opts.scrollTo);
      highlightMatchesInBlocks(opts.scrollTo); // 搜索对象文本高亮
    } else if (searchTerm) {
      // 搜索状态下点击笔记名：同样定位并高亮搜索对象
      flashToBlock(searchTerm);
      highlightMatchesInBlocks(searchTerm);
    } else {
      restoreNotePos(item.path); // 正常打开：回到上次离开的位置
    }
    if (window.matchMedia("(max-width: 768px)").matches) closeDrawer();
  } catch (err) {
    setMsg("打开失败: " + err.message, true);
  }
}

// 通用：给块元素加高亮淡出动画（可重放）
function flashEl(el) {
  if (!el) return;
  el.classList.remove("flash-hl");
  void el.offsetWidth; // 重置动画
  el.classList.add("flash-hl");
}

// 按块索引高亮（编辑保存后反馈）
function flashBlockAt(index) {
  const el = document.querySelectorAll("#blockEditor .block")[index];
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  flashEl(el);
}

// 从搜索结果跳转：滚动到包含关键词的块并高亮淡出
function flashToBlock(q) {
  const terms = toTerms(q);
  if (!terms.length) return;
  const qs = terms.map((t) => t.toLowerCase());
  const els = document.querySelectorAll("#blockEditor .block");
  for (const el of els) {
    const t = el.textContent.toLowerCase();
    if (qs.some((q) => t.includes(q))) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flashEl(el);
      return;
    }
  }
}

// 搜索对象高亮：笔记页内所有关键词命中的文本包 <mark>，1.5s 后淡出、再还原为纯文本
function highlightMatchesInBlocks(q) {
  const terms = toTerms(q);
  if (!terms.length) return;
  const qs = terms.map((t) => t.toLowerCase());
  const contents = document.querySelectorAll("#blockEditor .block .b-content");
  const targets = [];
  contents.forEach((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent.toLowerCase();
      if (qs.some((q) => t.includes(q))) targets.push(walker.currentNode);
    }
  });
  if (!targets.length) return;
  targets.forEach((node) => {
    const text = node.textContent;
    const lower = text.toLowerCase();
    // 收集所有关键词的命中区间并合并重叠
    const ranges = [];
    for (const q of qs) {
      let from = 0;
      while (from < text.length) {
        const i = lower.indexOf(q, from);
        if (i < 0) break;
        ranges.push([i, i + q.length]);
        from = i + q.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      if (merged.length && r[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
      else merged.push([...r]);
    }
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const m = document.createElement("mark");
      m.className = "search-hl";
      m.textContent = text.slice(s, e);
      frag.appendChild(m);
      pos = e;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  });
  // 1.5s 后淡出，再还原纯文本（mark 不残留，避免干扰后续编辑）
  setTimeout(() => {
    document.querySelectorAll("#blockEditor mark.search-hl").forEach((m) => m.classList.add("fade"));
  }, 1500);
  setTimeout(() => {
    document.querySelectorAll("#blockEditor mark.search-hl").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  }, 3000);
}

function syncTitleFromContent() {
  if (!currentNote) return;
  const first = blocks.find((b) => b.type === "heading");
  $("noteTitle").value = first ? first.content : currentNote.name.replace(/\.(md|markdown|txt)$/i, "");
}

function renderPreview() {
  const html = marked.parse($("editorText").value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  const pv = $("preview");
  pv.innerHTML = html;
  pv.querySelectorAll("pre code").forEach((el) => { try { hljs.highlightElement(el); } catch (e) { /* 忽略 */ } });
  buildPreviewSections();
}

// 预览区按区块包裹：标题悬停 🖊 + 区块间“＋ 添加区块”
function buildPreviewSections() {
  const pv = $("preview");
  const nodes = Array.from(pv.childNodes);
  pv.innerHTML = "";
  let currentSec = null;
  let currentText = "";

  const addDivider = () => {
    const div = document.createElement("div");
    div.className = "sec-add";
    const btn = document.createElement("button");
    btn.textContent = "＋ 添加区块";
    btn.title = "在此区块之后添加新区块";
    btn.addEventListener("click", () => openEditPanel(currentText, { mode: "add", anchor: currentText }));
    div.appendChild(btn);
    pv.appendChild(div);
  };

  nodes.forEach((node) => {
    if (node.nodeType === 1 && /^H[1-6]$/.test(node.tagName)) {
      if (currentSec) addDivider();
      currentSec = document.createElement("div");
      currentSec.className = "sec";
      pv.appendChild(currentSec);
      currentText = node.textContent.replace(/\s+/g, " ").trim();
      // 🖊 悬停编辑（先取文本再挂按钮）
      const pen = document.createElement("button");
      pen.className = "heading-edit";
      pen.textContent = "🖊";
      pen.title = "编辑该区块";
      pen.addEventListener("click", () => openEditPanel(currentText));
      node.appendChild(pen);
      currentSec.appendChild(node);
    } else if (currentSec) {
      currentSec.appendChild(node);
    } else {
      pv.appendChild(node);
    }
  });
  if (currentSec) addDivider();
}

// 旧 textarea 预览监听已由块编辑器取代（保留 renderPreview 供兼容，不再调用）

// 标题框联动：修改 = 更新第一个标题块
$("noteTitle").addEventListener("change", () => {
  if (!currentNote) return;
  const t = $("noteTitle").value.trim();
  if (!t) return;
  if (blocks.length && blocks[0].type === "heading") {
    blocks[0].content = t;
  } else {
    blocks.unshift({ type: "heading", level: 1, content: t });
  }
  renderBlocks();
  setMsg("✏️ 标题已更新，记得保存");
});

async function saveNote() {
  if (!currentNote) return;
  currentNote.content = MdBlocks.serializeBlocks(blocks);
  $("editorText").value = currentNote.content;
  try {
    const w = await currentNote.handle.createWritable();
    await w.write(currentNote.content);
    await w.close();
    setMsg(`💾 已保存 ${currentNote.name}`);
  } catch (err) {
    setMsg("保存失败: " + err.message, true);
  }
}

// ── 结构化编辑（区块替换/插入/添加/删除） ──
const editPanel = $("editPanel");
const editText = $("editText");
let editorMode = "replace";
let currentEditHeading = null;
let editAnchor = null;

function openEditPanel(heading, opts = {}) {
  if (!currentNote) return;
  const mode = opts.mode || "replace";
  const anchor = opts.anchor || heading;
  currentEditHeading = heading;
  editAnchor = anchor;
  $("editHeadingLabel").textContent = mode === "add" ? `在「${anchor}」之后添加` : heading;
  editText.value = mode === "add" ? "## 新标题\n\n新内容" : Mdutils.extractSection(currentNote.content, heading);
  setEditorMode(mode);
  editPanel.classList.add("show");
  renderEditPreview();
  editText.focus();
}

function closeEditPanel() { editPanel.classList.remove("show"); }

function setEditorMode(mode) {
  editorMode = mode;
  $("modeReplace").classList.toggle("active", mode === "replace");
  $("modeInsert").classList.toggle("active", mode === "insert");
  $("modeAdd").classList.toggle("active", mode === "add");
  $("editHint").textContent = mode === "replace" ? "替换 = 覆盖该标题下的内容"
    : mode === "insert" ? "插入 = 在标题行后追加（不触碰原有内容）"
    : "添加 = 在此区块之后插入新区块，首行写标题";
}

function renderEditPreview() {
  const html = marked.parse(editText.value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  const el = $("editPreview");
  el.innerHTML = html;
  el.querySelectorAll("pre code").forEach((c) => { try { hljs.highlightElement(c); } catch (e) { /* 忽略 */ } });
}

let editPreviewTimer = null;
editText.addEventListener("input", () => {
  clearTimeout(editPreviewTimer);
  editPreviewTimer = setTimeout(renderEditPreview, 250);
});

function parseNewSection(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)(?:\s+#*)?$/);
    if (m) return { heading: m[2].trim(), content: lines.slice(i + 1).join("\n").trim() };
  }
  const first = lines[0] ? lines[0].trim() : "";
  return { heading: first || "新标题", content: lines.slice(1).join("\n").trim() };
}

// 应用结构化编辑：更新内容 + 块 + 自动保存回文件
async function commitEdit(newText, opts = {}) {
  if (!currentNote) return;
  currentNote.content = newText;
  $("editorText").value = newText;
  blocks = MdBlocks.parseBlocks(newText);
  renderBlocks();
  syncTitleFromContent();
  // 编辑反馈：高亮被修改的区块（按标题定位）
  if (opts.highlightHeading) {
    const idx = blocks.findIndex((b) => b.type === "heading" && b.content === opts.highlightHeading);
    if (idx >= 0) flashBlockAt(idx);
  }
  try {
    const w = await currentNote.handle.createWritable();
    await w.write(newText);
    await w.close();
    setMsg(`✓ 已保存 ${currentNote.name}`);
  } catch (err) {
    setMsg("⚠️ 已修改但自动保存失败: " + err.message, true);
  }
}

async function saveEdit() {
  if (!currentNote || !currentEditHeading) return;
  try {
    if (editorMode === "add") {
      const { heading, content } = parseNewSection(editText.value);
      if (!heading) { alert("请填写新标题"); return; }
      await commitEdit(Mdutils.insertSectionAfter(currentNote.content, editAnchor, heading, content), { highlightHeading: heading });
    } else if (editorMode === "replace") {
      await commitEdit(Mdutils.replaceSection(currentNote.content, currentEditHeading, editText.value), { highlightHeading: currentEditHeading });
    } else {
      await commitEdit(Mdutils.insertAfterHeading(currentNote.content, currentEditHeading, editText.value), { highlightHeading: currentEditHeading });
    }
    closeEditPanel();
  } catch (err) {
    alert("保存失败: " + err.message);
  }
}

async function deleteSectionUI(heading) {
  const h = heading || currentEditHeading;
  if (!currentNote || !h) return;
  if (!confirm(`删除区块「${h}」的内容？（标题行保留）`)) return;
  try {
    await commitEdit(Mdutils.deleteSection(currentNote.content, h));
    closeEditPanel();
  } catch (err) {
    alert("删除失败: " + err.message);
  }
}

// ── 插入菜单（符号面板） ──
const insertMenu = $("insertMenu");

function insertWrap(before, after, placeholder = "文本") {
  const ta = editText, s = ta.selectionStart, e = ta.selectionEnd;
  const inner = ta.value.slice(s, e) || placeholder;
  ta.value = ta.value.slice(0, s) + before + inner + after + ta.value.slice(e);
  ta.selectionStart = s + before.length;
  ta.selectionEnd = s + before.length + inner.length;
}
function insertLinePrefix(prefix) {
  const ta = editText, pos = ta.selectionStart;
  const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
  ta.value = ta.value.slice(0, ls) + prefix + ta.value.slice(ls);
  ta.selectionStart = ta.selectionEnd = ls + prefix.length;
}
function insertBlockCode() {
  const ta = editText, s = ta.selectionStart, e = ta.selectionEnd;
  const code = ta.value.slice(s, e) || "代码";
  const block = "```python\n" + code + "\n```";
  ta.value = ta.value.slice(0, s) + block + ta.value.slice(e);
  ta.selectionStart = s + 10; ta.selectionEnd = s + 10 + code.length;
}
function insertTable() {
  const block = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 值1 | 值2 | 值3 |\n";
  const ta = editText, s = ta.selectionStart;
  ta.value = ta.value.slice(0, s) + block + ta.value.slice(s);
  ta.selectionStart = ta.selectionEnd = s;
}
function insertHr() {
  const ta = editText, pos = ta.selectionStart;
  const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const prefix = ta.value.slice(0, ls).replace(/\n$/, "");
  ta.value = prefix + "\n---\n\n" + ta.value.slice(ls);
  ta.selectionStart = ta.selectionEnd = prefix.length + 5;
}
function insertToc() {
  const ta = editText;
  const out = ["## 目录", ""];
  Mdutils.parseHeadings(ta.value).forEach((h) => out.push("  ".repeat(h.level - 1) + "- " + h.title));
  const block = out.join("\n") + "\n";
  const s = ta.selectionStart;
  ta.value = ta.value.slice(0, s) + block + ta.value.slice(ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = s + block.length;
  ta.focus();
}

$("insertBtn").addEventListener("click", (e) => { e.stopPropagation(); insertMenu.classList.toggle("show"); });
document.addEventListener("click", () => insertMenu.classList.remove("show"));
insertMenu.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-insert]");
  if (!b) return;
  switch (b.dataset.insert) {
    case "h1": insertLinePrefix("# "); break;
    case "h2": insertLinePrefix("## "); break;
    case "h3": insertLinePrefix("### "); break;
    case "bold": insertWrap("**", "**"); break;
    case "italic": insertWrap("*", "*"); break;
    case "strike": insertWrap("~~", "~~"); break;
    case "inline-code": insertWrap("`", "`", "code"); break;
    case "quote": insertLinePrefix("> "); break;
    case "ul": insertLinePrefix("- "); break;
    case "ol": insertLinePrefix("1. "); break;
    case "task": insertLinePrefix("- [ ] "); break;
    case "link": insertWrap("[", "](https://)", "文本"); break;
    case "image": insertWrap("![描述](", ")", "图片地址"); break;
    case "code": insertBlockCode(); break;
    case "table": insertTable(); break;
    case "hr": insertHr(); break;
    case "toc": insertToc(); break;
  }
  renderEditPreview();
  insertMenu.classList.remove("show");
  editText.focus();
});

editText.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = editText.selectionStart, t = editText.selectionEnd;
    editText.value = editText.value.slice(0, s) + "  " + editText.value.slice(t);
    editText.selectionStart = editText.selectionEnd = s + 2;
  }
});

$("editClose").addEventListener("click", closeEditPanel);
$("editCancel").addEventListener("click", closeEditPanel);
$("editSave").addEventListener("click", saveEdit);
$("editDelete").addEventListener("click", () => deleteSectionUI());
$("modeReplace").addEventListener("click", () => setEditorMode("replace"));
$("modeInsert").addEventListener("click", () => setEditorMode("insert"));
$("modeAdd").addEventListener("click", () => setEditorMode("add"));

// ── 编辑器悬停功能气泡（跟随鼠标定位） ──
const editorEl = $("editorText");
const funcBubble = $("funcBubble");
let hoverTimer = null;
let hoverHeading = null;   // {idx, title}
let lastMouse = { x: 0, y: 0 };

function lineHeightOf(el) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  return isNaN(lh) ? 22 : lh;
}

function headingAt(offsetY) {
  const lh = lineHeightOf(editorEl);
  const lineIdx = Math.floor((offsetY + editorEl.scrollTop) / lh);
  const lines = editorEl.value.split("\n");
  const line = lines[lineIdx] || "";
  const m = line.match(/^(#{1,6})\s+(.+?)(?:\s+#*)?$/);
  return m ? { idx: lineIdx, title: m[2].trim() } : null;
}

function hideBubble() { funcBubble.classList.remove("show"); }

// 延迟隐藏：离开气泡/标题行 1.5s 后才消失；光标回到气泡/标题行则取消
let hideTimer = null;
function scheduleHide(delay = 1500) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBubble, delay);
}
function cancelHide() { clearTimeout(hideTimer); }

function showBubbleAtCursor() {
  if (!hoverHeading) return;
  const h = hoverHeading;
  funcBubble.innerHTML =
    `<div class="bub-title">${escapeHtml(h.title)}</div>` +
    `<button data-bub="edit">✎ 编辑该区块</button>` +
    `<button data-bub="add">＋ 在后添加区块</button>` +
    `<button data-bub="del">🗑 删除区块（保留标题）</button>`;
  // 定位在鼠标下方偏右，视口边缘自动翻转
  const bw = 180, bh = 140;
  let x = lastMouse.x + 12;
  let y = lastMouse.y + 14;
  if (x + bw > innerWidth - 8) x = lastMouse.x - bw - 12;
  if (y + bh > innerHeight - 8) y = lastMouse.y - bh - 14;
  funcBubble.style.left = x + "px";
  funcBubble.style.top = y + "px";
  funcBubble.classList.add("show");
}

// 宽限期：鼠标是否在气泡附近（含 40px 容忍区）——正在移向气泡时不隐藏
function bubbleNearCursor() {
  if (!funcBubble.classList.contains("show")) return false;
  const r = funcBubble.getBoundingClientRect();
  return lastMouse.x > r.left - 40 && lastMouse.x < r.right + 40 &&
         lastMouse.y > r.top - 40 && lastMouse.y < r.bottom + 40;
}

editorEl.addEventListener("mousemove", (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  const rect = editorEl.getBoundingClientRect();
  const cs = getComputedStyle(editorEl);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const h = headingAt(e.clientY - rect.top - padTop);
  if (h) {
    if (hoverHeading && hoverHeading.idx === h.idx) return; // 同一行：保持现状
    hoverHeading = h;
    clearTimeout(hoverTimer);
    cancelHide(); // 回到标题行，取消隐藏计时
    hoverTimer = setTimeout(showBubbleAtCursor, 600);
  } else {
    if (hoverHeading) {
      // 离开标题行：若正在移向气泡则不隐藏，否则 1.5s 后隐藏
      hoverHeading = null;
      clearTimeout(hoverTimer);
      if (bubbleNearCursor()) cancelHide();
      else scheduleHide(1500);
    } else if (funcBubble.classList.contains("show")) {
      if (bubbleNearCursor()) cancelHide();
      else scheduleHide(1500);
    }
  }
});

editorEl.addEventListener("mouseleave", () => {
  clearTimeout(hoverTimer);
  scheduleHide(1500); // 移出编辑器也延迟隐藏（可能正移向气泡）
});

// 光标在气泡上：持续显示；离开气泡：1.5s 后消失
funcBubble.addEventListener("mouseenter", cancelHide);
funcBubble.addEventListener("mouseleave", () => scheduleHide(1500));

editorEl.addEventListener("scroll", () => {
  clearTimeout(hoverTimer);
  hideBubble();
});

editorEl.addEventListener("input", () => {
  clearTimeout(hoverTimer);
  hideBubble();
});

funcBubble.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-bub]");
  if (!b) return;
  const heading = hoverHeading ? hoverHeading.title : null;
  hideBubble();
  if (!heading) return;
  if (b.dataset.bub === "edit") openEditPanel(heading);
  else if (b.dataset.bub === "add") openEditPanel(heading, { mode: "add", anchor: heading });
  else if (b.dataset.bub === "del") deleteSectionUI(heading);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#funcBubble")) hideBubble();
});

// ── 块编辑器（Notion 风格 WYSIWYG） ──
const blockEditor = $("blockEditor");
const slashMenu = $("slashMenu");
let activeBlock = null;
let dragIdx = -1; // 拖拽排序中的块索引

function phFor(b) {
  switch (b.type) {
    case "heading": return "标题";
    case "bullet": case "ordered": return "列表项";
    case "todo": return "待办事项";
    case "quote": return "引用";
    case "code": return "输入代码…";
    default: return "输入文字，或按 / 选择块类型";
  }
}

function buildBlockEl(b, i) {
  const div = document.createElement("div");
  div.className = "block b-" + b.type + (b.type === "heading" ? " b-h" + (b.level || 1) : "");
  div.dataset.idx = i;

  const ctrl = document.createElement("span");
  ctrl.className = "b-controls";
  // 拖拽排序把手
  const dragBtn = document.createElement("span");
  dragBtn.className = "b-drag";
  dragBtn.textContent = "⠿";
  dragBtn.title = "拖动排序";
  dragBtn.draggable = true;
  dragBtn.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragIdx = i;
    div.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(i)); } catch (err) { /* 忽略 */ }
  });
  dragBtn.addEventListener("dragend", () => {
    div.classList.remove("dragging");
    clearDropLine();
    dragIdx = -1;
  });
  // 块类型切换
  const typeBtn = document.createElement("button");
  typeBtn.textContent = "Aa";
  typeBtn.title = "切换块类型";
  typeBtn.addEventListener("click", (e) => { e.stopPropagation(); fillTypeMenu(i, typeBtn); });
  const addBtn = document.createElement("button");
  addBtn.textContent = "＋";
  addBtn.title = "在此后添加块";
  addBtn.addEventListener("click", (e) => { e.stopPropagation(); insertBlockAfter(i); });
  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑";
  delBtn.className = "del";
  delBtn.title = "删除此块";
  delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteBlock(i); });
  ctrl.append(dragBtn, typeBtn, addBtn, delBtn);
  div.appendChild(ctrl);

  // 拖拽放置：在目标块上/下半区显示插入线
  div.addEventListener("dragover", (e) => {
    if (dragIdx < 0 || dragIdx === i) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = div.getBoundingClientRect();
    showDropLine(div, e.clientY < r.top + r.height / 2);
  });
  div.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragIdx < 0 || dragIdx === i) { clearDropLine(); return; }
    const r = div.getBoundingClientRect();
    moveBlock(dragIdx, i, e.clientY < r.top + r.height / 2);
    clearDropLine();
    dragIdx = -1;
  });

  const mark = document.createElement("span");
  mark.className = "b-mark";
  mark.contentEditable = "false";
  if (b.type === "bullet") mark.textContent = "•";
  else if (b.type === "ordered") mark.textContent = (b.num || 1) + ".";
  else if (b.type === "todo") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!b.checked;
    cb.addEventListener("change", () => { b.checked = cb.checked; });
    mark.appendChild(cb);
  } else if (b.type === "heading") mark.textContent = "H" + (b.level || 1);
  else if (b.type === "quote") mark.textContent = "❝";
  else if (b.type === "code") mark.textContent = b.lang || "{}";

  const content = document.createElement("div");
  content.className = "b-content";
  content.dataset.ph = phFor(b);
  if (b.type === "divider") {
    content.contentEditable = "false";
  } else {
    content.contentEditable = "true";
    content.innerHTML = MdBlocks.renderInline(b.content || "");
    content.addEventListener("input", () => onBlockInput(i, content));
    content.addEventListener("keydown", (e) => onBlockKeydown(e, i, content));
    content.addEventListener("focus", () => { activeBlock = content; hideSlashMenu(); });
  }
  div.append(mark, content);
  return div;
}

function renderBlocks() {
  blockEditor.innerHTML = "";
  blocks.forEach((b, i) => blockEditor.appendChild(buildBlockEl(b, i)));
}

// 行内富文本 DOM → markdown（保存/输入时读取）
function serializeRich(el) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.textContent; return; }
    const tag = node.tagName ? node.tagName.toLowerCase() : "";
    if (tag === "br") { out += "\n"; return; }
    if (tag === "strong" || tag === "b") { out += "**" + node.textContent + "**"; return; }
    if (tag === "em" || tag === "i") { out += "*" + node.textContent + "*"; return; }
    if (tag === "code") { out += "`" + node.textContent + "`"; return; }
    if (tag === "del" || tag === "s") { out += "~~" + node.textContent + "~~"; return; }
    if (tag === "a") { out += "[" + node.textContent + "](" + (node.getAttribute("href") || "") + ")"; return; }
    for (const c of node.childNodes) walk(c);
  };
  walk(el);
  return out;
}

function onBlockInput(i, content) {
  const b = blocks[i];
  if (!b) return;
  const text = content.textContent;
  if (text === "/" && b.content === "") { showSlashMenu(i, content); return; }
  hideSlashMenu();
  b.content = serializeRich(content);
  if (tryShortcut(b, text)) { rerenderBlock(i, 0); return; }
  if (i === 0 && b.type === "heading") syncTitleFromContent();
}

// 空块快捷输入转换
function tryShortcut(b, text) {
  let m;
  if ((m = text.match(/^(#{1,6}) $/))) { b.type = "heading"; b.level = m[1].length; b.content = ""; return true; }
  if (/^[-*] $/.test(text)) { b.type = "bullet"; b.content = ""; return true; }
  if ((m = text.match(/^(\d+)\. $/))) { b.type = "ordered"; b.num = parseInt(m[1], 10); b.content = ""; return true; }
  if ((m = text.match(/^- \[( |x|X)\] $/))) { b.type = "todo"; b.checked = m[1] !== " "; b.content = ""; return true; }
  if (/^> $/.test(text)) { b.type = "quote"; b.content = ""; return true; }
  if (/^-{3,}$/.test(text)) { b.type = "divider"; b.content = ""; return true; }
  return false;
}

function onBlockKeydown(e, i, content) {
  const b = blocks[i];
  if (!b) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    hideSlashMenu();
    if (b.type === "code") { insertLineBreak(content); b.content = serializeRich(content); return; }
    if (b.type === "divider") return;
    const full = content.textContent;
    if (full.trim() === "") {
      if (b.type !== "paragraph") {
        b.type = "paragraph"; b.content = "";
        rerenderBlock(i, 0);
      } else {
        blocks.splice(i + 1, 0, { type: "paragraph", content: "" });
        renderBlocks();
        focusBlock(i + 1, 0);
      }
      return;
    }
    const before = caretTextBefore(content);
    const after = full.slice(before.length);
    b.content = before;
    const nb = b.type === "heading"
      ? { type: "heading", level: b.level, content: after }
      : Object.assign(MdBlocks.emptyBlock(b.type), { content: after });
    blocks.splice(i + 1, 0, nb);
    renderBlocks();
    focusBlock(i + 1, 0);
    return;
  }
  if (e.key === "Backspace" && content.textContent === "") {
    e.preventDefault();
    hideSlashMenu();
    if (i === 0) { b.type = "paragraph"; rerenderBlock(0, 0); return; }
    blocks.splice(i, 1);
    renderBlocks();
    focusEnd(i - 1);
  }
}

function caretTextBefore(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString();
}

function insertLineBreak(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement("br");
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function rerenderBlock(i, caretOffset) {
  const child = blockEditor.children[i];
  if (!child || !blocks[i]) return;
  const nb = buildBlockEl(blocks[i], i);
  child.replaceWith(nb);
  if (caretOffset >= 0 && blocks[i].type !== "divider") {
    const c = nb.querySelector(".b-content");
    c.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(c.firstChild || c, caretOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function focusBlock(i, offset) {
  const child = blockEditor.children[i];
  if (!child) return;
  const c = child.querySelector(".b-content");
  if (!c || c.contentEditable === "false") return;
  c.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(c.firstChild || c, Math.min(offset || 0, (c.textContent || "").length));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusEnd(i) {
  const child = blockEditor.children[i];
  if (!child) return;
  const c = child.querySelector(".b-content");
  if (!c || c.contentEditable === "false") return;
  c.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(c);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertBlockAfter(i) {
  blocks.splice(i + 1, 0, { type: "paragraph", content: "" });
  renderBlocks();
  focusBlock(i + 1, 0);
}

// ── 拖拽排序 ──────────────────────────
function moveBlock(from, to, before) {
  if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to) return;
  const [b] = blocks.splice(from, 1);
  let target;
  if (from < to) target = before ? to - 1 : to;      // 向后移：目标索引-1 后落位
  else target = before ? to : to + 1;                // 向前移：索引不变
  blocks.splice(target, 0, b);
  renderBlocks();
  focusBlock(target, 0);
}

function showDropLine(div, before) {
  clearDropLine();
  const line = document.createElement("div");
  line.className = "drop-line" + (before ? "" : " after");
  div.appendChild(line);
}
function clearDropLine() {
  document.querySelectorAll(".drop-line").forEach((l) => l.remove());
}

function deleteBlock(i) {
  if (blocks.length <= 1) { blocks = [{ type: "paragraph", content: "" }]; renderBlocks(); return; }
  blocks.splice(i, 1);
  renderBlocks();
  focusBlock(Math.min(i, blocks.length - 1), 0);
}

// / 菜单
function showSlashMenu(i, content) {
  fillTypeMenu(i, content);
}

// ── 块类型切换菜单（Aa 按钮 / 斜杠共用） ──
const TYPE_ITEMS = [
  { t: "heading", level: 1, label: "H1 主标题" },
  { t: "heading", level: 2, label: "H2 副标题" },
  { t: "heading", level: 3, label: "H3 三级标题" },
  { t: "paragraph", label: "正文" },
  { t: "bullet", label: "• 无序列表" },
  { t: "ordered", label: "1. 有序列表" },
  { t: "todo", label: "☑ 待办事项" },
  { t: "quote", label: "❝ 引用" },
  { t: "code", label: "{ } 代码块" },
  { t: "divider", label: "— 分割线" },
];

function fillTypeMenu(i, anchor) {
  const b = blocks[i];
  slashMenu.innerHTML = `<div class="pop-title">块类型</div>` + TYPE_ITEMS.map((it) => {
    const active = b && b.type === it.t && (!it.level || b.level === it.level);
    return `<button data-t="${it.t}"${it.level ? ` data-level="${it.level}"` : ""}${active ? " class=\"active\"" : ""}>${it.label}</button>`;
  }).join("");
  slashMenu.dataset.idx = i;
  const r = anchor.getBoundingClientRect();
  slashMenu.style.left = Math.min(r.left, innerWidth - 190) + "px";
  slashMenu.style.top = Math.min(r.bottom + 4, innerHeight - 320) + "px";
  slashMenu.classList.add("show");
}

// 切换块类型并保留原内容（分割线除外）
function switchBlockType(i, type, level) {
  const b = blocks[i];
  if (!b) return;
  const keep = type === "divider" ? "" : (b.content || "");
  const nb = Object.assign(MdBlocks.emptyBlock(type), { content: keep });
  if (type === "heading" && level) nb.level = level;
  blocks[i] = nb;
  rerenderBlock(i, 0);
}

function hideSlashMenu() { slashMenu.classList.remove("show"); }

slashMenu.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (!b) return;
  const i = parseInt(slashMenu.dataset.idx, 10);
  if (blocks[i]) switchBlockType(i, b.dataset.t, b.dataset.level ? parseInt(b.dataset.level, 10) : undefined);
  hideSlashMenu();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#slashMenu")) hideSlashMenu();
});

// ── 通用命名弹窗（新建/重命名共用） ──────
const nameOverlay = $("nameOverlay");
let nameModalCb = null;

function showNameModal(opts) {
  nameModalCb = opts.onSubmit || null;
  $("nameModalTitle").textContent = opts.title || "输入名称";
  $("nameInput").placeholder = opts.placeholder || "名称";
  $("nameInput").value = opts.value || "";
  $("nameOk").textContent = opts.okText || "确定";
  nameOverlay.classList.add("show");
  setTimeout(() => { $("nameInput").focus(); $("nameInput").select(); }, 50);
}

function hideNameModal() { nameOverlay.classList.remove("show"); }

$("nameOk").addEventListener("click", async () => {
  const name = $("nameInput").value.trim();
  hideNameModal();
  if (!name || !nameModalCb) return;
  await nameModalCb(name);
});
$("nameCancel").addEventListener("click", hideNameModal);
$("nameClose").addEventListener("click", hideNameModal);
nameOverlay.addEventListener("click", (e) => { if (e.target === nameOverlay) hideNameModal(); });
$("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("nameOk").click();
  if (e.key === "Escape") hideNameModal();
});

// ── 笔记/文件夹生命周期 ─────────────────
async function resolveDir(path) {
  const parts = path.split("/").filter(Boolean);
  let dir = vaultRoot;
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return dir;
}

function cleanName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim();
}

async function doCreateNote(name, parentPath) {
  if (!vaultRoot) return;
  const fname = /\.(md|markdown|txt)$/i.test(name) ? cleanName(name) : cleanName(name) + ".md";
  try {
    const dir = parentPath ? await resolveDir(parentPath) : vaultRoot;
    const handle = await dir.getFileHandle(fname, { create: true });
    const w = await handle.createWritable();
    await w.write("# 新标题\n\n");
    await w.close();
    const fullPath = parentPath ? parentPath + fname : fname;
    await refreshTree();
    await openNote({ kind: "file", name: fname, path: fullPath }, findRow(fullPath));
    $("editorText").focus();
    $("editorText").setSelectionRange(2, 5);
    setMsg("➕ 已新建 " + fullPath + "（直接输入替换标题）");
  } catch (err) {
    setMsg("新建笔记失败: " + err.message, true);
  }
}

async function doCreateFolder(parentPath, name) {
  if (!vaultRoot) return;
  const clean = cleanName(name);
  if (!clean) return;
  try {
    const dir = parentPath ? await resolveDir(parentPath) : vaultRoot;
    await dir.getDirectoryHandle(clean, { create: true });
    await refreshTree();
    setMsg("📁 已新建文件夹 " + (parentPath || "") + clean);
  } catch (err) {
    setMsg("新建文件夹失败: " + err.message, true);
  }
}

// 递归复制目录内容（重命名文件夹用）
async function copyDir(srcDir, dstDir) {
  for await (const [name, handle] of srcDir.entries()) {
    if (handle.kind === "directory") {
      const sub = await dstDir.getDirectoryHandle(name, { create: true });
      await copyDir(handle, sub);
    } else {
      const f = await dstDir.getFileHandle(name, { create: true });
      const content = await readFileText(handle);
      const w = await f.createWritable();
      await w.write(content);
      await w.close();
    }
  }
}

async function doRename(item, newName) {
  const clean = cleanName(newName);
  if (!clean || clean === item.name) return;
  try {
    const parentPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const parent = parentPath ? await resolveDir(parentPath) : vaultRoot;
    if (item.kind === "file") {
      const fname = /\.(md|markdown|txt)$/i.test(clean) ? clean : clean + ".md";
      const oldHandle = await resolveHandle(item.path);
      const newHandle = await parent.getFileHandle(fname, { create: true });
      const content = await readFileText(oldHandle);
      const w = await newHandle.createWritable();
      await w.write(content);
      await w.close();
      await parent.removeEntry(item.name);
      if (currentNote && currentNote.path === item.path) {
        currentNote.name = fname;
        currentNote.path = (parentPath ? parentPath : "") + fname;
        currentNote.handle = newHandle;
      }
    } else {
      const newDir = await parent.getDirectoryHandle(clean, { create: true });
      await copyDir(await resolveDir(item.path), newDir);
      await parent.removeEntry(item.name, { recursive: true });
    }
    await refreshTree();
    setMsg("✏️ 已重命名 " + item.name + " → " + clean);
  } catch (err) {
    setMsg("重命名失败: " + err.message, true);
  }
}

function resetEditor() {
  currentNote = null;
  blocks = [];
  $("editorText").value = "";
  $("noteTitle").value = "";
  $("editorText").disabled = true;
  $("noteTitle").disabled = true;
  $("saveBtn").disabled = true;
  $("blockEditor").innerHTML = "";
}

async function doDelete(item) {
  const tip = item.kind === "dir" ? "整个文件夹（含所有内容）" : "这篇笔记";
  if (!confirm(`确定删除「${item.name}」？${tip}将被永久删除，此操作不可撤销。`)) return;
  try {
    const parentPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const parent = parentPath ? await resolveDir(parentPath) : vaultRoot;
    if (item.kind === "dir") {
      await parent.removeEntry(item.name, { recursive: true });
    } else {
      await parent.removeEntry(item.name);
      if (currentNote && currentNote.path === item.path) resetEditor();
    }
    await refreshTree();
    setMsg("🗑 已删除 " + item.name);
  } catch (err) {
    setMsg("删除失败: " + err.message, true);
  }
}

function renameItem(item) {
  showNameModal({
    title: "✏️ 重命名" + (item.kind === "dir" ? "文件夹" : ""),
    value: item.name,
    placeholder: "新名称",
    okText: "重命名",
    onSubmit: (name) => doRename(item, name),
  });
}

function findRow(path) {
  const rows = document.querySelectorAll("#tree .tree-row");
  for (const r of rows) if (r.title === path) return r;
  return null;
}

// ── 搜索（防抖 + 全文） ──────────────
let searchTimer = null;
$("searchBox").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await renderTree(treeData);
  }, 200);
});

// ── 批量选择导出（勾选模式） ─────────
function enterSelectMode() {
  selectMode = true;
  selected.clear();
  searchTerm = ""; // 清空搜索，全量展示
  const sb = $("searchBox");
  if (sb) sb.value = "";
  $("treeTitleText").textContent = "选择笔记";
  $("normalActions").style.display = "none";
  $("exportBtn").style.display = "none";
  $("selectBar").style.display = "flex";
  updateSelUI();
  renderTree(treeData);
}

function exitSelectMode() {
  selectMode = false;
  selected.clear();
  $("treeTitleText").textContent = "笔记库";
  $("normalActions").style.display = "";
  $("exportBtn").style.display = "";
  $("selectBar").style.display = "none";
  renderTree(treeData);
}

function toggleSelect(item) {
  if (item.kind === "file") {
    selected.has(item.path) ? selected.delete(item.path) : selected.add(item.path);
  } else {
    const files = [];
    const collect = (its) => its.forEach((x) => x.kind === "file" ? files.push(x.path) : collect(x.children));
    collect(item.children || []);
    const allSel = files.length > 0 && files.every((f) => selected.has(f));
    files.forEach((f) => allSel ? selected.delete(f) : selected.add(f));
  }
}

function selectAll(invert) {
  const files = [];
  const collect = (its) => its.forEach((x) => x.kind === "file" ? files.push(x.path) : collect(x.children));
  collect(treeData);
  if (invert) {
    files.forEach((f) => selected.has(f) ? selected.delete(f) : selected.add(f));
  } else {
    const allSel = files.length > 0 && files.every((f) => selected.has(f));
    if (allSel) selected.clear();
    else files.forEach((f) => selected.add(f));
  }
  updateSelUI();
}

function updateSelUI() {
  $("selCount").textContent = "已选 " + selected.size + " 项";
  $("selExportBtn").textContent = selected.size ? `📤 导出所选(${selected.size})` : "📤 导出所选";
  document.querySelectorAll("#tree .sel-cb").forEach((cb) => {
    const it = findSubtree(treeData, cb.dataset.path);
    if (!it) return;
    if (it.kind === "file") {
      cb.checked = selected.has(it.path);
      cb.indeterminate = false;
    } else {
      const files = [];
      const collect = (its) => its.forEach((x) => x.kind === "file" ? files.push(x.path) : collect(x.children));
      collect(it.children || []);
      const selCnt = files.filter((f) => selected.has(f)).length;
      cb.checked = files.length > 0 && selCnt === files.length;
      cb.indeterminate = selCnt > 0 && selCnt < files.length;
    }
  });
}

async function exportSelected() {
  if (!selected.size) { setMsg("请先勾选要导出的笔记", true); return; }
  try {
    const files = [];
    const walk = async (items) => {
      for (const it of items) {
        if (it.kind === "file" && selected.has(it.path)) {
          const handle = await resolveHandle(it.path);
          files.push({ path: it.path, content: await readFileText(handle) });
        } else if (it.kind === "dir") await walk(it.children);
      }
    };
    await walk(treeData);
    const blob = new Blob([MdBackup.zipStore(files)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    a.href = url;
    a.download = "minddepot-selected-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const n = files.length;
    exitSelectMode();
    setMsg(`📤 已导出 ${n} 个笔记`);
  } catch (err) {
    setMsg("导出失败: " + err.message, true);
  }
}

// ── 备份导出 / 导入 ──────────────────
function findSubtree(items, path) {
  for (const it of items) {
    if (it.path === path) return it;
    if (it.kind === "dir" && path.startsWith(it.path)) {
      const r = findSubtree(it.children, path);
      if (r) return r;
    }
  }
  return null;
}

// 导出：无参 = 全部；传目录 = 该目录 zip；传文件 = 直接下载 .md
async function exportBackup(basePath = "") {
  if (!vaultRoot) { setMsg("请先打开笔记库", true); return; }
  try {
    let roots = treeData, base = "", exportName = "minddepot-backup";
    if (basePath) {
      const node = findSubtree(treeData, basePath);
      if (!node) { setMsg("导出目标不存在", true); return; }
      if (node.kind === "file") {
        // 单文件：直接下载 .md 原文件
        const handle = await resolveHandle(node.path);
        const content = await readFileText(handle);
        const blob = new Blob([content], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = node.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setMsg("📤 已导出 " + node.name);
        return;
      }
      roots = node.children || [];
      base = node.path; // zip 内保留文件夹名
      exportName = node.name;
    }
    const files = [];
    const walk = async (items, prefix) => {
      for (const it of items) {
        if (it.kind === "dir") {
          files.push({ path: prefix + it.name + "/", content: "" });
          await walk(it.children, prefix + it.name + "/");
        } else {
          const handle = await resolveHandle(it.path);
          files.push({ path: prefix + it.name, content: await readFileText(handle) });
        }
      }
    };
    await walk(roots, base);
    const blob = new Blob([MdBackup.zipStore(files)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    a.href = url;
    a.download = exportName + "-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setMsg(`📤 已导出 ${files.filter((f) => !f.path.endsWith("/")).length} 个笔记`);
  } catch (err) {
    setMsg("导出失败: " + err.message, true);
  }
}

async function importBackup() {
  if (!vaultRoot) { setMsg("请先打开笔记库", true); return; }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const files = await MdBackup.parseZip(await file.arrayBuffer());
      let n = 0;
      for (const f of files) {
        // 安全过滤：跳过路径穿越 / 绝对路径条目
        if (f.path.includes("..") || f.path.startsWith("/") || f.path.includes("\\")) continue;
        if (f.path.endsWith("/")) continue; // 目录条目：写文件时自动创建
        const parts = f.path.split("/").filter(Boolean);
        let dir = vaultRoot;
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(f.content);
        await w.close();
        n++;
      }
      await refreshTree();
      setMsg(`📥 已导入 ${n} 个笔记`);
    } catch (err) {
      setMsg("导入失败: " + err.message, true);
    }
  });
  input.click();
}

// ── 最近笔记（localStorage 持久化，最多 10 条） ──
let recentNotes = [];
try { recentNotes = JSON.parse(localStorage.getItem("md_note_recent") || "[]"); } catch (e) { /* 忽略 */ }
function saveRecent() { try { localStorage.setItem("md_note_recent", JSON.stringify(recentNotes.slice(0, 10))); } catch (e) { /* 忽略 */ } }
function pushRecent(item) {
  recentNotes = recentNotes.filter((r) => r.path !== item.path);
  recentNotes.unshift({ path: item.path, name: item.name });
  saveRecent();
}

// ── 页面位置记忆（按块索引，localStorage 持久化） ──
let notePositions = {};
try { notePositions = JSON.parse(localStorage.getItem("md_note_positions") || "{}"); } catch (e) { /* 忽略 */ }

// 保存当前笔记离开位置：视口顶部第一个可见块的索引
function saveNotePos() {
  if (!currentNote || !blockEditor.children.length) return;
  const st = blockEditor.scrollTop;
  const els = blockEditor.children;
  let idx = 0;
  for (let i = 0; i < els.length; i++) {
    if (els[i].offsetTop >= st) { idx = Math.max(0, i - 1); break; }
    idx = i;
  }
  notePositions[currentNote.path] = idx;
  try { localStorage.setItem("md_note_positions", JSON.stringify(notePositions)); } catch (e) { /* 忽略 */ }
}

// 恢复指定笔记的离开位置
function restoreNotePos(path) {
  const idx = notePositions[path];
  if (idx == null || !blockEditor.children[idx]) return;
  blockEditor.children[idx].scrollIntoView({ block: "start" });
}

function renderRecent() {
  const m = $("recentMenu");
  if (!recentNotes.length) {
    m.innerHTML = '<div class="pop-title">最近打开</div><div class="pop-empty">还没有打开过笔记</div>';
    return;
  }
  m.innerHTML = `<div class="pop-title">最近打开</div>` + recentNotes.map((r) =>
    `<button data-path="${escapeHtml(r.path)}">📄 ${escapeHtml(r.name)}</button>`
  ).join("");
  m.querySelectorAll("button[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const node = findSubtree(treeData, btn.dataset.path);
      m.classList.remove("show");
      if (node) openNote(node, null);
      else setMsg("⚠️ 笔记已被移动或删除", true);
    });
  });
}

// ── 排序菜单 ──────────────────────────
function refreshSortBtn() {
  const desc = { name: "文件名", time: "修改时间" }[sortMode];
  const dir = sortDir === "asc" ? (sortMode === "name" ? "正序" : "最旧在前") : (sortMode === "name" ? "逆序" : "最新在前");
  $("sortBtn").title = `排序：${desc} · ${dir}`;
  $("sortBtn").textContent = sortMode === "time" ? (sortDir === "asc" ? "🕐" : "🕓") : (sortDir === "asc" ? "🔃" : "🔀");
}

// 仅重排现有 treeData（不重新走目录，快）
function sortTreeData() {
  const sortRec = (items) => {
    items.sort(sortItems);
    items.forEach((it) => { if (it.kind === "dir") sortRec(it.children); });
  };
  sortRec(treeData);
  renderTree(treeData);
}

// ── 事件 ──────────────────────────────
$("openVaultBtn").addEventListener("click", openVault);
$("saveBtn").addEventListener("click", saveNote);
$("exportBtn").addEventListener("click", () => {
  if (selectMode) exportSelected();
  else enterSelectMode();
});
$("selAllBtn").addEventListener("click", () => selectAll(false));
$("selInvertBtn").addEventListener("click", () => selectAll(true));
$("selClearBtn").addEventListener("click", exitSelectMode);
$("selExportBtn").addEventListener("click", exportSelected);
$("sortBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const r = $("sortBtn").getBoundingClientRect();
  const m = $("sortMenu");
  m.style.left = Math.min(r.left, innerWidth - 190) + "px";
  m.style.top = r.bottom + 6 + "px";
  m.classList.toggle("show");
  m.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.sort === sortMode + "-" + sortDir);
  });
});
$("sortMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]");
  if (!b) return;
  const [m, d] = b.dataset.sort.split("-");
  sortMode = m; sortDir = d;
  saveSort();
  $("sortMenu").classList.remove("show");
  refreshSortBtn();
  sortTreeData();
});
document.addEventListener("click", () => $("sortMenu").classList.remove("show"));
refreshSortBtn(); // 启动时同步排序按钮状态

// 最近笔记菜单交互
$("recentBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  renderRecent();
  const r = $("recentBtn").getBoundingClientRect();
  const m = $("recentMenu");
  m.style.left = Math.min(r.left, innerWidth - 200) + "px";
  m.style.top = r.bottom + 6 + "px";
  m.classList.toggle("show");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#recentMenu") && !e.target.closest("#recentBtn")) $("recentMenu").classList.remove("show");
});

// 页面关闭/隐藏时保存当前笔记位置
window.addEventListener("pagehide", saveNotePos);

// ── 笔记大纲导航 ──────────────────────
const outlineBtn = $("outlineBtn");
const outlinePanel = $("outlinePanel");

function renderOutline() {
  const items = [];
  blocks.forEach((b, i) => { if (b.type === "heading") items.push({ level: b.level || 1, content: b.content || "", idx: i }); });
  const nav = `<div class="outline-nav">` +
    `<button type="button" data-nav="prev-ch" title="上一章">⏮ 章</button>` +
    `<button type="button" data-nav="prev-sec" title="上一节">↑ 节</button>` +
    `<button type="button" data-nav="next-sec" title="下一节">↓ 节</button>` +
    `<button type="button" data-nav="next-ch" title="下一章">章 ⏭</button>` +
    `<input type="number" id="gotoSec" min="1" placeholder="节号">` +
    `<button type="button" data-nav="goto" title="跳转到第 N 节">跳转</button>` +
    `</div>`;
  if (!items.length) {
    outlinePanel.innerHTML = nav + '<div class="outline-empty">此笔记没有标题块</div>';
    bindOutlineNav();
    return;
  }
  outlinePanel.innerHTML = nav + items.map((it) =>
    `<button class="outline-item" data-idx="${it.idx}" style="padding-left:${8 + (it.level - 1) * 14}px">${escapeHtml(it.content) || "(空标题)"}</button>`
  ).join("");
  outlinePanel.querySelectorAll(".outline-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const el = blockEditor.children[idx];
      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); flashEl(el); }
      outlinePanel.classList.remove("show");
    });
  });
  bindOutlineNav();
}

// ── 节数跳转 ──────────────────────────
function headingBlocks() {
  const hs = [];
  blocks.forEach((b, i) => { if (b.type === "heading") hs.push({ idx: i, level: b.level || 1 }); });
  return hs;
}

// 当前视口顶部附近的标题块在大纲中的位置（-1 = 首个节之前）
function currentHeadingPos() {
  const st = blockEditor.scrollTop;
  const hs = headingBlocks();
  let pos = -1;
  for (let k = 0; k < hs.length; k++) {
    const el = blockEditor.children[hs[k].idx];
    if (!el || el.offsetTop > st + 40) break;
    pos = k;
  }
  return pos;
}

function gotoBlock(idx) {
  const el = blockEditor.children[idx];
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  flashEl(el);
}

// 上/下一节（offset ±1）
function navSection(offset) {
  const hs = headingBlocks();
  if (!hs.length) return;
  const cur = currentHeadingPos();
  const target = Math.max(0, Math.min(hs.length - 1, cur + offset));
  gotoBlock(hs[target].idx);
}

// 上/下一章（level 1 标题）
function navChapter(offset) {
  const hs = headingBlocks();
  if (!hs.length) return;
  const cur = currentHeadingPos();
  if (offset > 0) {
    for (let i = cur + 1; i < hs.length; i++) if (hs[i].level === 1) { gotoBlock(hs[i].idx); return; }
  } else {
    for (let i = cur - 1; i >= 0; i--) if (hs[i].level === 1) { gotoBlock(hs[i].idx); return; }
    gotoBlock(hs[0].idx); // 前面没有章：回第一个节
  }
}

function bindOutlineNav() {
  outlinePanel.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = btn.dataset.nav;
      if (act === "prev-sec") navSection(-1);
      else if (act === "next-sec") navSection(1);
      else if (act === "prev-ch") navChapter(-1);
      else if (act === "next-ch") navChapter(1);
      else if (act === "goto") {
        const n = parseInt(outlinePanel.querySelector("#gotoSec").value, 10);
        const hs = headingBlocks();
        if (!isNaN(n) && n >= 1 && n <= hs.length) gotoBlock(hs[n - 1].idx);
        else setMsg(`⚠️ 节号应在 1-${hs.length} 之间`, true);
      }
    });
  });
}

outlineBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderOutline(); // 每次打开实时刷新
  outlinePanel.classList.toggle("show");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#outlinePanel") && !e.target.closest("#outlineBtn")) outlinePanel.classList.remove("show");
});
$("importBtn").addEventListener("click", importBackup);

// 新建按钮（顶栏 ➕ 与树标题栏 ➕ 都指向根目录新建）
$("newNoteBtn").addEventListener("click", () => showNameModal({
  title: "➕ 新建笔记",
  placeholder: "笔记名称（.md 自动补全）",
  okText: "创建",
  onSubmit: (n) => doCreateNote(n, ""),
}));
$("newFolderBtn").addEventListener("click", () => showNameModal({
  title: "📁 新建文件夹",
  placeholder: "文件夹名称",
  okText: "创建",
  onSubmit: (n) => doCreateFolder("", n),
}));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveNote();
  }
  if (e.key === "Escape") {
    closeDrawer();
    closeEditPanel();
    insertMenu.classList.remove("show");
    hideNameModal();
    ctxMenu.classList.remove("show");
    hideSlashMenu();
  }
});

// 移动端抽屉
function closeDrawer() {
  $("treeAside").classList.remove("show");
  $("backdrop").classList.remove("show");
}
$("drawerBtn").addEventListener("click", () => {
  $("treeAside").classList.toggle("show");
  $("backdrop").classList.toggle("show");
});
$("backdrop").addEventListener("click", closeDrawer);

// 横幅关闭
$("bannerClose").addEventListener("click", () => {
  $("banner").style.display = "none";
  try { localStorage.setItem("md_note_banner_closed", "1"); } catch (e) { /* 忽略 */ }
});
if (localStorage.getItem("md_note_banner_closed")) $("banner").style.display = "none";

// ── 主题切换（日间 / 夜间 / 跟随系统，三态循环） ──
const THEME_MODES = [
  { key: "auto",  icon: "🖥", label: "跟随系统" },
  { key: "light", icon: "☀️", label: "日间" },
  { key: "dark",  icon: "🌙", label: "夜间" },
];
let themeIdx = 0;
const themeBtn = $("themeBtn");
const metaTheme = document.querySelector('meta[name="theme-color"]');

function syncThemeColor(key) {
  if (!metaTheme) return;
  const dark = key === "dark" || (key === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  metaTheme.content = dark ? "#0f1115" : "#f6f7f9";
}

function applyTheme(idx, persist) {
  idx = ((idx % THEME_MODES.length) + THEME_MODES.length) % THEME_MODES.length;
  themeIdx = idx;
  const m = THEME_MODES[idx];
  if (m.key === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", m.key);
  if (persist) { try { localStorage.setItem("md_note_theme", m.key); } catch (e) { /* 忽略 */ } }
  themeBtn.innerHTML = m.icon + '<span class="theme-lbl"> ' + m.label + "</span>";
  themeBtn.title = "主题：" + m.label + "（点击切换）";
  syncThemeColor(m.key);
}

(function themeInit() {
  let cur = "auto";
  try { cur = localStorage.getItem("md_note_theme") || "auto"; } catch (e) { /* 忽略 */ }
  const idx = THEME_MODES.findIndex((m) => m.key === cur);
  applyTheme(idx < 0 ? 0 : idx, false);
  themeBtn.addEventListener("click", () => applyTheme(themeIdx + 1, true));
  // 跟随系统模式：系统深浅变化时同步浏览器 UI 颜色
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (THEME_MODES[themeIdx].key === "auto") syncThemeColor("auto");
    });
  } catch (e) { /* 忽略 */ }
})();

// ── PWA ───────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* 忽略 */ });
}

// ── 启动 ──────────────────────────────
(async function init() {
  if (!hasFSA) {
    // iOS 等无 FSA 环境：自动打开 OPFS 沙箱笔记库
    vaultRoot = await navigator.storage.getDirectory();
    vaultMode = "opfs";
    $("vaultName").textContent = "📦 本地沙箱笔记库";
    $("newNoteBtn").disabled = false;
    await refreshTree();
    setMsg("✅ 已自动打开浏览器私有笔记库");
  }
})();
