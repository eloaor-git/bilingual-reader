/* 端到端测试：在真实 Chrome 里加载扩展本体，把各引擎端点指向本地假服务，
   验证「消息 → 引擎路由 → 请求 → 缓存 → 渲染 → 还原」整条链路。

   用法：npm run test:e2e     （可用 CHROME_PATH 指定浏览器）

   为什么不用 Playwright 的 --load-extension：
   Chrome/Edge 从 137 起忽略了该参数，扩展根本不会加载。现行走法是
   --enable-unsafe-extension-debugging + CDP 的 Extensions.loadUnpacked。 */

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8787;
const CDP_PORT = 9333;
// 注意：Chrome 的 match pattern 里不能写端口，http://127.0.0.1/* 覆盖该主机所有端口
const BASE = `http://127.0.0.1:${PORT}`;
// 默认验证 src/；设 BT_SRC_DIR 可以对"打包产物解压出来的目录"跑同一套验证
const EXT_SRC = process.env.BT_SRC_DIR || fileURLToPath(new URL("../src/", import.meta.url));

const CHROME = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome/Edge，可用 CHROME_PATH 环境变量指定路径");
  process.exit(2);
}

const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <div id="search"><form><input name="q" value="keep me"><button>Search</button></form></div>
  <div id="res">
    <div class="g">
      <a href="#a"><h3>Getting started with Manifest V3</h3></a>
      <cite>https://example.com/docs</cite>
      <div class="snippet">Manifest V3 replaced background pages with service workers.</div>
    </div>
    <div class="g">
      <a href="#b"><h3>这是一个中文字条的搜索结果标题</h3></a>
      <div class="snippet">完全中文的内容，不应该被拿去翻译。</div>
    </div>
    <div class="g">
      <a href="#c"><h3>Content scripts and isolated worlds</h3></a>
      <pre><code>const x = await fetch(url);</code></pre>
    </div>
    <div class="tag-list">
      <a class="tag" href="#t1">Open settings page</a>
      <a class="tag" href="#t2">Manifest V3 Guide</a>
    </div>
  </div>
</body></html>`;

const simple = (text) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
     <div><h3>${text}</h3></div>
   </body></html>`;

/* ---------- 假翻译服务 ---------- */

const received = [];
const batchRequests = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  const json = (o, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };

  if (u.pathname === "/fixture") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
    return;
  }
  if (u.pathname === "/fixture-fallback") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(simple("FALLBACKME the third endpoint should serve this"));
    return;
  }
  if (u.pathname === "/fixture-fail") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(simple("FAILME rate limited block that should never render"));
    return;
  }

  // MyMemory（默认引擎）
  if (u.pathname === "/mymemory") {
    const q = u.searchParams.get("q") || "";
    received.push({ q, endpoint: "mymemory" });
    if (!u.searchParams.get("langpair")) {
      json({ responseStatus: 403 }, 200);
      return;
    }
    json({ responseData: { translatedText: `【MY】${q}` }, responseStatus: 200 });
    return;
  }

  // Google 的三个候选端点
  if (u.pathname === "/gtx1" || u.pathname === "/gtx2" || u.pathname === "/gtx3") {
    const id = u.pathname.slice(-1);
    const q = u.searchParams.get("q") || "";
    const tl = u.searchParams.get("tl") || "";
    received.push({ q, tl, endpoint: `gtx${id}` });
    if (q.startsWith("FAILME") || (q.startsWith("FALLBACKME") && id !== "3")) {
      res.writeHead(429).end("rate limited");
      return;
    }
    if (id === "3") {
      // clients5 的宽松形状
      json([[`【GTX3】${q}`, "en"]]);
      return;
    }
    json([[[`【GTX${id}】${q}`, q, null, null, 10]], null, "en"]);
    return;
  }

  // OpenAI 兼容接口：把批量请求里每段的 text 加前缀返回，顺带记下请求体
  if (u.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        res.writeHead(400).end("bad json");
        return;
      }
      batchRequests.push(body);
      const user = (body.messages || []).filter((m) => m.role === "user").pop();
      const text = (user && user.content) || "";
      // 批量模式：正文里带 {"items":[…]}；单条模式：正文就是原文
      let payload = null;
      // 用最后一次出现：提示词里的示例在前面，真正的载荷在最后
      const at = text.lastIndexOf('{"items"');
      if (at >= 0) {
        try {
          payload = JSON.parse(text.slice(at));
        } catch (e) {
          payload = null;
        }
      }
      const content =
        payload && Array.isArray(payload.items)
          ? JSON.stringify({
              items: payload.items.map((it) => ({ id: it.id, text: `【LLM】${it.text}` })),
            })
          : `【LLM-SINGLE】${text}`;
      json({ choices: [{ message: { content } }] });
    });
    return;
  }

  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/* ---------- 造一份指向本地端点的扩展副本 ---------- */

