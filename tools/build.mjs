/* 打包：把 src/ 打成一个可以直接转发给测试者的 zip。

   zip 内结构（解压即得到可直接加载的扩展目录）：
     bilingual-reader-v0.3.0/
       manifest.json, background.js, content.js, ...
       安装说明.txt          <- 给测试者看的

   不依赖任何第三方库：自己写最小 ZIP（deflate + CRC32），
   文件名按 UTF-8 标记，Windows / macOS 解压都不会乱码。

   用法：node tools/build.mjs */

import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const manifest = JSON.parse(readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const NAME = `bilingual-reader-v${manifest.version}`;
const OUT = path.join(DIST, `${NAME}.zip`);

/* ---------- 收集要打包的文件 ---------- */

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

// src/README.md 是给开发者看的，不进测试包
const files = walk(SRC).filter((f) => f !== "README.md");

if (!files.includes("manifest.json")) {
  console.error("src/manifest.json 不存在，打包中止");
  process.exit(1);
}

/* ---------- 给测试者的安装说明 ---------- */

const GUIDE_LINES = [
  `双语对照翻译 v${manifest.version} 测试版 安装说明`,
  "================================================",
  "",
  "这是一个浏览器扩展（Chrome / Edge），装上以后可以把网页上的英文内容翻成中文：",
  "标题和正文的译文直接显示在原文下面，分类标签、导航这类外围内容鼠标移上去才显示。",
  "",
  "一、安装（约 1 分钟）",
  "--------------------",
  "1. 把本压缩包解压到一个固定目录，例如 D:\\tools\\bilingual-reader",
  "2. Chrome 地址栏输入 chrome://extensions/ 回车（Edge 用 edge://extensions/）",
  "3. 打开右上角的「开发者模式」",
  "4. 点左上角「加载已解压的扩展程序」",
  "5. 选中第 1 步解压出来的文件夹（里面有 manifest.json 的那个）",
  "6. 装好后点浏览器右上角拼图图标，把本扩展「固定」到工具栏",
  "",
  "二、使用",
  "--------",
  "· 打开任意英文网页（Google 搜索、维基百科、Nexus Mods 等）",
  "· 点扩展图标 ->「翻译此页」，或直接按 Alt+T",
  "· 标题和正文：译文显示在原文下面",
  "· 分类标签、导航、元信息：鼠标悬停在上面才弹出译文",
  "· 再点一次「还原原文」即可恢复，原文不会被动过一个字节",
  "· 工具栏图标上的数字 = 当前页面已翻译的块数",
  "",
  "三、第一次用请先点「保存并测试」",
  "--------------------------------",
  "默认引擎是 MyMemory（免费、免注册）。点「保存并测试」，出现对勾就说明能用了。",
  "",
  "建议顺手在「邮箱」框里填一个邮箱：",
  "不填每天约 5000 词的免费额度，填了约 50000 词，测试时不容易用完。",
  "",
  "四、想要更好的翻译质量（可选）",
  "------------------------------",
  "弹窗里的「翻译引擎」可以换：",
  "· 百度翻译开放平台 —— 国内最快，标准版每月 5 万字符免费",
  "· 彩云小译 —— 国内快，个人额度友好",
  "· DeepSeek 等 OpenAI 兼容接口 —— 质量最好（能结合整页语境、术语统一），",
  "  填「接口地址 + API Key + 模型名」即可，按 token 计费",
  "· Google 翻译 —— 需要你的网络能访问 Google",
  "",
  "五、遇到问题怎么反馈",
  "--------------------",
  "请尽量带上这三样，定位会快很多：",
  "1. 是哪个网站、哪一块内容（截图最好）",
  "2. 弹窗里显示的状态文字（它会显示具体错误原因）",
  "3. 点一次「诊断连接」后显示的结果",
  "",
  "六、已知限制",
  "------------",
  "· 开发者模式加载，Chrome 启动时可能提示一次，忽略即可",
  "· 输入框、代码块、网址不会被翻译（故意的）",
  "· 用户名和作者名默认不翻（弹窗里可关）",
  "· 跨域 iframe 里的内容不处理",
  "",
];
const GUIDE = GUIDE_LINES.join("\n");

/* ---------- 最小 ZIP 写入 ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要的最低解压版本
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 时间固定，保证同一份代码打出的包可复现
    local.writeUInt16LE(0x21, 12); // 日期固定为 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ---------- 打包 ---------- */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const entries = files.map((rel) => ({
  name: `${NAME}/${rel}`,
  data: readFileSync(path.join(SRC, rel)),
}));
entries.push({ name: `${NAME}/安装说明.txt`, data: Buffer.from(GUIDE, "utf8") });

const zip = makeZip(entries);
writeFileSync(OUT, zip);

const sha = createHash("sha256").update(zip).digest("hex");
console.log(`已生成 dist/${NAME}.zip`);
console.log(`大小 ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`sha256 ${sha}`);
console.log("内含：");
for (const e of entries) {
  console.log(`  ${String(e.data.length).padStart(6)}  ${e.name.replace(`${NAME}/`, "")}`);
}
