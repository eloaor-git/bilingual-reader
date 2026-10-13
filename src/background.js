/* 后台 Service Worker：翻译请求 + 持久化缓存 + 引擎路由 + 批量合并。
   引擎细节在 providers.js；这里负责选引擎、合并请求、切分长文本、缓存、熔断。 */

import { PROVIDERS, getProvider, DEFAULT_PROVIDER, chunkByBytes } from "./providers.js";

const CACHE_KEY = "bt:cache";
const CACHE_LIMIT = 4000;
const FLUSH_DELAY = 2000;
const BREAKER_MS = 20000; // 连续失败后静默这么久，别让整页每块都白等一遍
const DEFAULT_TIMEOUT = 15000;
const BATCH_DELAY = 120; // 攒多久凑一批（只对声明了 batch 的引擎生效）
const BATCH_TIMEOUT = 40000; // 一次翻多条本来就慢，给宽一点
const CONTEXT_TTL = 300000;

const mem = new Map(); // "引擎|tl|原文" -> 译文，Map 的插入顺序充当 LRU
let dirty = false;
let flushTimer = null;
let loadPromise = null;
let settings = null;
const contexts = new Map(); // tabId -> 页面背景（标题/摘要…），给 LLM 用
const preferredByProvider = {}; // 引擎 -> 上次成功的端点在 multi 里的下标
let breaker = { provider: null, until: 0, error: null };

/* ---------- 设置 ---------- */

async function getSettings() {
  if (!settings) {
    const r = await chrome.storage.local.get(["bt:settings", "bt:creds"]).catch(() => ({}));
    const s = (r && r["bt:settings"]) || {};
    settings = {
      provider: s.provider || DEFAULT_PROVIDER,
      targetLang: s.targetLang || "zh-CN",
      creds: (r && r["bt:creds"]) || {},
    };
  }
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes["bt:settings"] || changes["bt:creds"])) {
    settings = null; // 下次请求重新读，弹窗改完立即生效
  }
});

async function currentProvider() {
  const s = await getSettings();
  return getProvider(s.provider) || getProvider(DEFAULT_PROVIDER);
}

/* ---------- 缓存 ---------- */

function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = chrome.storage.local
      .get(CACHE_KEY)
      .then((r) => {
        const obj = r && r[CACHE_KEY];
        if (obj) for (const k in obj) mem.set(k, obj[k]);
      })
      .catch(() => {});
  }
  return loadPromise;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DELAY);
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  const obj = Object.create(null);
  for (const [k, v] of mem) obj[k] = v;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: obj });
  } catch (e) {
    /* 配额或序列化问题，忽略即可，缓存不是必需品 */
  }
}

// 缓存必须按引擎区分，否则换引擎后会把上一个引擎的译文端上来
const cacheKey = (providerId, text, tl) => `${providerId}\u0000${tl}\u0000${text}`;

function putCache(providerId, text, tl, out) {
  const k = cacheKey(providerId, text, tl);
  mem.set(k, out);
  while (mem.size > CACHE_LIMIT) mem.delete(mem.keys().next().value);
  scheduleFlush();
}

function takeCache(providerId, text, tl) {
  const k = cacheKey(providerId, text, tl);
  if (!mem.has(k)) return undefined;
  const hit = mem.get(k);
  mem.delete(k);
  mem.set(k, hit); // 触碰，保持 LRU 顺序
  return hit;
}

/* ---------- 单次请求（build/parse 由调用方给，单条与批量共用） ---------- */

