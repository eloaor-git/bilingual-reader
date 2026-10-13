/* 双语对照翻译 · 内容脚本
   核心策略：找出「最小可独立翻译的块级元素」，在它后面追加一个译文节点。
   原文一个字节都不改，所以还原 = 删掉自己插入的节点，零风险。 */

(() => {
  if (window.__btLoaded) return;
  window.__btLoaded = true;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "BUTTON", "CODE", "PRE", "KBD", "SAMP", "VAR", "SVG", "CANVAS", "IFRAME",
    "TEMPLATE", "AUDIO", "VIDEO", "OBJECT", "EMBED", "CITE",
  ]);
  const HAS_LATIN = /[A-Za-z]{2,}/;
  const HAS_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
  const CJK_TARGETS = new Set(["zh-CN", "zh-TW", "ja", "ko"]);

  const MIN_LEN = 8;        // 短于此长度不值得翻
  const CONCURRENCY = 5;    // 并发请求数
  const LATIN_RATIO = 0.3;  // 目标语言是中文时，原文英文占比高于此值才翻
  const SCAN_DEBOUNCE = 300;
  const LETTER_RATIO = 0.45; // 字母占比低于此值说明是数字/单位/符号，不值得翻

  // 只有这些 display 值的元素才配当「翻译单元」。行内元素（a/em/span）永远不单独成块，
  // 否则 <p>长文本 <a>很长的链接文字</a> 里，段落会被拆散、裸文本节点会被漏掉。
  const BLOCK_DISPLAYS = new Set([
    "block", "flow-root", "list-item", "flex", "grid", "table", "table-row",
    "table-cell", "table-caption", "table-row-group", "table-header-group",
    "table-footer-group",
  ]);
  // 代码块、按钮、输入框这类"不可翻但有内容"的区域，且自身是盒子（非纯行内）
  const BOX_DISPLAYS = new Set([
    ...BLOCK_DISPLAYS, "inline-block", "inline-flex", "inline-grid",
  ]);

  const settings = {
    targetLang: "zh-CN",
    autoGoogle: false,
    onlyTranslated: false,
    shortMode: "hover", // 短块：hover=鼠标悬停才显示，inline=直接显示
    hoverBelow: 30,     // 短于此长度的块算「小」，默认走悬停
    skipNames: true,    // 跳过用户名 / 作者名
  };

  let active = false;
  let observer = null;
  let scanTimer = null;
  let unitMemo = new WeakMap();
  let hasMemo = new WeakMap();
  let blockedMemo = new WeakMap();

  const localCache = new Map(); // 归一化原文 -> 译文（本页会话内即时命中）
  const jobs = new Map();       // 原文 -> Set<Element>
  const queue = [];             // 待翻译原文，按可见优先级排序
  let running = 0;
  let failures = 0;
  let lastError = "";
  let doneRuns = new WeakSet();   // 已处理过的行内片段（锚点节点）
  let hoverText = new WeakMap();  // 走悬停显示的元素 -> 译文
  let tipEl = null;               // 全局提示气泡，只在需要时创建

  const norm = (s) => (s || "").replace(/[\s\u00a0]+/g, " ").trim();

  /* ---------- 1. 选块 ---------- */

  // 各类「不值得翻」的文本：URL、邮箱、代码标识符、纯数字单位
  const URLISH = /(https?:\/\/|www\.)|[\w.+-]+@[\w-]+\.[A-Za-z]{2,}|\b[\w-]+\.(com|cn|org|net|io|dev|gg|co|edu|gov)\b/i;
  const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[._$][A-Za-z_$][\w$]*)+$|^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
  const NUMERIC = /^[\s\d\p{P}\p{S}\u00a5$€£%°+]+$/u;

  /* ---------- 1.1 标题正文 还是 外围标签 ---------- */

  // 外围区域：导航、页眉页脚、侧栏、工具条、标签页……这些地方的内容默认不占版面
  const PERIPHERAL_SELECTOR = [
    "nav", "header", "footer", "aside", "menu",
    '[role="navigation"]', '[role="menu"]', '[role="menubar"]', '[role="tablist"]',
    '[role="toolbar"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
    '[role="search"]',
  ].join(",");

  // 类名 / ID 里出现这些词，基本是元数据而不是正文：标签、分类、面包屑、工具栏…
  const PERIPHERAL_WORDS =
    /(^|[-_ ])(nav|navbar|menu|breadcrumb|crumb|pagination|pager|tag|tags|taglist|label|labels|chip|chips|badge|pill|category|categories|meta|metadata|byline|toolbar|action|actions|sidebar|widget|filter|filters|sort|tab|tabs|stat|stats|count|info|attr|spec|specs|related|share|social|subscribe|follow|rating|stars|vote|votes|uploader|author)([-_ ]|$)/i;

  // 正文区域的提示词
  const CONTENT_WORDS =
    /(^|[-_ ])(content|body|post|entry|article|description|summary|text|paragraph|prose|rich|markdown|answer|question|review|comment|commentary|bio|intro|abstract|excerpt)([-_ ]|$)/i;

  const hintOf = (el) =>
    (typeof el.className === "string" ? el.className : "") + " " + (el.id || "");

  function peripheralHint(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest && el.closest(PERIPHERAL_SELECTOR)) return true;
    let n = el;
    let hops = 0;
    while (n && n.nodeType === 1 && hops < 4) {
      const h = hintOf(n);
      if (h.trim() && PERIPHERAL_WORDS.test(h)) return true;
      n = n.parentElement;
      hops++;
    }
    return false;
  }

  const looksLikeProse = (t) => t.length >= 60 && /[.!?。！？]/.test(t);

  function contentHint(el, t) {
    if (!el || el.nodeType !== 1) return false;
    if (/^H[1-6]$/.test(el.tagName)) return true; // 标题属于正文，要直接显示
    if (
      el.matches &&
      el.matches('[itemprop~="articleBody"], [itemprop~="reviewBody"], [itemprop~="description"], [itemprop~="text"]')
    ) {
      return true;
    }
    const h = hintOf(el);
    if (h.trim() && CONTENT_WORDS.test(h)) return true;
    if (/^(P|LI|TD|BLOCKQUOTE|DD)$/.test(el.tagName) && looksLikeProse(t)) return true;
    return false;
  }

  // 标签类内容：短、且没有第二句。满足才值得用悬停，否则长段落悬停没法读
  function looksLikeLabel(t) {
    if (t.length > 120) return false;
    if (/[.!?。！？]["')\]]?\s+\S/.test(t)) return false;
    return true;
  }

  /* ---------- 1.2 特殊文本：用户名 / 作者名 ---------- */

  const USER_HINTS =
    /(username|user-name|user_name|userid|user-id|userlink|user-link|nickname|nick-name|nick|handle|byline|display-?name|screen-?name|author|poster|uploader|contributor)/i;
  // 出现这些词说明那个容器装的是别的东西（简介、头像、日期…），不是名字本身
  const NOT_NAME =
    /(bio|biography|desc|description|content|text|body|comment|avatar|image|photo|pic|icon|signature|about|since|joined|date|time|count|stats|level|rank|role)/i;
  const USER_ATTRS = ["data-author", "data-username", "data-user", "data-nick", "data-display-name"];
  const USER_HREF = /^\/(user|u|users|member|members|profile|people|author|accounts?|@)([/?#]|$)/i;
  const USER_HREF_Q = /[?&](uid|user_?id|userid|author_?id)=/i;
  const HANDLE_ONLY = /^@[\w.\-]{2,30}$/;
  const BY_PREFIX = /^(by|posted by|written by|author|uploaded by|作者|投稿者|投稿)\s*[:：]?\s/i;
  // 归一化之后整段就只剩一个「by / 作者：」，是署名被拆剩下的碎片
  const BYLINE_FRAGMENT = /^(by|posted by|written by|uploaded by|author|作者|投稿者|投稿|发布者)\s*[:：]?$/i;

  // 名字都很短、词很少、也不成句。文本不像名字时，哪怕它挂在用户链接上也不算用户名，
  // 否则「作者简介」这类长文本会被整段跳过。
  function looksLikeName(t) {
    if (t.length > 40) return false;
    if (/[.!?。！？]/.test(t)) return false;
    return (t.match(/[A-Za-z\u4e00-\u9fff]+/g) || []).length <= 4;
  }

  // 有界搜索：这个块里面是否混着用户名。命中就让块下沉，交给逐段逻辑把名字排掉
  function hasUserName(el) {
    const stack = [{ n: el, d: 0 }];
    let seen = 0;
    while (stack.length && seen < 80) {
      const { n, d } = stack.pop();
      seen++;
      if (n !== el && isUserNameish(n)) return true;
      if (d >= 3) continue;
      const kids = n.children;
      for (let i = 0; i < kids.length; i++) stack.push({ n: kids[i], d: d + 1 });
    }
    return false;
  }

  function isUserNameish(el) {
    if (!el || el.nodeType !== 1) return false;
    // 结构化标注最可靠：rel=author / itemprop=author / address
    if (
      el.matches &&
      el.matches('[rel~="author"], [itemprop~="author"], [itemprop~="creator"], [itemprop~="accountablePerson"]')
    ) {
      return true;
    }
    for (const a of USER_ATTRS) if (el.hasAttribute && el.hasAttribute(a)) return true;
    if (el.closest && el.closest("address")) return true;

    const t = norm(el.textContent);
    if (HANDLE_ONLY.test(t)) return true; // @someone
    if (t.length < 40 && BY_PREFIX.test(t)) return true; // by John / 作者：张三
    if (!looksLikeName(t)) return false; // 不像名字的长文本就此打住

    let n = el;
    let hops = 0;
    while (n && n.nodeType === 1 && hops < 3) {
      const h = hintOf(n);
      if (h.trim() && USER_HINTS.test(h) && !NOT_NAME.test(h)) return true;
      n = n.parentElement;
      hops++;
    }

    // 指向用户主页的链接：名字几乎总是挂在这样的链接上。
    // 只在本元素就是那个链接、或本元素本身就是个短容器时才这么判，
    // 否则正文里随便一个 /profile/ 链接就会让整篇文章被跳过。
    const a = el.tagName === "A" ? el : el.querySelector ? el.querySelector("a[href]") : null;
    if (a) {
      const href = a.getAttribute("href") || "";
      if (USER_HREF.test(href) || USER_HREF_Q.test(href)) return true;
    }
    return false;
  }

  function worthTranslating(t) {
    if (t.length < MIN_LEN) return false;
    if (BYLINE_FRAGMENT.test(t)) return false;
    if (NUMERIC.test(t)) return false;
    if (URLISH.test(t)) return false;
    if (IDENTIFIER.test(t)) return false;
    if (!HAS_LATIN.test(t)) return false;

    const latin = (t.match(/[A-Za-z]/g) || []).length;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const ratio = latin / t.length;

    // 字母太少说明是型号、尺寸、价格、时间这类内容
    if ((latin + cjk) / t.length < LETTER_RATIO) return false;

    // 只有一个短词的大多是 UI 里的 New / OK / HOME，翻出来反而多余
    const words = t.match(/[A-Za-z]{2,}/g) || [];
    const longest = words.reduce((m, w) => Math.max(m, w.length), 0);
    if (words.length < 2 && longest < 5) return false;

    // 目标是中日韩：原文英文占比够高才翻，避免把已是中文的内容再翻一遍
    if (CJK_TARGETS.has(settings.targetLang)) return ratio >= LATIN_RATIO;
    // 目标是英文等拉丁语言：含有中日韩字符才翻
    return cjk > 0;
  }

  function displayOf(el) {
    try {
      return getComputedStyle(el).display;
    } catch (e) {
      return "block";
    }
  }

  const blockLike = (el) => BLOCK_DISPLAYS.has(displayOf(el));

  // 注意：getComputedStyle 的 display 不继承，子元素不会因为祖先 display:none 而变成 none。
  // 所以优先用 checkVisibility（会连同祖先一起判断），并在遍历时对隐藏子树整体剪枝。
  function rendered(el) {
    if (typeof el.checkVisibility === "function") {
      try {
        return el.checkVisibility({ checkVisibilityCSS: true });
      } catch (e) {
        /* 落到下面的兜底判断 */
      }
    }
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  // 不可翻但有内容的区域（代码块、按钮、输入框…），会阻止它的祖先被整体翻译
  function isBlockedRegion(el) {
    return (
      SKIP_TAGS.has(el.tagName) &&
      BOX_DISPLAYS.has(displayOf(el)) &&
      norm(el.textContent).length >= MIN_LEN
    );
  }

  function hasBlocked(el) {
    if (blockedMemo.has(el)) return blockedMemo.get(el);
    blockedMemo.set(el, false);
    let r = isBlockedRegion(el);
    if (!r) {
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) {
        if (hasBlocked(kids[i])) {
          r = true;
          break;
        }
      }
    }
    blockedMemo.set(el, r);
    return r;
  }

  // 行内子项个数：用来判断外围容器（导航、标签列表）该不该拆成逐项
  function inlineChildren(el) {
    let n = 0;
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (!SKIP_TAGS.has(k.tagName) && !blockLike(k) && norm(k.textContent)) n++;
    }
    return n;
  }

  // el 或其后代中是否已经存在一个更合适的翻译单元
  function hasUnit(el) {
    if (hasMemo.has(el)) return hasMemo.get(el);
    hasMemo.set(el, false);
    let r = isUnit(el);
    if (!r) {
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) {
        if (hasUnit(kids[i])) {
          r = true;
          break;
        }
      }
    }
    hasMemo.set(el, r);
    return r;
  }

  // 该元素是不是「该翻的最小块」：
  // 自身是块级、可见、文本值得翻，且后代里既没有更细的可翻块，也没有不可翻区域。
  // 用「后代」而不是「直接子元素」是关键：否则 <div><a><h3>标题</h3></a></div>
  // 会因为 a 不是单元而让最外层 div 反被当成单元，把整棵子树（含代码块）吞掉。
  function isUnit(el) {
    if (unitMemo.has(el)) return unitMemo.get(el);
    unitMemo.set(el, false);

    let ok = false;
    if (!SKIP_TAGS.has(el.tagName) && blockLike(el) && rendered(el)) {
      ok = worthTranslating(norm(el.innerText));
      // 块里混着用户名就下沉处理，免得把名字一起送出去翻
      if (ok && settings.skipNames && hasUserName(el)) ok = false;
      // 外围容器里有多个行内子项时也下沉：悬停一个标签只出这一个标签的译文，
      // 而不是整条导航/标签列表挤成一句话一起翻
      if (ok && peripheralHint(el) && inlineChildren(el) >= 2) ok = false;
      if (ok) {
        const kids = el.children;
        for (let i = 0; i < kids.length; i++) {
          if (hasUnit(kids[i]) || hasBlocked(kids[i])) {
            ok = false;
            break;
          }
        }
      }
    }
    unitMemo.set(el, ok);
    return ok;
  }

  function collect(root, out) {
    collectRuns(root, out);
    const kids = root.children;
    for (let i = 0; i < kids.length; i++) collectUnit(kids[i], out);
    return out;
  }

  function collectUnit(el, out) {
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.classList.contains("bt-trans")) return;
    if (el.dataset.bt === "1") return; // 已翻过
    if (doneRuns.has(el)) return; // 这个元素已被当作行内片段处理过，别再往下走一层重复翻
    if (!rendered(el)) return; // 隐藏子树整体跳过，不再往下走
    if (settings.skipNames && isUserNameish(el)) return; // 用户名、作者名不翻
    const raw = el.textContent;
    if (!raw || raw.length < MIN_LEN) return;
    if (isUnit(el)) {
      out.push({ kind: "el", el });
      return;
    }
    collect(el, out);
  }

  /* 行内片段：容器里被块级子元素隔开的连续行内内容。
     只认块级元素会整段漏掉这类裸文本，inline-block 里的文字更是一点都取不到，
     Wikipedia、Nexus Mods 这类站点特别多。 */
  function collectRuns(container, out) {
    const peripheral = peripheralHint(container);
    let buf = "";
    let anchor = null;
    const flush = () => {
      const text = norm(buf);
      if (text && anchor && !doneRuns.has(anchor)) {
        // 立刻占位：同一轮扫描里 collectUnit 还会再遇到这个元素，
        // 不占位它就会往下走一层、把同一段文字以另一个锚点再收一次
        doneRuns.add(anchor);
        out.push({ kind: "run", anchor, text });
      }
      buf = "";
      anchor = null;
    };

    const nodes = container.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3) {
        if (norm(n.data)) {
          buf += n.data;
          anchor = n;
        }
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (SKIP_TAGS.has(n.tagName) || blockLike(n) || !rendered(n)) {
        // 遇到块级、不可翻、或隐藏的元素就断开：
        // 注意 display:none 的元素不算块级，漏掉这个判断会把隐藏内容也收进来
        flush();
        continue;
      }
      const t = norm(n.textContent);
      if (!t) continue;
      // 这个行内元素里已经有更细的翻译单元（例如 <a><h3>标题</h3></a>），
      // 交给那边处理，别再收集一遍，否则同一段文字会被翻两次
      if (hasUnit(n)) continue;
      if (settings.skipNames && isUserNameish(n)) {
        if (peripheral) flush();
        continue;
      }
      // 导航、标签这类容器：每个行内元素单独成段，别把几条挤成一句话一起翻
      if (peripheral) flush();
      buf += " " + t;
      anchor = n;
      if (peripheral) flush();
    }
    flush();
  }

  /* ---------- 2. 调度 ---------- */

  function viewportDistance(el) {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0, bottom: 0 };
    if (r.bottom < 0) return -r.bottom + innerHeight;
    if (r.top > innerHeight) return r.top - innerHeight;
    return 0; // 视口内优先
  }

  const itemNode = (it) => (it.kind === "el" ? it.el : it.anchor.parentElement || it.anchor);

  function enqueue(units) {
    if (!units.length) return;
    const items = units
      .map((it) => ({ it, d: viewportDistance(itemNode(it)) }))
      .sort((a, b) => a.d - b.d);

    for (const { it } of items) {
      const text = it.kind === "el" ? norm(it.el.innerText) : it.text;
      if (!worthTranslating(text)) continue;
      it.text = text;

      const hit = localCache.get(text);
      if (hit) {
        renderUnit(it, hit);
        continue;
      }
      let set = jobs.get(text);
      if (!set) {
        set = new Set();
        jobs.set(text, set);
        queue.push(text);
      }
      set.add(it);
    }
    pump();
    updateBadge();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const text = queue.shift();
      const set = jobs.get(text);
      if (!set || !set.size) continue;
      jobs.delete(text); // 取出即视为在途
      running++;

      const fail = (why) => {
        failures++;
        if (failures === 1) {
          lastError = why;
          console.warn(
            "[双语对照翻译] 翻译请求失败：" + why +
            "\n点扩展图标里的「诊断连接」可以看到每个端点的真实结果。"
          );
        }
      };

      chrome.runtime
        .sendMessage({ type: "bt:translate", text, tl: settings.targetLang })
        .then((res) => {
          if (!res) return fail("后台无响应");
          if (!res.ok) return fail(res.error || "未知错误");
          if (!res.text) return fail("返回空译文");
          localCache.set(text, res.text);
          for (const it of set) {
            const node = itemNode(it);
            if (node && node.isConnected) renderUnit(it, res.text);
          }
          updateBadge();
        })
        .catch((e) => fail(String((e && e.message) || e)))
        .finally(() => {
          running--;
          if (active) pump();
        });
    }
  }

  /* ---------- 3. 渲染 ---------- */

  function makeBlock(el, translated) {
    const div = document.createElement("div");
    div.className = "bt-trans";
    div.setAttribute("dir", "auto");
    div.setAttribute("lang", settings.targetLang);
    div.textContent = translated;

    // 字号向原文靠拢但不喧宾夺主。CSSOM 赋值不受页面 CSP 限制。
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    div.style.fontSize = Math.max(13, Math.min(19, Math.round(fs * 0.88))) + "px";
    return div;
  }

  // 插兄弟节点会让 flex/grid 容器多出一个子项，把布局撑开；
  // 在表格行、列表、下拉里插兄弟节点本身就是非法结构。这些情况改为插到元素内部末尾。
  const INSIDE_PARENTS = new Set(["TR", "TBODY", "THEAD", "TFOOT", "TABLE", "UL", "OL", "DL", "SELECT"]);
  const FLEXY = new Set(["flex", "grid", "inline-flex", "inline-grid"]);

  function place(el, node) {
    const p = el.parentElement;
    if (!p) return false;
    if (INSIDE_PARENTS.has(p.tagName) || FLEXY.has(displayOf(p))) {
      try {
        el.append(node);
        return true;
      } catch (e) {
        return false;
      }
    }
    try {
      el.insertAdjacentElement("afterend", node);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 决定这个块直接显示译文，还是走悬停提示。
  // 判断顺序：外围标签优先（标签、导航这类不该占版面），然后是标题正文，
  // 最后才回退到「短就悬停」的长度规则。
  function decideMode(it) {
    if (settings.shortMode !== "hover") return "inline";
    const target =
      it.kind === "el" ? it.el : it.anchor && it.anchor.nodeType === 1 ? it.anchor : null;
    if (!target) return "inline"; // 悬停要有个能挂事件的元素

    const host = it.kind === "el" ? it.el : it.anchor.parentElement || it.anchor;
    if (peripheralHint(host)) return looksLikeLabel(it.text) ? "hover" : "inline";
    if (it.kind === "el" && contentHint(it.el, it.text)) return "inline";
    return it.text.length <= settings.hoverBelow ? "hover" : "inline";
  }

  function renderUnit(it, translated) {
    if (!translated || !it.text) return;
    if (norm(translated) === it.text) return; // 翻出来和原文一样，没必要重复一遍

    if (it.kind === "run") {
      const a = it.anchor;
      if (!a || !a.isConnected) return;
      // 锚点在收集阶段就已经登记过（doneRuns），这里只负责渲染一次
      // 行内片段只有在锚点是元素时才能挂悬停事件
      if (decideMode(it) === "hover" && a.nodeType === 1) {
        a.dataset.btHover = "1";
        hoverText.set(a, translated);
        return;
      }
      const parent = a.parentElement;
      if (!parent) return;
      try {
        parent.insertBefore(makeBlock(parent, translated), a.nextSibling);
      } catch (e) {
        /* 结构被改过就算了 */
      }
      return;
    }

    const el = it.el;
    if (!el || el.dataset.bt === "1" || !el.isConnected) return;
    el.dataset.bt = "1";

    // 隐式翻译（悬停提示）不只看长短：外围标签类内容即使不短，也不该占版面
    if (decideMode(it) === "hover") {
      el.dataset.btHover = "1";
      hoverText.set(el, translated);
      return;
    }
    place(el, makeBlock(el, translated));
  }

  /* ---------- 3.1 悬停提示 ---------- */

  function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement("div");
    tipEl.className = "bt-tip";
    tipEl.hidden = true;
    (document.body || document.documentElement).append(tipEl);
    return tipEl;
  }

  function showTip(el) {
    const text = hoverText.get(el);
    if (!text) return;
    const tip = ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - w - 8));
    let y = r.bottom + 8;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 8);
    tip.style.left = Math.round(x) + "px";
    tip.style.top = Math.round(y) + "px";
  }

  function hideTip() {
    if (tipEl && !tipEl.hidden) tipEl.hidden = true;
  }

  function onPointerOver(e) {
    const t = e.target;
    const el = t && t.closest ? t.closest("[data-bt-hover]") : null;
    if (el && hoverText.has(el)) showTip(el);
    else if (!t || !t.closest || !t.closest(".bt-tip")) hideTip();
  }

  function onPointerOut(e) {
    const t = e.target;
    if (t && t.closest && t.closest("[data-bt-hover]")) hideTip();
  }

  function countTranslated() {
    return (
      document.querySelectorAll(".bt-trans").length +
      document.querySelectorAll("[data-bt-hover]").length
    );
  }

  function updateBadge() {
    chrome.runtime.sendMessage({ type: "bt:count", count: countTranslated() }).catch(() => {});
  }

  /* ---------- 4. 动态内容 ---------- */

  function scan() {
    if (!active) return;
    unitMemo = new WeakMap();
    hasMemo = new WeakMap();
    blockedMemo = new WeakMap();
    let units = [];
    try {
      units = collect(document.body, []);
    } catch (e) {
      return;
    }
    enqueue(units);
  }

  function onMutations(muts) {
    let relevant = false;
    for (const m of muts) {
      if (m.target && m.target.closest && m.target.closest(".bt-trans")) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.classList && n.classList.contains("bt-trans")) continue;
        relevant = true;
        break;
      }
      if (relevant) break;
    }
    if (!relevant) return; // 纯删除或自己插入的节点，不触发重扫
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE);
  }

  /* ---------- 5. 开关 ---------- */

  function setActive(on) {
    on = !!on;
    if (on === active) return active;
    active = on;

    if (on) {
      failures = 0;
      lastError = "";
      doneRuns = new WeakSet();
      hoverText = new WeakMap();
      document.addEventListener("mouseover", onPointerOver, true);
      document.addEventListener("mouseout", onPointerOut, true);
      document.addEventListener("scroll", hideTip, true);
      sendContext();
      document.documentElement.classList.toggle(
        "bt-only",
        !!settings.onlyTranslated
      );
      scan();
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } else {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(scanTimer);
      jobs.clear();
      queue.length = 0;
      document.removeEventListener("mouseover", onPointerOver, true);
      document.removeEventListener("mouseout", onPointerOut, true);
      document.removeEventListener("scroll", hideTip, true);
      hideTip();
      if (tipEl && tipEl.isConnected) tipEl.remove();
      tipEl = null;
      doneRuns = new WeakSet();
      hoverText = new WeakMap();
      document.querySelectorAll(".bt-trans").forEach((n) => n.remove());
      document
        .querySelectorAll("[data-bt]")
        .forEach((n) => n.removeAttribute("data-bt"));
      document
        .querySelectorAll("[data-bt-hover]")
        .forEach((n) => n.removeAttribute("data-bt-hover"));
      document.documentElement.classList.remove("bt-only");
    }
    updateBadge();
    return active;
  }

  /* ---------- 6. 消息接口 ---------- */

  // 给 LLM 引擎提供页面背景，让它知道自己在翻什么站、什么主题
  function pageContext() {
    const meta = document.querySelector(
      'meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]'
    );
    const h1 = document.querySelector("h1, [role=heading]");
    return {
      host: location.hostname.replace(/^www\./, ""),
      title: norm(document.title).slice(0, 200),
      h1: h1 ? norm(h1.textContent).slice(0, 120) : "",
      description: meta ? (meta.getAttribute("content") || "").slice(0, 300) : "",
    };
  }

  function sendContext() {
    try {
      chrome.runtime.sendMessage({ type: "bt:context", value: pageContext() }).catch(() => {});
    } catch (e) {
      /* 拿不到上下文不影响翻译 */
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "bt:query":
        sendResponse({
          active,
          count: countTranslated(),
          failures,
          lastError,
        });
        return;
      case "bt:toggle":
        sendResponse({ active: setActive(!active) });
        return;
      case "bt:set-active":
        sendResponse({ active: setActive(msg.value) });
        return;
      case "bt:settings":
        Object.assign(settings, msg.value || {});
        if (active) {
          document.documentElement.classList.toggle(
            "bt-only",
            !!settings.onlyTranslated
          );
        }
        sendResponse({ ok: true, settings });
        return;
    }
  });

  /* ---------- 7. 初始化（默认待命，不自动翻译） ---------- */

  chrome.storage.local
    .get("bt:settings")
    .then((r) => {
      const saved = r && r["bt:settings"];
      if (saved) Object.assign(settings, saved);
      if (settings.autoGoogle && active === false) {
        // 仅当用户主动勾选过「自动翻译 Google」时才自动开启
        setActive(true);
      }
    })
    .catch(() => {});
})();
