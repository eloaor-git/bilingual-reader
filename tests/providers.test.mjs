/* 引擎适配层测试：
   1) 百度签名用的 MD5 必须和 Node crypto 完全一致
   2) 长文本切分不能丢内容
   3) 每个引擎的请求形状能被本地假服务验出来（含百度验签）
   4) 响应解析在正常/异常载荷下都要给出正确结果

   用法：npm run test:providers */

import { createHash } from "node:crypto";
import http from "node:http";
import {
  PROVIDERS, getProvider, md5, chunkByBytes, guessSource, pickJson, contextBlock,
} from "../src/providers.js";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

/* ---------- 1. MD5 ---------- */

const md5cases = [
  "", "abc", "hello world", "中文", "汉字 + emoji 😀",
  "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000),
  "Manifest V3 replaced background pages with service workers.",
];
const md5bad = md5cases.filter(
  (s) => md5(s) !== createHash("md5").update(Buffer.from(s, "utf8")).digest("hex")
);
check("MD5 与 Node crypto 逐一一致", md5bad.length === 0, md5bad.length ? `不一致 ${md5bad.length} 例` : `${md5cases.length} 例`);
check("MD5 已知向量", md5("") === "d41d8cd98f00b204e9800998ecf8427e" && md5("abc") === "900150983cd24fb0d6963f7d28e17f72");

/* ---------- 2. 切分与源语言判断 ---------- */

const long = "First sentence about extensions. Second one is a bit longer, with commas, and more. ".repeat(12);
const chunks = chunkByBytes(long, 480);
const enc = new TextEncoder();
check("切分后每片都在字节上限内", chunks.every((c) => enc.encode(c).length <= 480), `片数=${chunks.length}`);
check(
  "切分没有丢内容",
  chunks.join("").replace(/\s+/g, "") === long.replace(/\s+/g, "")
);
check("短文本不切分", chunkByBytes("hello", 480).length === 1);
check(
  "单句超长时硬切且不丢内容",
  chunkByBytes("x".repeat(1200), 480).join("") === "x".repeat(1200)
);
check(
  "源语言判断：英文/中文",
  guessSource("Getting started with Manifest V3") === "en" && guessSource("这是中文标题") === "zh"
);

/* ---------- 3. 请求形状（不进网络） ---------- */

const baidu = getProvider("baidu");
const breq = baidu.build("hello", "zh-CN", { appid: "APP", key: "SECRET" });
const bbody = new URLSearchParams(breq.init.body);
check("百度走 POST 表单", breq.url.includes("fanyi-api.baidu.com") && breq.init.method === "POST");
check(
  "百度参数齐全（q/from/to/appid/salt/sign）",
  bbody.get("q") === "hello" && bbody.get("from") === "auto" && bbody.get("to") === "zh" &&
    bbody.get("appid") === "APP" && !!bbody.get("salt") && !!bbody.get("sign")
);
check(
  "百度签名算法正确：md5(appid+q+salt+key)",
  bbody.get("sign") === md5("APP" + "hello" + bbody.get("salt") + "SECRET")
);
check("百度中文目标映射到 zh", baidu.build("x", "zh-CN", { appid: "a", key: "b" }).build === undefined);

const caiyun = getProvider("caiyun");
const creq = caiyun.build("hello world", "zh-CN", { token: "TK" });
const cbody = JSON.parse(creq.init.body);
check(
  "彩云：header 带 token、body 是 en2zh 数组",
  creq.init.headers["x-authorization"] === "token TK" &&
    cbody.trans_type === "en2zh" && Array.isArray(cbody.source) && cbody.source[0] === "hello world"
);

const deepl = getProvider("deepl");
const dfree = deepl.build("hello", "zh-CN", { key: "abc:fx" });
const dpro = deepl.build("hello", "zh-CN", { key: "abc" });
check(
  "DeepL：:fx 结尾走免费域名，否则走 pro 域名",
  dfree.url.includes("api-free.deepl.com") && dpro.url.includes("api.deepl.com")
);
check(
  "DeepL：认证头与 target_lang 正确",
  dfree.init.headers.authorization === "DeepL-Auth-Key abc:fx" &&
    new URLSearchParams(dfree.init.body).get("target_lang") === "ZH"
);

const llm = getProvider("openai");
const lreq = llm.build("hello", "zh-CN", { base: "https://api.deepseek.com/v1/", key: "K", model: "deepseek-chat" });
const lbody = JSON.parse(lreq.init.body);
check(
  "OpenAI 兼容：base 末尾斜杠被处理，路径拼接正确",
  lreq.url === "https://api.deepseek.com/v1/chat/completions"
);
check(
  "OpenAI 兼容：提示词与模型参数正确",
  lbody.model === "deepseek-chat" && lbody.temperature === 0 &&
    lbody.messages[0].role === "system" && lbody.messages[0].content.includes("简体中文") &&
    lbody.messages[1].content === "hello" && lreq.init.headers.authorization === "Bearer K"
);

