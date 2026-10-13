/* 探测各个翻译引擎在当前网络下是否可达，并给出实测延迟。

   用法：npm run check:endpoint

   扩展发的是同一批请求（见 src/providers.js）。这里连不上的引擎，扩展也用不了。
   换引擎不必靠猜：这张表直接告诉你哪个能用。 */

import { PROVIDERS, getProvider } from "../src/providers.js";

const PROBES = [
  ["mymemory", {}],
  ["baidu", { appid: "probe", key: "probe" }],
  ["caiyun", { token: "probe" }],
  ["deepl", { key: "probe:fx" }],
  ["google", {}],
];

const TIMEOUT = 8000;
let usable = 0;

const pad = (s, n) => String(s).padEnd(n, " ");
const placeholder = (cfg) =>
  cfg.appid === "probe" || cfg.token === "probe" || cfg.key === "probe:fx";

for (const [id, cfg] of PROBES) {
  const provider = getProvider(id);
  const builds = provider.multi || [provider.build];
  console.log(`\n${provider.label}`);

  for (let i = 0; i < builds.length; i++) {
    const req = builds[i]("hello world", "zh-CN", cfg);
    const host = new URL(req.url).host;
    const tag = builds.length > 1 ? `#${i + 1} ` : "";
    const t0 = Date.now();
    try {
      const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(TIMEOUT) });
      const ms = Date.now() - t0;
      // 401/403 这类说明网络是通的，只是我们塞的是占位凭证
      if (placeholder(cfg) && res.status >= 400 && res.status < 500) {
        usable++;
        console.log(`  [warn] ${pad(tag + host, 34)} ${ms}ms  可达（HTTP ${res.status}，凭证是占位符）`);
        continue;
      }
      if (!res.ok) {
        console.log(`  [err]  ${pad(tag + host, 34)} ${ms}ms  HTTP ${res.status}`);
        continue;
      }
      const parsed = provider.parse(await res.json().catch(() => null));
      if (parsed) {
        usable++;
        console.log(`  [ok]   ${pad(tag + host, 34)} ${ms}ms  →  ${parsed}`);
      } else {
        if (placeholder(cfg)) {
          usable++;
          console.log(`  [warn] ${pad(tag + host, 34)} ${ms}ms  可达（凭证是占位符）`);
        } else {
          console.log(`  [warn] ${pad(tag + host, 34)} ${ms}ms  响应无法解析`);
        }
      }
    } catch (e) {
      const cause = (e.cause && e.cause.code) || e.name;
      console.log(`  [err]  ${pad(tag + host, 34)} ${Date.now() - t0}ms  ${cause}`);
    }
  }
}

console.log(
  usable
    ? `\n有 ${usable} 个端点可用 —— 在扩展弹窗里选对应的引擎，填好凭证点「保存并测试」。`
    : "\n没有端点可用：网络把翻译服务全挡住了，需要检查代理规则。"
);
process.exit(usable ? 0 : 1);
