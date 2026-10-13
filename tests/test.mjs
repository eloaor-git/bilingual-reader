/* 在 jsdom 里跑真实的 content.js，验证选块与「还原后 DOM 逐字节一致」 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../src/content.js", import.meta.url),
  "utf8"
);

// 一个仿 Google 搜索页：结果块、代码块、输入框、按钮、已中文块、隐藏块
const HTML = `<!doctype html><html><head><title>t</title></head><body>
  <div id="search">
    <form><input name="q" value="how to build a chrome extension"><button>Google 搜索</button></form>
  </div>
  <div id="res">
    <div class="g">
      <a href="/a"><h3>Getting started with Manifest V3</h3></a>
      <cite>https://developer.chrome.com/docs/extensions</cite>
      <div class="snippet">Manifest V3 is the latest version of the Chrome extension platform, replacing background pages with service workers.</div>
    </div>
    <div class="g">
      <a href="/b"><h3>这是一个中文字条的搜索标题</h3></a>
      <div class="snippet">完全中文的内容块，不应该被送去翻译。</div>
    </div>
    <div class="g">
      <a href="/c"><h3>Content scripts and isolated worlds</h3></a>
      <pre><code>const x = await fetch(url);</code></pre>
    </div>
    <div class="g" style="display:none">
      <h3>This hidden template block should never be translated</h3>
    </div>
    <div class="g">
      <h3>ok</h3>
    </div>
  </div>
</body></html>`;

function boot(html = HTML, { failRequests = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;

  // jsdom 没实现 innerText，用 textContent 近似（display:none 由 content.js 的 visible() 单独判断）
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent.replace(/\s+/g, " ").trim();
    },
    set(v) {
      this.textContent = v;
    },
  });

  // jsdom 也没实现 checkVisibility，按规范补一个（会连祖先一起判断）
  w.HTMLElement.prototype.checkVisibility = function (opts = {}) {
    let n = this;
    while (n && n.nodeType === 1) {
      const cs = w.getComputedStyle(n);
      if (cs.display === "none") return false;
      if (opts.checkVisibilityCSS && cs.visibility === "hidden") return false;
      n = n.parentElement;
    }
    return true;
  };

  const handlers = [];
  const calls = [];
  w.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      onMessage: { addListener: (fn) => handlers.push(fn) },
      sendMessage: async (msg) => {
        if (msg.type === "bt:translate") {
          calls.push(msg);
          if (failRequests) return { ok: false, error: "HTTP 429" };
          return { ok: true, text: "【译】" + msg.text };
        }
        return { ok: true };
      },
    },
  };

  w.eval(SRC);
  return { dom, w, handlers, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(handlers, msg) {
  return new Promise((resolve) => handlers[0](msg, {}, resolve));
}

let failed = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

const { dom, w, handlers, calls } = boot();
await sleep(50);

const before = w.document.body.innerHTML;
check("初始化时处于关闭状态", (await send(handlers, { type: "bt:query" })).active === false);
check("未翻译时页面无注入节点", w.document.querySelectorAll(".bt-trans").length === 0);

await send(handlers, { type: "bt:set-active", value: true });
await sleep(200);

const q = (s) => w.document.querySelectorAll(s);
const blocks = [...q("[data-bt]")];
const translated = blocks.map((b) => b.innerText);

check("产生了译文块", q(".bt-trans").length > 0, `count=${q(".bt-trans").length}`);
check(
  "每个译文块紧跟原文块之后",
  blocks.every((b) => b.nextElementSibling && b.nextElementSibling.classList.contains("bt-trans"))
);
check("原文块数量与译文块数量一致", blocks.length === q(".bt-trans").length);
check(
  "抓到了结果标题",
  translated.some((t) => t.includes("Getting started with Manifest V3"))
);
check(
  "抓到了摘要段落",
  translated.some((t) => t.startsWith("Manifest V3 is the latest version"))
);
check(
  "纯中文块未被翻译",
  !translated.some((t) => t.startsWith("这是一个中文字条") || t.startsWith("完全中文的内容块"))
);
check(
  "隐藏块未被翻译",
  !translated.some((t) => t.includes("hidden template block")) &&
    ![...q(".bt-trans")].some((d) => d.textContent.includes("hidden template block"))
);
check("过短标题 ok 未被翻译", !translated.includes("ok"));
check(
  "代码块未被翻译",
  !translated.some((t) => t.includes("await fetch"))
);
check(
  "未触碰输入框与按钮",
  w.document.querySelector("input").value === "how to build a chrome extension" &&
    w.document.querySelector("button").textContent === "Google 搜索"
);
check("没有重复请求同一文本", new Set(calls.map((c) => c.text)).size === calls.length);

// 只看译文模式
await send(handlers, { type: "bt:settings", value: { onlyTranslated: true } });
check("只看译文会加 html.bt-only", w.document.documentElement.classList.contains("bt-only"));
await send(handlers, { type: "bt:settings", value: { onlyTranslated: false } });
check("关掉后移除 html.bt-only", !w.document.documentElement.classList.contains("bt-only"));

// 还原：这是最关键的一条
await send(handlers, { type: "bt:set-active", value: false });
await sleep(50);
check("还原后无残留译文节点", q(".bt-trans").length === 0);
check("还原后无残留 data-bt 标记", q("[data-bt]").length === 0);
check("还原后 DOM 与翻译前逐字节一致", w.document.body.innerHTML === before);

// 再开一次，验证复用缓存不再发请求
const callsBefore = calls.length;
await send(handlers, { type: "bt:set-active", value: true });
await sleep(150);
check("二次开启能重新渲染", q(".bt-trans").length > 0, `count=${q(".bt-trans").length}`);
check(
  "二次开启全部命中本地缓存，零网络请求",
  calls.length === callsBefore,
  `delta=${calls.length - callsBefore}`
);
check("query 接口返回计数", (await send(handlers, { type: "bt:query" })).count > 0);

// 模拟 SPA 追加内容
await send(handlers, { type: "bt:set-active", value: true });
const fresh = w.document.createElement("div");
fresh.innerHTML = `<div class="g"><h3>Lazily rendered result title</h3><div class="snippet">This block appeared after the initial scan.</div></div>`;
w.document.getElementById("res").appendChild(fresh);
await sleep(600);
check(
  "MutationObserver 抓到后插入的新内容",
  [...q("[data-bt]")].some((b) => b.innerText.includes("Lazily rendered result title"))
);

// 关掉观察器后追加内容，不应再翻译
await send(handlers, { type: "bt:set-active", value: false });
const late = w.document.createElement("div");
late.innerHTML = `<div class="g"><h3>Added while disabled</h3></div>`;
w.document.getElementById("res").appendChild(late);
await sleep(500);
check("关闭状态下不再翻译新内容", q(".bt-trans").length === 0);

dom.window.close();

/* ---------- 第二个场景：段落里的行内链接 ---------- */
{
  const html = `<!doctype html><html><body>
    <article>
      <p>The service worker is terminated after roughly thirty seconds of inactivity, so never keep
         state in a <a href="/docs">top level variable</a> that you expect to survive.</p>
      <div>Inline <code>shortId</code> stays inside the paragraph above and must not split it.</div>
    </article>
  </body></html>`;
  const t = boot(html);
  await sleep(50);
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(200);

  const picked = [...t.w.document.querySelectorAll("[data-bt]")];
  const p = t.w.document.querySelector("p");
  check(
    "含行内链接的段落整体作为一个块",
    picked.includes(p),
    `blocks=${picked.map((p) => p.tagName).join(",")}`
  );
  check(
    "行内元素没有被拆成独立单元",
    !picked.some((b) => b.tagName === "A")
  );
  const pCall = t.calls.find((c) => c.text.includes("thirty seconds"));
  check(
    "段落文本完整送出（行内链接内容未被切掉）",
    !!pCall && pCall.text.includes("top level variable") && pCall.text.includes("state in a"),
    pCall ? JSON.stringify(pCall.text.slice(0, 50)) : "no call"
  );
  t.w.close();
}

