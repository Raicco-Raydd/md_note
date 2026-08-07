# MindDepot Note（md_note）

图形化 Markdown 笔记工具 —— **手机 / iPad / PC 三位一体**，本地优先，数据不出浏览器。

> 代号 MD_Note（MD = Markdown 双关）｜**v4.5.0**（2026-08-07）

## 核心特性

- 📚 **笔记库**：打开一个文件夹（PC/安卓）或浏览器私有存储（iOS），管理全部笔记
- 🌳 **笔记树**：多级文件夹 + 引导线
- 🔎 **全文搜索**：文件名 / 标题 / 正文三级匹配，防抖 200ms，命中显示上下文摘要 + 关键词高亮（索引按 vault 变更自动失效重建，大文件只匹配文件名）
- ✏️ **编辑预览**：左编辑器 / 右实时预览（桌面并排，移动端上下堆叠）
- 💾 **保存**：Ctrl+S，直接写回原文件（FSA）或沙箱（OPFS）
- 📱 **三位一体**：一套代码跑 PC / 安卓平板手机 / iPhone iPad
- 🔌 **离线可用**：PWA + Service Worker
- 📤 **备份/恢复**：一键导出 zip（保留目录结构）+ 导入恢复（兼容标准 zip，含 DEFLATE），OPFS 用户数据安全感

## 平台能力

| 平台 | 存储模式 | 能力 |
|---|---|---|
| PC（Chrome/Edge） | FSA 真实文件夹 | 完整 |
| MatePad / 安卓（Chrome/Edge） | FSA 真实文件夹 | 完整 |
| iPhone / iPad（Safari） | OPFS 浏览器沙箱 | 完整（数据在浏览器内） |

## 本地运行

```bash
cd md_note
py -m http.server 8890
# 打开 http://127.0.0.1:8890
```

## 技术栈

- 纯前端（无后端）：HTML/CSS/JS
- `mdutils.js`：mdutils 引擎的 JS 移植（解析/编辑）
- marked + highlight.js：渲染与高亮（本地化，离线可用）
- File System Access API（FSA）+ Origin Private File System（OPFS）统一数据层

## 文件结构

```
md_note/
├── index.html            # 应用壳
├── app.js                # 应用逻辑（统一数据层 + 笔记树 + 编辑）
├── mdutils.js            # mdutils 引擎 JS 移植
├── marked.min.js         # Markdown 渲染
├── highlight.min.js      # 代码高亮
├── manifest.webmanifest  # PWA 清单
├── sw.js                 # Service Worker（离线缓存）
└── README.md
```