async function attempt(provider, cfg, build, parse, timeoutMs) {
  let req;
  try {
    req = build();
  } catch (e) {
    return { ok: false, status: 0, ms: 0, error: "构造请求失败：" + e.message };
  }

  const limit = timeoutMs || provider.timeout || DEFAULT_TIMEOUT;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limit);
  const t0 = Date.now();
  try {
    const res = await fetch(req.url, { ...req.init, signal: ctl.signal });
    const ms = Date.now() - t0;
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
      } catch (e) {
        /* 读不到就算了 */
      }
      return {
        ok: false,
        network: true,
        status: res.status,
        ms,
        error: `HTTP ${res.status}${detail ? " " + detail : ""}`,
      };
    }
    const data = await res.json().catch(() => null);
    const value = parse(data);
    if (!value) {
      const hint = data && data.error_code ? `（错误码 ${data.error_code}）` : "";
      return { ok: false, network: false, status: res.status, ms, error: "响应无法解析" + hint };
    }
    return { ok: true, status: res.status, ms, value };
  } catch (e) {
    const ms = Date.now() - t0;
    const error =
      e && e.name === "AbortError" ? `请求超时(>${limit / 1000}s)` : (e && e.message) || String(e);
    return { ok: false, network: true, status: 0, ms, error };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 逐条翻译 ---------- */

async function translateRemote(text, tl, ctx, provider) {
  const cfg = (await getSettings()).creds[provider.id] || {};

  const missing = (provider.fields || [])
    .filter((f) => !f.optional && !cfg[f.key])
    .map((f) => f.label);
  if (missing.length) throw new Error(`「${provider.label}」还没配置：${missing.join("、")}`);

  if (breaker.provider === provider.id && Date.now() < breaker.until) {
    throw breaker.error || new Error("端点暂不可用");
  }

  const builds = provider.multi || [provider.build];
  const chunks = provider.chunk ? chunkByBytes(text, provider.chunk) : [text];
  const attempts = [];
  const out = [];

  const fail = () => {
    const detail = attempts.map((a) => `${a.endpoint}=${a.error}`).join("；");
    const err = new Error(`「${provider.label}」失败：${detail}`);
    err.attempts = attempts;
    breaker = { provider: provider.id, until: Date.now() + BREAKER_MS, error: err };
    throw err;
  };

  for (const chunk of chunks) {
    let done = false;
    const start = preferredByProvider[provider.id] || 0;
    for (let k = 0; k < builds.length; k++) {
      const i = (start + k) % builds.length;
      const r = await attempt(
        provider,
        cfg,
        () => builds[i](chunk, tl, cfg, ctx),
        (j) => provider.parse(j, chunk)
      );
      attempts.push({
        endpoint: builds.length > 1 ? `${provider.id}#${i + 1}` : provider.id,
        status: r.status,
        ms: r.ms,
        error: r.error,
      });
      if (r.ok) {
        preferredByProvider[provider.id] = i;
        breaker = { provider: null, until: 0, error: null };
        out.push(r.value);
        done = true;
        break;
      }
    }
    if (!done) fail();
  }

  return out.join(" ").trim();
}

async function translateOne(text, tl, ctx, provider) {
  const hit = takeCache(provider.id, text, tl);
  if (hit !== undefined) return hit;
  const out = await translateRemote(text, tl, ctx, provider);
  putCache(provider.id, text, tl, out);
  return out;
}

/* ---------- 批量合并 ---------- */

const batchQueue = [];
let batchTimer = null;

function queueTranslate(text, tl, ctx) {
  if (typeof text !== "string" || !text) return Promise.resolve("");
  return ensureLoaded().then(async () => {
    const provider = await currentProvider();
    const hit = takeCache(provider.id, text, tl);
    if (hit !== undefined) return hit;

    if (!provider.batch || !provider.buildBatch) {
      return translateOne(text, tl, ctx, provider);
    }
    return new Promise((resolve, reject) => {
      batchQueue.push({ text, tl, ctx, providerId: provider.id, resolve, reject });
      if (!batchTimer) batchTimer = setTimeout(() => flushBatch().catch(() => {}), BATCH_DELAY);
    });
  });
}

async function flushBatch() {
  batchTimer = null;
  const items = batchQueue.splice(0, batchQueue.length);
  if (!items.length) return;

  const provider = await currentProvider();
  // 排队期间用户换引擎了：按当前引擎重来一遍最稳妥
  if (!provider.batch || !provider.buildBatch) {
    for (const it of items) {
      translateOne(it.text, it.tl, it.ctx, provider).then(it.resolve, it.reject);
    }
    return;
  }

  const max = provider.batch;
  const groups = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= (max.maxItems || 10) || chars + it.text.length > (max.maxChars || 3000) || cur[0].tl !== it.tl)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) groups.push(cur);

  for (const g of groups) await runBatchGroup(provider, g);
}