/* ---------- 第三个场景：请求失败要能被看见 ---------- */
{
  const t = boot(HTML, { failRequests: true });
  await sleep(50);
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);

  const s = await send(t.handlers, { type: "bt:query" });
  check("失败时不渲染任何译文块", t.w.document.querySelectorAll(".bt-trans").length === 0);
  check("失败次数会上报给弹窗", s.active === true && s.failures > 0, `failures=${s.failures}`);
  check("失败不会卡死队列", t.calls.length > 0 && !s.count);
  t.w.close();
}

/* ---------- 第四个场景：行内片段与更细的过滤 ---------- */
{
  const html = `<!doctype html><html><body>
    <div class="wrap">
      <div class="b1">A block level element with substantial text inside it</div>
      bare text sitting between two block elements and it must not be skipped
      <div class="b2">Another block level element with substantial text</div>
    </div>
    <div class="wrap2">
      <div class="b3">Block one with enough text to count as a unit</div>
      <span style="display:inline-block">inline block text that is long enough to translate</span>
    </div>
    <div class="junk">
      <h3>https://example.com/some/path</h3>
      <h3>3.5 GB / 120 MB</h3>
      <h3>getElementById</h3>
      <h3>OK</h3>
      <h3>user.name@example.com</h3>
    </div>
    <div class="good"><h3>Version 2.4.1 released with noticeably better performance</h3></div>
  </body></html>`;
  const t = boot(html);
  await sleep(50);
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);

  const rendered = [...t.w.document.querySelectorAll(".bt-trans")].map((d) => d.textContent);
  const sent = t.calls.map((c) => c.text);

  check(
    "块级元素之间的裸文本被翻到",
    rendered.some((x) => x.includes("bare text sitting between two block elements")),
    rendered.length + " 个译文"
  );
  check(
    "inline-block 里的文字被翻到",
    rendered.some((x) => x.includes("inline block text that is long enough"))
  );
  check("裸文本没有被重复翻译", sent.filter((s) => s.includes("bare text sitting")).length === 1);
  check(
    "URL / 邮箱 / 纯数字单位 / 代码标识符都不翻",
    !sent.some((s) => /example\.com|3\.5 GB|getElementById|user\.name@|^OK$/.test(s)),
    JSON.stringify(sent.slice(0, 6))
  );
  check("正常句子照翻", sent.some((s) => s.includes("Version 2.4.1")));
  t.w.close();
}

