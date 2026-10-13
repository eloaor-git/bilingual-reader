const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  targetLang: "zh-CN",
  autoGoogle: false,
  onlyTranslated: false,
  shortMode: "hover",
  skipNames: true,
  provider: "mymemory",
};
const BLOCKED = /^(chrome|edge|brave|opera|about|devtools|view-source|chrome-extension|extension):/i;

let settings = { ...DEFAULTS };
let creds = {};
let providers = [];
let tabId = null;
let supported = true;
let pollTimer = null;

/* ---------- 与内容脚本通信 ---------- */

async function getState() {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "bt:query" });
  } catch (e) {
    return null; // 该页面还没注入内容脚本
  }
}

async function ensureInjected() {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- 状态显示 ---------- */

function describe(state) {
  if (state.count > 0) return `已翻译 ${state.count} 处`;
  if (state.failures > 0) {
    const detail = state.lastError ? `：${state.lastError}` : "";
    return `翻译失败 ${state.failures} 次${detail}`.slice(0, 120);
  }
  return "正在翻译…";
}

function paint(state) {
  const btn = $("toggle");
  const status = $("status");

  if (!supported) {
    btn.disabled = true;
    btn.textContent = "此页面不支持";
    status.textContent = "浏览器内部页面无法注入脚本";
    return;
  }

  if (state && state.active) {
    btn.disabled = false;
    btn.textContent = "还原原文";
    status.textContent = describe(state);
    startPolling();
  } else {
    btn.disabled = false;
    btn.textContent = "翻译此页";
    status.textContent = state ? "未翻译" : "点击后在当前页面启用";
    stopPolling();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const s = await getState();
    if (!s) return stopPolling();
    $("status").textContent = describe(s);
  }, 600);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshPage() {
  const st = await getState();
  if (!st || !st.active) return;
  // 换引擎后要让页面用新引擎重翻
  await chrome.tabs.sendMessage(tabId, { type: "bt:set-active", value: false }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "bt:set-active", value: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  paint({ active: true, count: 0 });
}

/* ---------- 开关按钮 ---------- */

async function onToggle() {
  if (tabId == null) return;
  let state = await getState();
  if (!state) {
    const ok = await ensureInjected();
    if (!ok) {
      supported = false;
      paint(null);
      return;
    }
    state = { active: false, count: 0 };
  }
  const res = await chrome.tabs
    .sendMessage(tabId, { type: "bt:set-active", value: !state.active })
    .catch(() => null);
  paint(res || { active: !state.active, count: 0 });
}

/* ---------- 引擎配置 ---------- */

const currentProvider = () => providers.find((p) => p.id === $("provider").value) || null;

function renderProviderOptions() {
  const sel = $("provider");
  sel.textContent = "";
  for (const p of providers) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    sel.append(o);
  }
  sel.value = settings.provider;
}

function renderProviderFields() {
  const p = currentProvider();
  const box = $("pfields");
  box.textContent = "";
  $("pnote").textContent = p ? p.note : "";
  if (!p) return;

  const stored = creds[p.id] || {};
  for (const f of p.fields) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = f.label;
    const input = document.createElement("input");
    const secret = /key|token|secret/i.test(f.key);
    input.type = secret ? "password" : "text";
    input.autocomplete = "off";
    input.placeholder = f.placeholder || "";
    input.value = stored[f.key] || "";
    input.dataset.key = f.key;
    label.append(span, input);
    box.append(label);
  }
}

function readFields() {
  const values = {};
  for (const input of $("pfields").querySelectorAll("input")) {
    values[input.dataset.key] = input.value.trim();
  }
  return values;
}

function renderTestResult(res) {
  const out = $("diagout");
  out.hidden = false;
  if (!res || !res.ok) {
    out.textContent = "后台无响应：" + ((res && res.error) || "未知错误");
    return;
  }
  const lines = [`当前引擎：${res.label}`];
  if (res.missing && res.missing.length) lines.push("[warn] 还缺配置：" + res.missing.join("、"));
  for (const r of res.results) {
    lines.push(r.ok ? `[ok] ${r.endpoint}  ${r.ms}ms  →  ${r.text}` : `[err] ${r.endpoint}  ${r.error}`);
  }
  out.textContent = lines.join("\n");
}

