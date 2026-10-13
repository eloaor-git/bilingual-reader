/* 翻译引擎适配层。
   每个 provider 只做两件事：把 (原文, 目标语言, 凭证) 变成一次 HTTP 请求；把响应解析成译文。
   加新引擎就往 PROVIDERS 里加一项，其余代码不用动。 */

/* ---------- 工具 ---------- */

export function md5(input) {
  // 百度接口要求 MD5 签名。Web Crypto 不提供 MD5，只能自己实现。
  const bytes = new TextEncoder().encode(input);
  const buf = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  dv.setUint32(buf.length - 8, bits >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(bits / 0x100000000), true);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const rl = (n, c) => (n << c) | (n >>> (32 - c));
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < buf.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HAS_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/** 没提供语言检测的接口，用字符构成粗略判断源语言 */
export function guessSource(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (latin / (text.length || 1) >= 0.3) return "en";
  return HAS_CJK.test(text) ? "zh" : "en";
}

/** 按字节上限切分长文本（MyMemory 单次请求有 500 字节限制） */
export function chunkByBytes(text, limit = 480) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= limit) return [text];
  const parts = text.split(/(?<=[.!?;。！？；])\s*/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && enc.encode(cur + p).length > limit) {
      out.push(cur);
      cur = p;
    } else {
      cur += p;
    }
    // 单句本身就超限，硬切
    while (enc.encode(cur).length > limit) {
      let cut = cur.length - 1;
      while (cut > 1 && enc.encode(cur.slice(0, cut)).length > limit) cut--;
      out.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.trim());
}

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

// 各家的目标语言代码
const BAIDU_TGT = { "zh-CN": "zh", "zh-TW": "cht", en: "en", ja: "jp", ko: "kor" };
const DEEPL_TGT = { "zh-CN": "ZH", "zh-TW": "ZH", en: "EN-US", ja: "JA", ko: "KO" };
const MYM_TGT = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-GB", ja: "ja-JP", ko: "ko-KR" };
const LLM_LANG = {
  "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어",
};

/* ---------- LLM 提示词 ---------- */

// 把页面背景塞进系统提示，让模型知道自己在翻什么站、什么主题
export function contextBlock(ctx) {
  if (!ctx) return "";
  const bits = [];
  if (ctx.host) bits.push(`网站：${ctx.host}`);
  if (ctx.title) bits.push(`页面标题：${ctx.title}`);
  if (ctx.h1 && ctx.h1 !== ctx.title) bits.push(`主标题：${ctx.h1}`);
  if (ctx.description) bits.push(`页面摘要：${ctx.description}`);
  if (!bits.length) return "";
  return (
    "\n\n页面背景（用来判断语境和专有名词，这些内容本身不需要翻译）：\n" +
    bits.join("\n").slice(0, 700)
  );
}

const STYLE_RULES = [
  "只输出译文本身：不要解释、不要加引号、不要重复原文、不要任何前后缀。",
  "结合页面背景翻译。游戏名、模组名、作品名、厂商名、人物名、术语使用中文圈通行译法；没有通行译法时保留原文，不要生造。",
  "同一页面内术语和译名必须保持一致。",
  "代码标识符、命令、URL、邮箱、变量名、版本号、文件名原样保留，不要翻译。",
  "保留原文的数字、单位、标点和换行，不要自行增删内容。",
  "如果某段内容已经是目标语言，或只是符号数字，原样返回。",
];

function systemPrompt(tl, ctx) {
  const lang = LLM_LANG[tl] || "简体中文";
  return (
    `你是专业网页翻译引擎，把用户给的内容翻译成${lang}。\n\n要求：\n` +
    STYLE_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n") +
    contextBlock(ctx)
  );
}

function batchPrompt(texts, tl) {
  const lang = LLM_LANG[tl] || "简体中文";
  const payload = JSON.stringify({ items: texts.map((t, i) => ({ id: i, text: t })) });
  return (
    `把下面 JSON 里每个对象的 text 翻译成${lang}。\n` +
    // 示例故意写成非 JSON（<编号>/<译文>），避免模型把示例当成待翻译内容抄回来
    `只输出一个 JSON 对象，形如 {"items":[{"id":<编号>,"text":"<译文>"}]}，` +
    `id 与数量必须和输入完全一致、顺序一致，不要输出任何其它内容（不要 markdown 代码块）。\n\n` +
    payload
  );
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏和前后废话） */
export function pickJson(content) {
  if (typeof content !== "string") return null;
  const s = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    return null;
  }
}