async function runBatchGroup(provider, group) {
  const tl = group[0].tl;
  const ctx = group[0].ctx;
  const cfg = (await getSettings()).creds[provider.id] || {};
  const texts = group.map((g) => g.text);

  const fallbackToSingle = async (why) => {
    for (const g of group) {
      try {
        const hit = takeCache(provider.id, g.text, tl);
        g.resolve(hit !== undefined ? hit : await translateOne(g.text, tl, g.ctx, provider));
      } catch (e) {
        g.reject(e);
      }
    }
    return why;
  };

  const missing = (provider.fields || [])
    .filter((f) => !f.optional && !cfg[f.key])
    .map((f) => f.label);
  if (missing.length) return fallbackToSingle("未配置");

  const r = await attempt(
    provider,
    cfg,
    () => provider.buildBatch(texts, tl, cfg, ctx),
    (j) => provider.parseBatch(j, texts.length),
    provider.batch.timeout || BATCH_TIMEOUT
  );

  if (r.ok && Array.isArray(r.value) && r.value.length === texts.length) {
    breaker = { provider: null, until: 0, error: null };
    group.forEach((g, i) => {
      putCache(provider.id, g.text, tl, r.value[i]);
      g.resolve(r.value[i]);
    });
    return;
  }

  // 网络类失败要熔断；只是模型输出格式不对则退回逐条，别把整页拖死
  if (r.network) {
    const err = new Error(`「${provider.label}」失败：${r.error}`);
    breaker = { provider: provider.id, until: Date.now() + BREAKER_MS, error: err };
    for (const g of group) g.reject(err);
    return;
  }
  return fallbackToSingle("批量解析失败");
}

/* ---------- 诊断：拿当前引擎真打一次网络 ---------- */

async function selfTest(tl) {
  const s = await getSettings();
  const provider = getProvider(s.provider) || getProvider(DEFAULT_PROVIDER);
  const cfg = s.creds[provider.id] || {};
  const builds = provider.multi || [provider.build];

  const missing = (provider.fields || [])
    .filter((f) => !f.optional && !cfg[f.key])
    .map((f) => f.label);

  const results = [];
  for (let i = 0; i < builds.length; i++) {
    const r = await attempt(
      provider,
      cfg,
      () => builds[i]("hello world", tl, cfg, null),
      (j) => provider.parse(j, "hello world")
    );
    results.push({
      endpoint: builds.length > 1 ? `${provider.id}#${i + 1}` : provider.id,
      ok: r.ok,
      status: r.status,
      ms: r.ms,
      error: r.error || null,
      text: r.ok ? r.value : null,
    });
  }
  if (results.some((r) => r.ok)) breaker = { provider: null, until: 0, error: null };

  return { provider: provider.id, label: provider.label, missing, results };
}

/* ---------- 消息处理 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === "bt:context") {
    if (tabId != null) {
      contexts.set(tabId, { ...msg.value, at: Date.now() });
      for (const [k, v] of contexts) {
        if (Date.now() - v.at > CONTEXT_TTL) contexts.delete(k);
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "bt:translate") {
    const ctx = tabId != null ? contexts.get(tabId) : null;
    queueTranslate(msg.text, msg.tl || "zh-CN", ctx).then(
      (text) => sendResponse({ ok: true, text }),
      (err) =>
        sendResponse({
          ok: false,
          error: String((err && err.message) || err),
          attempts: (err && err.attempts) || null,
        })
    );
    return true; // 异步响应
  }

  if (msg.type === "bt:selftest") {
    selfTest(msg.tl || "zh-CN").then(
      (r) => sendResponse({ ok: true, ...r }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  if (msg.type === "bt:providers") {
    sendResponse({
      ok: true,
      defaultProvider: DEFAULT_PROVIDER,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        note: p.note,
        fields: p.fields || [],
        needsOrigin: !!p.needsOrigin,
        batched: !!p.batch,
      })),
    });
    return;
  }

  if (msg.type === "bt:count") {
    if (tabId != null) {
      const text = msg.count > 0 ? String(msg.count).slice(0, 4) : "";
      chrome.action.setBadgeText({ tabId, text });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#4c8bf5" });
    }
    sendResponse({ ok: true });
    return;
  }
});

/* ---------- 快捷键 Alt+T ---------- */

async function injectInto(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  let state = null;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: "bt:query" });
  } catch (e) {
    state = null;
  }
  if (!state) {
    try {
      await injectInto(tab.id);
    } catch (e) {
      return; // 受限页面，静默失败
    }
  }
  chrome.tabs.sendMessage(tab.id, { type: "bt:toggle" }).catch(() => {});
});