/* ---------- 第五个场景：小块的隐式翻译（悬停） ---------- */
{
  const html = `<!doctype html><html><body>
    <article>
      <h1>Manifest V3 Guide</h1>
      <div class="tag-list">
        <a class="tag" href="/tags/extension">Browser Extension</a>
        <a class="tag" href="/tags/mv3">Manifest V3</a>
      </div>
      <p>A long paragraph that should still show its translation inline because it carries real content.</p>
    </article>
  </body></html>`;
  const t = boot(html);
  await sleep(50);
  const before = t.w.document.body.innerHTML;
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);

  const h1 = t.w.document.querySelector("h1");
  const tag = t.w.document.querySelector(".tag");
  const p = t.w.document.querySelector("p");
  check(
    "标题属于正文：即使很短也直接显示译文",
    !!(h1.nextElementSibling && h1.nextElementSibling.classList.contains("bt-trans"))
  );
  check(
    "分类标签走隐式翻译：不在标签内或标签后插入译文节点",
    tag.dataset.btHover === "1" &&
      !tag.querySelector(".bt-trans") &&
      !(tag.nextElementSibling && tag.nextElementSibling.classList.contains("bt-trans"))
  );
  check("标签内容确实被翻译了", t.calls.some((c) => c.text.includes("Browser Extension")));
  check(
    "标签列表没有被揉成一句话一起翻",
    !t.calls.some((c) => /Browser Extension.*Manifest V3/.test(c.text))
  );
  check(
    "长段落仍然直接显示译文",
    !!(p.nextElementSibling && p.nextElementSibling.classList.contains("bt-trans"))
  );
  // 1 个标题 + 1 个段落直接显示，2 个标签各自悬停
  check("计数把隐式翻译也算进去", (await send(t.handlers, { type: "bt:query" })).count === 4);

  tag.dispatchEvent(new t.w.MouseEvent("mouseover", { bubbles: true }));
  const tip = t.w.document.querySelector(".bt-tip");
  check("悬停时出现提示气泡并带译文", !!tip && tip.hidden === false && tip.textContent.startsWith("【译】"), tip ? JSON.stringify(tip.textContent.slice(0, 30)) : "无气泡");

  tag.dispatchEvent(new t.w.MouseEvent("mouseout", { bubbles: true }));
  check("移开后气泡隐藏", t.w.document.querySelector(".bt-tip").hidden === true);

  await send(t.handlers, { type: "bt:set-active", value: false });
  check("关闭后隐式翻译不留痕迹", t.w.document.querySelectorAll("[data-bt-hover]").length === 0);
  check("关闭后气泡被移除", t.w.document.querySelector(".bt-tip") === null);
  check("关闭后 DOM 恢复原样", t.w.document.body.innerHTML === before);
  t.w.close();
}

