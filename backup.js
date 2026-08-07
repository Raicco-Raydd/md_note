/* backup.js — MindDepot Note 备份引擎（zip 打包/解析，无外部依赖）
 * 导出：STORE 模式（不压缩，简单可靠，保留目录结构）
 * 导入：兼容标准 zip（STORE 直接读；DEFLATE 用 DecompressionStream('deflate-raw')）
 * 纯逻辑，浏览器 / Node 通用
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MdBackup = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── CRC32 ───────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8");

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

  // ── 导出：打包为 STORE zip ──────────
  // files: [{ path: "dir/note.md", content: "文本" }]（path 以 / 结尾 = 目录，content 可空）
  function zipStore(files) {
    const nameBufs = files.map((f) => enc.encode(f.path));
    const dataBufs = files.map((f) => enc.encode(f.content || ""));
    const crcs = files.map((f, i) => crc32(dataBufs[i]));
    const sizes = dataBufs.map((b) => b.length);

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (let i = 0; i < files.length; i++) {
      const nb = nameBufs[i];
      const head = new Uint8Array(30);
      head.set([0x50, 0x4b, 0x03, 0x04]);           // local header sig
      head.set(u16(20), 4);                          // version needed
      head.set(u16(0x0800), 6);                      // flags: UTF-8
      head.set(u16(0), 8);                           // method: STORE
      head.set(u16(0), 10); head.set(u16(0), 12);    // time/date
      head.set(u32(crcs[i]), 14);
      head.set(u32(sizes[i]), 18);
      head.set(u32(sizes[i]), 22);
      head.set(u16(nb.length), 26);
      head.set(u16(0), 28);                          // extra len
      localParts.push(head, nb, dataBufs[i]);

      const cent = new Uint8Array(46);
      cent.set([0x50, 0x4b, 0x01, 0x02]);           // central dir sig
      cent.set(u16(20), 4);                          // version made by
      cent.set(u16(20), 6);                          // version needed
      cent.set(u16(0x0800), 8);                      // flags: UTF-8
      cent.set(u16(0), 10);                          // method
      cent.set(u16(0), 12); cent.set(u16(0), 14);
      cent.set(u32(crcs[i]), 16);
      cent.set(u32(sizes[i]), 20);
      cent.set(u32(sizes[i]), 24);
      cent.set(u16(nb.length), 28);
      cent.set(u16(0), 30);                          // extra
      cent.set(u16(0), 32);                          // comment
      cent.set(u16(0), 34);                          // disk
      cent.set(u16(0), 36);                          // internal attrs
      cent.set(u32(0), 38);                          // external attrs
      cent.set(u32(offset), 42);                     // local header offset
      centralParts.push(cent, nb);

      offset += 30 + nb.length + sizes[i];
    }

    // EOCD
    const cdSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    eocd.set([0x50, 0x4b, 0x05, 0x06]);
    eocd.set(u16(0), 4); eocd.set(u16(0), 6);
    eocd.set(u16(files.length), 8);
    eocd.set(u16(files.length), 10);
    eocd.set(u32(cdSize), 12);
    eocd.set(u32(offset), 16);
    eocd.set(u16(0), 20);

    const total = offset + cdSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of localParts) { out.set(p, pos); pos += p.length; }
    for (const p of centralParts) { out.set(p, pos); pos += p.length; }
    out.set(eocd, pos);
    return out;
  }

  // ── 导入：解析 zip ──────────────────
  async function parseZip(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 找 EOCD（尾部 22 字节，允许注释）
    let eocdPos = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new Error("不是有效的 zip 文件");

    const totalEntries = view.getUint16(eocdPos + 10, true);
    const cdOffset = view.getUint32(eocdPos + 16, true);
    const files = [];

    let p = cdOffset;
    for (let n = 0; n < totalEntries; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break; // 中央目录头
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      // 本地文件头
      const lh = localOffset;
      const lNameLen = view.getUint16(lh + 26, true);
      const lExtraLen = view.getUint16(lh + 28, true);
      const dataStart = lh + 30 + lNameLen + lExtraLen;
      let content = "";
      if (method === 0) {
        content = dec.decode(bytes.subarray(dataStart, dataStart + compSize));
      } else if (method === 8) {
        // DEFLATE（raw）→ DecompressionStream
        const raw = bytes.subarray(dataStart, dataStart + compSize);
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        const outBuf = await new Response(stream).arrayBuffer();
        content = dec.decode(outBuf);
      } else {
        throw new Error("不支持的压缩方式: " + method + "（" + name + "）");
      }
      files.push({ path: name, content });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  return { zipStore, parseZip, crc32 };
});