const g = getProvider("google");
check("Google 提供三个候选端点", Array.isArray(g.multi) && g.multi.length === 3);
check(
  "Google 三个端点跨两个域名族",
  g.multi[0]("x", "zh-CN", {}).url.includes("translate.googleapis.com") &&
    g.multi[1]("x", "zh-CN", {}).url.includes("translate.google.com") &&
    g.multi[2]("x", "zh-CN", {}).url.includes("clients5.google.com")
);
check(
  "MyMemory 拼出 langpair 且邮箱可选",
  getProvider("mymemory").build("hello", "zh-CN", {}).url.includes("langpair=en%7Czh-CN") &&
    getProvider("mymemory").build("hello", "zh-CN", { email: "a@b.c" }).url.includes("de=a%40b.c")
);

/* ---------- 4. 响应解析 ---------- */

check("MyMemory 正常载荷", getProvider("mymemory").parse({ responseData: { translatedText: "你好" } }) === "你好");
check(
  "MyMemory 配额用尽/警告文本判为失败",
  getProvider("mymemory").parse({ responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" } }) === null &&
    getProvider("mymemory").parse({ quotaFinished: true, responseData: { translatedText: "x" } }) === null
);
check("MyMemory 解码 HTML 实体", getProvider("mymemory").parse({ responseData: { translatedText: "don&#39;t &amp; won&#39;t" } }) === "don't & won't");
check("百度错误码判为失败", getProvider("baidu").parse({ error_code: "54003" }) === null);
check("百度多行结果拼接", getProvider("baidu").parse({ trans_result: [{ dst: "第一行" }, { dst: "第二行" }] }) === "第一行\n第二行");
check("彩云载荷", getProvider("caiyun").parse({ target: ["彩云译文"] }) === "彩云译文");
check("彩云空载荷判为失败", getProvider("caiyun").parse({ target: [] }) === null);
check("DeepL 载荷", getProvider("deepl").parse({ translations: [{ text: "DeepL译文" }] }) === "DeepL译文");
check("OpenAI 兼容载荷与去引号", getProvider("openai").parse({ choices: [{ message: { content: '  "你好"  ' } }] }) === "你好");
check(
  "Google 三种历史形状都能解析",
  g.parse([[["甲"], ["乙"]], null, "en"]) === "甲乙" &&
    g.parse([[["丙", "src", null, null, 10]], null, "en"]) === "丙" &&
    g.parse([["丁", "en"]]) === "丁"
);
check("所有引擎在垃圾载荷下都返回 null", PROVIDERS.every((p) => p.parse({ nope: 1 }) === null || p.id === "mymemory"));

/* ---------- 4.1 LLM 提示词与批量解析 ---------- */

const CTX = { host: "nexusmods.com", title: "Skyrim SE mods", h1: "Top files", description: "Download mods" };
check(
  "页面背景会被写进提示词",
  contextBlock(CTX).includes("nexusmods.com") &&
    contextBlock(CTX).includes("Skyrim SE mods") &&
    contextBlock(CTX).includes("页面摘要")
);
check("没有页面背景时不产生空段落", contextBlock(null) === "" && contextBlock({}) === "");

const llmCtx = llm.build("hello", "zh-CN", { base: "https://x/v1", key: "k", model: "m" }, CTX);
const llmSys = JSON.parse(llmCtx.init.body).messages[0].content;
check(
  "系统提示词同时含翻译要求与页面背景",
  llmSys.includes("简体中文") && llmSys.includes("术语") && llmSys.includes("nexusmods.com")
);

const batchReq = llm.buildBatch(["hello", "world"], "zh-CN", { base: "https://x/v1", key: "k", model: "m" }, CTX);
const batchUser = JSON.parse(batchReq.init.body).messages[1].content;
check(
  "批量请求正文里的载荷是最后一段合法 JSON",
  (() => {
    // 提示词里的示例故意写成 <编号>/<译文>，只有真正的载荷能解析
    const at = batchUser.lastIndexOf('{"items"');
    if (at < 0) return false;
    try {
      return JSON.parse(batchUser.slice(at)).items.length === 2;
    } catch (e) {
      return false;
    }
  })()
);
check(
  "提示词里的示例不会被误当成载荷",
  (() => {
    const at = batchUser.indexOf('{"items"');
    try {
      JSON.parse(batchUser.slice(at));
      return false; // 第一处就能解析说明示例写成了合法 JSON，容易让模型照抄
    } catch (e) {
      return true;
    }
  })()
);

check("pickJson：纯 JSON", pickJson('{"items":[{"id":0,"text":"你好"}]}')?.items?.length === 1);
check("pickJson：带 ```json 围栏", pickJson('```json\n{"items":[{"id":0,"text":"你好"}]}\n```')?.items?.length === 1);
check("pickJson：前后有废话也能抠出来", pickJson('好的，这是结果：{"items":[]} 请查收')?.items?.length === 0);
check("pickJson：完全不是 JSON 时返回 null", pickJson("我不知道") === null && pickJson(null) === null);

const good = { choices: [{ message: { content: JSON.stringify({ items: [{ id: 0, text: "甲" }, { id: 1, text: "乙" }] }) } }] };
check("批量解析：正常返回按 id 归位", JSON.stringify(llm.parseBatch(good, 2)) === '["甲","乙"]');
check(
  "批量解析：顺序被打乱也能归位",
  JSON.stringify(
    llm.parseBatch({ choices: [{ message: { content: '{"items":[{"id":1,"text":"乙"},{"id":0,"text":"甲"}]}' } }] }, 2)
  ) === '["甲","乙"]'
);
check(
  "批量解析：数量不符判为失败",
  llm.parseBatch({ choices: [{ message: { content: '{"items":[{"id":0,"text":"甲"}]}' } }] }, 2) === null
);
check(
  "批量解析：id 越界或空译文判为失败",
  llm.parseBatch({ choices: [{ message: { content: '{"items":[{"id":0,"text":"甲"},{"id":5,"text":"乙"}]}' } }] }, 2) === null &&
    llm.parseBatch({ choices: [{ message: { content: '{"items":[{"id":0,"text":"甲"},{"id":1,"text":"  "}]}' } }] }, 2) === null
);
check(
  "批量解析：模型胡说八道时判为失败（会退回逐条）",
  llm.parseBatch({ choices: [{ message: { content: "抱歉，我无法完成" } }] }, 2) === null &&
    llm.parseBatch({ choices: [] }, 2) === null
);

/* ---------- 5. 打本地假服务，跑通 build → fetch → parse ---------- */

const seen = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ path: url.pathname, method: req.method, headers: req.headers, body: raw, query: url.searchParams });
    const json = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/mymemory") return json({ responseData: { translatedText: "你好，世界" }, responseStatus: 200 });
    if (url.pathname === "/baidu") return json({ trans_result: [{ dst: "百度译文" }] });
    if (url.pathname === "/caiyun") return json({ target: ["彩云译文"] });
    if (url.pathname === "/deepl") return json({ translations: [{ text: "DeepL译文" }] });
    if (url.pathname === "/chat/completions") return json({ choices: [{ message: { content: "模型译文" } }] });
    res.writeHead(404).end("nope");
  });
});
await new Promise((r) => server.listen(8899, "127.0.0.1", r));
const BASE = "http://127.0.0.1:8899";