async function saveAndTest() {
  const p = currentProvider();
  if (!p) return;
  const out = $("diagout");
  out.hidden = false;

  // 注意：下面这个权限申请必须是本次点击里的第一个异步调用，否则用户手势会失效
  const values = readFields();
  if (p.needsOrigin && values.base) {
    let origin;
    try {
      const u = new URL(values.base);
      origin = `${u.protocol}//${u.hostname}/*`; // match pattern 不能带端口
    } catch (e) {
      out.textContent = "接口地址无法解析：" + e.message;
      return;
    }
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        out.textContent = `未获得 ${origin} 的访问权限，无法调用该接口`;
        return;
      }
    } catch (e) {
      out.textContent = "申请访问权限失败：" + e.message;
      return;
    }
  }

  creds[p.id] = { ...(creds[p.id] || {}), ...values };
  settings.provider = p.id;
  await chrome.storage.local.set({ "bt:settings": settings, "bt:creds": creds });

  out.textContent = "正在测试…";
  const res = await chrome.runtime
    .sendMessage({ type: "bt:selftest", tl: settings.targetLang })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  renderTestResult(res);
  await refreshPage();
}

function persist() {
  chrome.storage.local
    .set({ "bt:settings": settings, "bt:creds": creds })
    .catch(() => {});
}

/* ---------- 初始化 ---------- */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id != null ? tab.id : null;
  if (tab && typeof tab.url === "string" && BLOCKED.test(tab.url)) supported = false;

  const stored = await chrome.storage.local.get(["bt:settings", "bt:creds"]).catch(() => ({}));
  if (stored && stored["bt:settings"]) settings = { ...settings, ...stored["bt:settings"] };
  if (stored && stored["bt:creds"]) creds = stored["bt:creds"];

  const list = await chrome.runtime.sendMessage({ type: "bt:providers" }).catch(() => null);
  if (list && list.ok) providers = list.providers;
  if (!settings.provider && list) settings.provider = list.defaultProvider;
  renderProviderOptions();
  renderProviderFields();

  $("lang").value = settings.targetLang;
  $("short").value = settings.shortMode || "hover";
  $("auto").checked = !!settings.autoGoogle;
  $("only").checked = !!settings.onlyTranslated;
  $("names").checked = settings.skipNames !== false;

  paint(supported ? await getState() : null);

  $("toggle").addEventListener("click", onToggle);
  $("save").addEventListener("click", saveAndTest);

  $("provider").addEventListener("change", (e) => {
    settings.provider = e.target.value;
    persist();
    $("diagout").hidden = true;
    renderProviderFields();
  });

  $("lang").addEventListener("change", async (e) => {
    settings.targetLang = e.target.value;
    persist();
    await refreshPage();
  });

  $("short").addEventListener("change", async (e) => {
    settings.shortMode = e.target.value;
    persist();
    await chrome.tabs
      .sendMessage(tabId, { type: "bt:settings", value: { shortMode: settings.shortMode } })
      .catch(() => {});
    await refreshPage();
  });

  $("auto").addEventListener("change", (e) => {
    settings.autoGoogle = e.target.checked;
    persist();
  });

  $("only").addEventListener("change", async (e) => {
    settings.onlyTranslated = e.target.checked;
    persist();
    await chrome.tabs
      .sendMessage(tabId, { type: "bt:settings", value: { onlyTranslated: settings.onlyTranslated } })
      .catch(() => {});
  });

  $("names").addEventListener("change", async (e) => {
    settings.skipNames = e.target.checked;
    persist();
    await chrome.tabs
      .sendMessage(tabId, { type: "bt:settings", value: { skipNames: settings.skipNames } })
      .catch(() => {});
    await refreshPage();
  });

  window.addEventListener("unload", stopPolling);
}

init();