const stage = mkdtempSync(path.join(tmpdir(), "bt-ext-"));
const profile = mkdtempSync(path.join(tmpdir(), "bt-profile-"));
cpSync(EXT_SRC, stage, { recursive: true });

const manifestPath = path.join(stage, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.permissions = [...new Set([...manifest.permissions, "tabs"])];
manifest.host_permissions = ["http://127.0.0.1/*"];
delete manifest.optional_host_permissions;
manifest.content_scripts[0].matches = ["http://127.0.0.1/*"];
delete manifest.content_scripts[0].exclude_matches;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const provPath = path.join(stage, "providers.js");
writeFileSync(
  provPath,
  readFileSync(provPath, "utf8")
    .replace("https://api.mymemory.translated.net/get?", `${BASE}/mymemory?`)
    .replace("https://translate.googleapis.com/translate_a/single?", `${BASE}/gtx1?`)
    .replace("https://translate.google.com/translate_a/single?", `${BASE}/gtx2?`)
    .replace("https://clients5.google.com/translate_a/t?", `${BASE}/gtx3?`)
);

/* ---------- 启动浏览器并加载扩展 ---------- */

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return true;
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let browser = null;
try {
  check("浏览器调试端口就绪", await waitForCdp(), path.basename(CHROME));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

  const bs = await browser.newBrowserCDPSession();
  const { id: extensionId } = await bs.send("Extensions.loadUnpacked", { path: stage });
  check("扩展已加载到真实浏览器", !!extensionId, extensionId);

  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(`${BASE}/fixture`, { waitUntil: "load" });

  let sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
  }
  check("扩展的 Service Worker 在运行", !!sw, sw ? "ok" : "未启动");

  const tabOf = (frag) =>
    sw.evaluate(async (f) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => (x.url || "").includes(f));
      return t ? t.id : null;
    }, frag);
  const activate = async (id, value = true) =>
    sw.evaluate((tid) => chrome.tabs.sendMessage(tid, { type: "bt:set-active", value: true }), id);
  const setProvider = (id) =>
    sw.evaluate(async (pid) => {
      const cur = (await chrome.storage.local.get("bt:settings"))["bt:settings"] || {};
      await chrome.storage.local.set({ "bt:settings": { ...cur, provider: pid } });
    }, id);

  const tabId = await tabOf("/fixture");
  check("后台能找到目标标签页", tabId != null, `tabId=${tabId}`);

  const before = await page.evaluate(() => document.body.innerHTML);
  const started = await activate(tabId);
  check("内容脚本响应开关消息", started && started.active === true, JSON.stringify(started));

  await page
    .waitForFunction(() => document.querySelectorAll(".bt-trans").length > 0, null, { timeout: 15000 })
    .catch(() => {});

  const blocks = await page.evaluate(() =>
    [...document.querySelectorAll("[data-bt]")].map((b) => b.innerText.trim())
  );
  const trans = await page.evaluate(() =>
    [...document.querySelectorAll(".bt-trans")].map((d) => d.textContent)
  );

  check("译文渲染到了页面上", trans.length > 0, `count=${trans.length}`);
  check(
    "默认引擎是 MyMemory，译文来自它的响应",
    trans.length > 0 && trans.every((t) => t.startsWith("【MY】")),
    trans[0] ? JSON.stringify(trans[0].slice(0, 40)) : ""
  );
  check("默认引擎不碰 Google 端点", !received.some((r) => r.endpoint.startsWith("gtx")));
  check("请求带上了 langpair 参数", received.filter((r) => r.endpoint === "mymemory").length > 0);
  check("代码块没有被送去翻译", !received.some((r) => r.q.includes("await fetch")));
  check("中文结果块没有被送去翻译", !received.some((r) => r.q.startsWith("这是一个中文字条")));
  check(
    "标题与摘要都被翻到",
    blocks.some((b) => b.includes("Getting started")) && blocks.length >= 2,
    `blocks=${blocks.length}`
  );
  check(
    "译文是原文的下一个兄弟节点",
    await page.evaluate(() =>
      [...document.querySelectorAll("[data-bt]:not([data-bt-hover])")].every(
        (b) => b.nextElementSibling && b.nextElementSibling.classList.contains("bt-trans")
      )
    )
  );
  check(
    "标签类小块进入隐式翻译模式（不插入译文节点）",
    (await page.locator(".tag").first().getAttribute("data-bt-hover")) === "1" &&
      (await page.evaluate(() => !!document.querySelector(".tag > .bt-trans"))) === false
  );
  check("输入框内容没被改动", (await page.evaluate(() => document.querySelector("input").value)) === "keep me");

  const callsAfterStart = received.length;
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "bt:set-active", value: false }), tabId);
  check("关闭后译文节点全部移除", (await page.evaluate(() => document.querySelectorAll(".bt-trans").length)) === 0);
  check("关闭后 DOM 与翻译前逐字节一致", (await page.evaluate(() => document.body.innerHTML)) === before);

  await activate(tabId);
  await page
    .waitForFunction(() => document.querySelectorAll(".bt-trans").length > 0, null, { timeout: 8000 })
    .catch(() => {});
  check("二次开启能重新渲染", (await page.evaluate(() => document.querySelectorAll(".bt-trans").length)) > 0);
  check("二次开启命中缓存，零新请求", received.length === callsAfterStart, `delta=${received.length - callsAfterStart}`);

  const cacheSize = await sw.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 2600));
    const r = await chrome.storage.local.get("bt:cache");
    return Object.keys(r["bt:cache"] || {}).length;
  });
  check("缓存已写入 chrome.storage.local", cacheSize > 0, `entries=${cacheSize}`);

  /* ---------- 悬停显示译文 ---------- */
  await page.locator(".tag").first().hover();
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector(".bt-tip");
        return t && !t.hidden;
      },
      null,
      { timeout: 5000 }
    )
    .catch(() => {});
  const tipText = await page.evaluate(() => {
    const t = document.querySelector(".bt-tip");
    return t && !t.hidden ? t.textContent : null;
  });
  check("鼠标悬停时弹出译文气泡", !!tipText && tipText.startsWith("【MY】"), JSON.stringify(tipText));
  await page.mouse.move(2, 2);
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector(".bt-tip");
        return !t || t.hidden;
      },
      null,
      { timeout: 5000 }
    )
    .catch(() => {});
  check(
    "移开鼠标后气泡消失",
    await page.evaluate(() => {
      const t = document.querySelector(".bt-tip");
      return !t || t.hidden;
    })
  );

  /* ---------- 弹窗 ---------- */
  const popup = await context.newPage();
  const pageErrors = [];
  popup.on("pageerror", (e) => pageErrors.push(String(e)));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
  await popup.waitForFunction(() => document.getElementById("provider").options.length > 1, null, { timeout: 8000 }).catch(() => {});
  check("弹窗页面无脚本异常", pageErrors.length === 0, pageErrors[0] || "");
  check(
    "弹窗列出了全部引擎",
    (await popup.evaluate(() => document.getElementById("provider").options.length)) === 6,
    await popup.evaluate(() => [...document.getElementById("provider").options].map((o) => o.value).join(","))
  );
  check(
    "弹窗默认选中免注册引擎",
    (await popup.evaluate(() => document.getElementById("provider").value)) === "mymemory"
  );

  await popup.click("#save");
  await popup
    .waitForFunction(() => !document.getElementById("diagout").textContent.includes("正在测试"), null, { timeout: 20000 })
    .catch(() => {});
  const diagText = await popup.evaluate(() => document.getElementById("diagout").textContent);
  check("「保存并测试」跑通真实请求", diagText.includes("[ok]") && diagText.includes("mymemory"), JSON.stringify(diagText.slice(0, 70)));
  await popup.close();

  /* ---------- 切换引擎：MyMemory → Google ---------- */
  const myCount = received.filter((r) => r.endpoint === "mymemory").length;
  await setProvider("google");
  await page.reload({ waitUntil: "load" });
  await activate(await tabOf("/fixture"));
  await page
    .waitForFunction(
      () => [...document.querySelectorAll(".bt-trans")].some((d) => d.textContent.startsWith("【GTX")),
      null,
      { timeout: 15000 }
    )
    .catch(() => {});
  const gt = await page.evaluate(() => [...document.querySelectorAll(".bt-trans")].map((d) => d.textContent));
  check(
    "切换引擎后改用新引擎翻译",
    gt.length > 0 && gt.every((t) => t.startsWith("【GTX1】")),
    gt[0] ? JSON.stringify(gt[0].slice(0, 40)) : ""
  );
  check("切换后没有再调用旧引擎", received.filter((r) => r.endpoint === "mymemory").length === myCount);

  /* ---------- Google 多端点回退 ---------- */
  const page3 = await context.newPage();
  await page3.goto(`${BASE}/fixture-fallback`, { waitUntil: "load" });
  await activate(await tabOf("/fixture-fallback"));
  await page3
    .waitForFunction(() => document.querySelectorAll(".bt-trans").length > 0, null, { timeout: 15000 })
    .catch(() => {});
  const fb = await page3.evaluate(() => {
    const d = document.querySelector(".bt-trans");
    return d ? d.textContent : null;
  });
  check("前两个端点失败时自动回退到第三个", !!fb && fb.startsWith("【GTX3】"), JSON.stringify(fb));
  check("第三端点确实收到了请求", received.some((r) => r.endpoint === "gtx3" && r.q.startsWith("FALLBACKME")));
  await page3.close();

  /* ---------- 全线失败 + 熔断 ---------- */
  const page2 = await context.newPage();
  await page2.goto(`${BASE}/fixture-fail`, { waitUntil: "load" });
  const tabId2 = await tabOf("/fixture-fail");
  await activate(tabId2);
  await new Promise((r) => setTimeout(r, 2000));
  const failState = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "bt:query" }), tabId2);
  check("端点全部报错时不渲染译文", (await page2.evaluate(() => document.querySelectorAll(".bt-trans").length)) === 0);
  check("失败次数上报给弹窗", !!failState && failState.failures > 0, `failures=${failState && failState.failures}`);
  check(
    "弹窗能拿到具体错误原因",
    !!(failState && failState.lastError && /429|HTTP/.test(failState.lastError)),
    JSON.stringify(((failState && failState.lastError) || "").slice(0, 70))
  );
  check("失败后原文完好无损", (await page2.evaluate(() => document.querySelector("h3").textContent)).startsWith("FAILME"));
  await page2.close();

  const callsBeforeBreaker = received.length;
  await page.reload({ waitUntil: "load" });
  await activate(await tabOf("/fixture"));
  await new Promise((r) => setTimeout(r, 2000));
  check("熔断生效：失败后不再反复轮询端点", received.length === callsBeforeBreaker, `delta=${received.length - callsBeforeBreaker}`);

  /* ---------- LLM 引擎：批量合并 + 页面背景注入 ---------- */
  await sw.evaluate(async (base) => {
    const cur = (await chrome.storage.local.get("bt:settings"))["bt:settings"] || {};
    const creds = (await chrome.storage.local.get("bt:creds"))["bt:creds"] || {};
    await chrome.storage.local.set({
      "bt:settings": { ...cur, provider: "openai" },
      "bt:creds": { ...creds, openai: { base, key: "test-key", model: "test-model" } },
    });
  }, `${BASE}/v1`);
  await page.reload({ waitUntil: "load" });
  await activate(await tabOf("/fixture"));
  await page
    .waitForFunction(
      () => [...document.querySelectorAll(".bt-trans")].some((d) => d.textContent.startsWith("【LLM】")),
      null,
      { timeout: 25000 }
    )
    .catch(() => {});
  const llmTexts = await page.evaluate(() =>
    [...document.querySelectorAll(".bt-trans")].map((d) => d.textContent)
  );
  check("整页只发一次 LLM 请求（批量合并生效）", batchRequests.length === 1, `requests=${batchRequests.length}`);
  const first = batchRequests[0] || { messages: [] };
  const sys = ((first.messages || []).find((m) => m.role === "system") || {}).content || "";
  const userMsg = ((first.messages || []).find((m) => m.role === "user") || {}).content || "";
  const at = userMsg.lastIndexOf('{"items"');
  let itemCount = 0;
  try {
    itemCount = JSON.parse(userMsg.slice(at)).items.length;
  } catch (e) {
    itemCount = 0;
  }
  check("一次请求里打包了多段文本", itemCount >= 4, `items=${itemCount}`);
  check(
    "提示词里注入了页面背景",
    sys.includes("页面标题") && sys.includes("fixture"),
    JSON.stringify(sys.slice(0, 50))
  );
  check(
    "批量结果被分发回每个块",
    llmTexts.length >= 3 && llmTexts.every((t) => t.startsWith("【LLM】")),
    `count=${llmTexts.length}`
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  proc.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 800));
  for (const dir of [stage, profile]) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