const ROUTE = { mymemory: "/mymemory", baidu: "/baidu", caiyun: "/caiyun", deepl: "/deepl", openai: "/chat/completions" };
const CASES = {
  mymemory: { cfg: { email: "a@b.c" }, want: "你好，世界" },
  baidu: { cfg: { appid: "APP", key: "SECRET" }, want: "百度译文" },
  caiyun: { cfg: { token: "TK" }, want: "彩云译文" },
  deepl: { cfg: { key: "abc:fx" }, want: "DeepL译文" },
  openai: { cfg: { base: BASE, key: "K", model: "m" }, want: "模型译文" },
};

for (const [id, { cfg, want }] of Object.entries(CASES)) {
  const p = getProvider(id);
  const req = p.build("hello world", "zh-CN", cfg);
  // 只把 origin 换成假服务，保留查询串，这样能一并验证 GET 类引擎的参数
  const target = new URL(ROUTE[id] + new URL(req.url).search, BASE).href;
  const res = await fetch(target, { ...req.init, headers: req.init.headers, body: req.init.body });
  const data = await res.json();
  const got = p.parse(data);
  check(`${id}：请求→解析端到端得到译文`, got === want, JSON.stringify(got));
}

const baiduSeen = seen.find((s) => s.path === "/baidu");
const bq = new URLSearchParams(baiduSeen.body);
check(
  "真实发出的百度请求签名可通过服务端验算",
  baiduSeen.method === "POST" && bq.get("sign") === md5(bq.get("appid") + bq.get("q") + bq.get("salt") + "SECRET")
);
check(
  "彩云请求真的带上了 token 头",
  seen.find((s) => s.path === "/caiyun").headers["x-authorization"] === "token TK"
);
check(
  "MyMemory 请求带上了 langpair 与邮箱参数",
  seen.find((s) => s.path === "/mymemory").query.get("de") === "a@b.c" &&
    seen.find((s) => s.path === "/mymemory").query.get("langpair") === "en|zh-CN"
);
check(
  "OpenAI 兼容请求体是标准 chat/completions",
  JSON.parse(seen.find((s) => s.path === "/chat/completions").body).model === "m"
);

server.close();
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