/* ---------- 第六个场景：插入位置要照顾好布局 ---------- */
{
  const html = `<!doctype html><html><body>
    <div class="normal"><h3>Normal block heading with enough text to be translated inline</h3></div>
    <div style="display:flex"><h3>Flex child text that is long enough to be translated inline</h3></div>
    <ul><li>List item text that is long enough to be translated inline</li></ul>
  </body></html>`;
  const t = boot(html);
  await sleep(50);
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);

  const [normal, flex, li] = [
    t.w.document.querySelector(".normal h3"),
    t.w.document.querySelector("div[style] h3"),
    t.w.document.querySelector("li"),
  ];
  check(
    "普通流式布局：译文插在原文后面（兄弟节点）",
    normal.nextElementSibling && normal.nextElementSibling.classList.contains("bt-trans") &&
      normal.querySelector(".bt-trans") === null
  );
  check(
    "flex 容器：译文插到元素内部，不新增 flex 子项",
    !!flex.querySelector(".bt-trans") && flex.nextElementSibling === null
  );
  check(
    "列表项：译文插到 li 内部，不塞进 ul",
    !!li.querySelector(".bt-trans") && t.w.document.querySelector("ul > .bt-trans") === null
  );
  t.w.close();
}

/* ---------- 第七个场景：用户名 / 作者名不翻 ---------- */
{
  const html = `<!doctype html><html><body>
    <article>
      <h2>Post title with enough words to translate</h2>
      <div class="post-meta">Posted by <span class="author-name">JaneDoe92</span> on <time>2024-05-01</time></div>
      <div itemprop="author"><a href="/profile/42">Alex</a></div>
      <div class="byline">by <a href="/user/johndoe">JohnDoe</a></div>
      <a class="author-bio" href="/author/jane">Jane writes about extensions and tooling</a>
      <p>Real content paragraph that is long enough to be worth translating properly.</p>
    </article>
  </body></html>`;
  const t = boot(html);
  await sleep(50);
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);

  const sent = t.calls.map((c) => c.text);
  const shown = [...t.w.document.querySelectorAll(".bt-trans")].map((d) => d.textContent);
  const hovered = [...t.w.document.querySelectorAll("[data-bt-hover]")].map((d) => d.textContent);
  const everything = sent.join(" | ") + " || " + shown.join(" | ") + " || " + hovered.join(" | ");

  check("itemprop=author 的作者名不翻", !everything.includes("Alex"));
  check("byline 里的用户名不翻", !everything.includes("JohnDoe"));
  check("署名碎片「Posted by」不翻", !sent.some((s) => /^posted by$/i.test(s)));
  check("只含日期的片段不翻", !sent.some((s) => s.includes("2024-05-01")));
  check("作者简介不算用户名，照翻", sent.some((s) => s.includes("Jane writes about")));
  check("标题和正文照翻", sent.some((s) => s.includes("Post title")) && sent.some((s) => s.includes("Real content paragraph")));

  // 关掉开关后用户名又会被翻译
  await send(t.handlers, { type: "bt:settings", value: { skipNames: false } });
  await send(t.handlers, { type: "bt:set-active", value: false });
  await send(t.handlers, { type: "bt:set-active", value: true });
  await sleep(250);
  check("关掉开关后用户名会被翻译", t.calls.some((c) => c.text.includes("JaneDoe92")));
  t.w.close();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
