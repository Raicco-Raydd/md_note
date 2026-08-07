/* backup.test.js — 备份引擎测试（zip 打包/解析）
 */
"use strict";
const zlib = require("zlib");
const MdBackup = require("./backup.js");
const { zipStore, parseZip, crc32 } = MdBackup;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg); }
}
async function test() {
  console.log("== crc32 ==");
  ok(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "标准校验值 0xCBF43926");
  ok(crc32(new TextEncoder().encode("")) === 0, "空串 CRC 为 0");

  console.log("== zipStore → parseZip 往返 ==");
  const files = [
    { path: "密位测距法.md", content: "# 密位测距法\n\n距离 = 尺寸 × 1000 ÷ 密位\n" },
    { path: "战术学基础/战术学基础.md", content: "# 战术学基础\n\n研究战斗规律\n" },
    { path: "美军视角下PLA作战方法/美军视角下PLA作战方法.md", content: "# A2/AD\n\n灰色地带竞争\n" },
    { path: "空目录/", content: "" },
  ];
  const buf = zipStore(files);
  const back = await parseZip(buf);
  ok(back.length === 4, "条目数一致（含空目录）");
  const byPath = Object.fromEntries(back.map((f) => [f.path, f.content]));
  ok(byPath["密位测距法.md"].includes("密位"), "中文内容往返一致");
  ok(byPath["战术学基础/战术学基础.md"].includes("战斗规律"), "多级目录路径正确");
  ok(byPath["美军视角下PLA作战方法/美军视角下PLA作战方法.md"].includes("A2/AD"), "特殊字符内容往返一致");
  ok("空目录/" in byPath, "空目录条目保留");

  console.log("== 外部 DEFLATE zip 解析 ==");
  // 手写一个 method=8 的 zip（用 zlib.deflateRawSync 生成 raw deflate 数据）
  const name = "压缩文件.md";
  const content = "# 压缩内容\n\n这是用 DEFLATE 压缩的中文内容，用于测试导入兼容性。\n";
  const nameBytes = Buffer.from(name, "utf8");
  const data = zlib.deflateRawSync(Buffer.from(content, "utf8"));
  const crc = crc32(new TextEncoder().encode(content));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); // method=DEFLATE
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(content, "utf8"), 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const localFull = Buffer.concat([local, nameBytes, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(content, "utf8"), 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42); // local offset
  const centralFull = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralFull.length, 12);
  eocd.writeUInt32LE(localFull.length, 16);

  const deflateZip = Buffer.concat([localFull, centralFull, eocd]);
  const parsed = await parseZip(deflateZip);
  ok(parsed.length === 1 && parsed[0].path === "压缩文件.md", "DEFLATE 条目路径正确");
  ok(parsed[0].content.includes("压缩内容") && parsed[0].content.includes("中文内容"), "DEFLATE 解压内容正确");

  console.log("== 异常处理 ==");
  let threw = false;
  try { await parseZip(new Uint8Array([1, 2, 3])); } catch (e) { threw = true; }
  ok(threw, "非 zip 数据抛错");

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
}
test().catch((e) => { console.error(e); process.exit(1); });