const ok = (url, init) => ({ url, init });

/* ---------- 引擎清单 ---------- */

export const PROVIDERS = [
  {
    id: "mymemory",
    label: "MyMemory（免费，免注册）",
    note: "零配置即用。每天约 5000 词，填邮箱可提到 50000 词。国内可直连。质量中等。",
    fields: [
      { key: "email", label: "邮箱（可选，用于提高额度）", placeholder: "you@example.com", optional: true },
    ],
    build: (text, tl, cfg) => {
      const src = guessSource(text) === "en" ? "en" : "zh-CN";
      const tgt = MYM_TGT[tl] || "zh-CN";
      const p = { q: text, langpair: `${src}|${tgt}` };
      if (cfg.email) p.de = cfg.email;
      return ok("https://api.mymemory.translated.net/get?" + new URLSearchParams(p), {
        method: "GET",
        credentials: "omit",
      });
    },
    parse: (j) => {
      if (!j || j.quotaFinished) return null;
      const t = j.responseData && j.responseData.translatedText;
      if (typeof t !== "string") return null;
      if (/^MYMEMORY WARNING/i.test(t) || /INVALID/i.test(t)) return null;
      const out = decodeEntities(t).trim();
      return out || null;
    },
    chunk: 480, // 单次 500 字节上限
  },
  {
    id: "baidu",
    label: "百度翻译开放平台",
    note: "国内直连最快，标准版每月 5 万字符免费。需要 APP ID 和密钥。",
    fields: [
      { key: "appid", label: "APP ID" },
      { key: "key", label: "密钥" },
    ],
    build: (text, tl, cfg) => {
      const salt = String(Date.now());
      const sign = md5(cfg.appid + text + salt + cfg.key);
      const p = {
        q: text, from: "auto", to: BAIDU_TGT[tl] || "zh",
        appid: cfg.appid, salt, sign,
      };
      return ok("https://fanyi-api.baidu.com/api/trans/vip/translate", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
      });
    },
    parse: (j) => {
      if (!j || j.error_code) return null;
      const r = j.trans_result;
      if (!Array.isArray(r)) return null;
      const out = r.map((x) => x.dst || "").join("\n").trim();
      return out || null;
    },
  },
  {
    id: "caiyun",
    label: "彩云小译",
    note: "国内直连、速度快、无需签名，只要一个 token（免费额度适合个人使用）。",
    fields: [{ key: "token", label: "Token" }],
    build: (text, tl, cfg) => {
      const src = guessSource(text);
      const tgt = tl === "zh-TW" ? "zh" : tl === "en" ? "en" : tl === "ja" ? "ja" : "zh";
      return ok("https://api.interpreter.caiyunai.com/v1/translator", {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          "x-authorization": "token " + cfg.token,
        },
        body: JSON.stringify({
          source: [text],
          trans_type: `${src}2${tgt}`,
          request_id: "bt-" + Math.random().toString(36).slice(2),
          detect: true,
        }),
      });
    },
    parse: (j) => {
      const t = j && j.target;
      if (!Array.isArray(t) || typeof t[0] !== "string") return null;
      return t[0].trim() || null;
    },
    // 彩云单次也有长度限制，交给上层按 2000 字符切
    chunk: 2000,
  },
  {
    id: "deepl",
    label: "DeepL API",
    note: "质量最高（欧语系），免费版每月 50 万字符。需要 Auth Key，国内可达性视网络而定。",
    fields: [{ key: "key", label: "Auth Key" }],
    build: (text, tl, cfg) => {
      const host = cfg.key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
      return ok(`https://${host}/v2/translate`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "DeepL-Auth-Key " + cfg.key,
        },
        body: new URLSearchParams({ text, target_lang: DEEPL_TGT[tl] || "ZH" }).toString(),
      });
    },
    parse: (j) => {
      const t = j && j.translations;
      if (!Array.isArray(t) || typeof t[0].text !== "string") return null;
      return t[0].text.trim() || null;
    },
    chunk: 4000,
  },
  {
    id: "openai",
    label: "OpenAI 兼容接口（DeepSeek / 通义 / Ollama…）",
    note: "填 base 地址和模型名即可。DeepSeek 等国内服务直连很快；Ollama 可填 http://127.0.0.1:11434/v1。按 token 计费，速度比传统翻译慢。",
    fields: [
      { key: "base", label: "接口地址（到 /v1 为止）", placeholder: "https://api.deepseek.com/v1" },
      { key: "key", label: "API Key" },
      { key: "model", label: "模型名", placeholder: "deepseek-chat" },
    ],
    needsOrigin: true,
    // 支持一次请求翻多条：模型能看到整页上下文，术语更一致，请求数也更少
    batch: { maxItems: 10, maxChars: 3000 },
    build: (text, tl, cfg, ctx) => {
      const base = (cfg.base || "").replace(/\/+$/, "");
      return ok(`${base}/chat/completions`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          ...(cfg.key ? { authorization: "Bearer " + cfg.key } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt(tl, ctx) },
            { role: "user", content: text },
          ],
        }),
      });
    },
    buildBatch: (texts, tl, cfg, ctx) => {
      const base = (cfg.base || "").replace(/\/+$/, "");
      return ok(`${base}/chat/completions`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          ...(cfg.key ? { authorization: "Bearer " + cfg.key } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt(tl, ctx) },
            { role: "user", content: batchPrompt(texts, tl) },
          ],
        }),
      });
    },
    parse: (j) => {
      const c = j && j.choices && j.choices[0] && j.choices[0].message;
      if (!c || typeof c.content !== "string") return null;
      const out = c.content.trim().replace(/^["“]|["”]$/g, "").trim();
      return out || null;
    },
    // 严格校验：数量、id、非空缺一不可，不合格就退回逐条翻译，绝不猜
    parseBatch: (j, n) => {
      const c = j && j.choices && j.choices[0] && j.choices[0].message;
      if (!c) return null;
      const obj = pickJson(c.content);
      const arr = obj && obj.items;
      if (!Array.isArray(arr) || arr.length !== n) return null;
      const out = new Array(n);
      for (const it of arr) {
        const i = Number(it && it.id);
        if (!Number.isInteger(i) || i < 0 || i >= n) return null;
        if (typeof it.text !== "string" || !it.text.trim()) return null;
        out[i] = it.text.trim();
      }
      return out.every((x) => typeof x === "string") ? out : null;
    },
  },
  {
    id: "google",
    label: "Google 翻译（需要网络能到 Google）",
    note: "质量好、速度快，但 googleapis.com 等域名在部分网络下不可达。三个域名会依次尝试。",
    timeout: 6000,
    fields: [],
    multi: [
      (text, tl) =>
        ok(
          "https://translate.googleapis.com/translate_a/single?" +
            new URLSearchParams({ client: "gtx", sl: "auto", tl, dt: "t", q: text }),
          { method: "GET", credentials: "omit" }
        ),
      (text, tl) =>
        ok(
          "https://translate.google.com/translate_a/single?" +
            new URLSearchParams({ client: "gtx", sl: "auto", tl, dt: "t", q: text }),
          { method: "GET", credentials: "omit" }
        ),
      (text, tl) =>
        ok(
          "https://clients5.google.com/translate_a/t?" +
            new URLSearchParams({ client: "dict-chrome-ex", sl: "auto", tl, q: text }),
          { method: "GET", credentials: "omit" }
        ),
    ],
    parse: (j) => {
      if (!Array.isArray(j) || !j.length) return null;
      const top = j[0];
      if (typeof top === "string") return top.trim() || null;
      if (!Array.isArray(top) || !top.length) return null;
      if (Array.isArray(top[0])) {
        const s = top
          .map((seg) => (Array.isArray(seg) ? seg[0] : typeof seg === "string" ? seg : ""))
          .filter((x) => typeof x === "string" && x)
          .join("");
        return s.trim() || null;
      }
      return typeof top[0] === "string" ? top[0].trim() || null : null;
    },
  },
];

export const getProvider = (id) => PROVIDERS.find((p) => p.id === id) || null;

export const DEFAULT_PROVIDER = "mymemory";
