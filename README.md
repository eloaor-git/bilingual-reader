# 双语对照翻译（Google 搜索页为主）

一个本地使用的 Chrome MV3 扩展：在网页原文块**下方追加译文**，原文保持不动，
点按钮才翻译，再点一次彻底还原。默认只在 Google 搜索页就位，其他网站点按钮时临时注入。

## 项目结构

```
bilingual-reader/
├── LICENSE
├── package.json
├── src/                    扩展本体（加载已解压扩展时选这个目录）
│   ├── manifest.json
│   ├── content.js          选块 + 渲染 + MutationObserver + 开关
│   ├── content.css         译文块样式
│   ├── background.js       翻译请求 + 持久化缓存（Service Worker）
│   ├── popup.html/js/css   工具栏弹窗：翻译按钮、目标语言、选项
│   └── README.md           扩展手册：安装、权限、调参、已知限制
├── tests/                  回归测试
│   ├── test.mjs            jsdom 逻辑回归，直接跑 src/content.js
│   ├── providers.test.mjs  引擎适配层
│   ├── e2e.mjs             Playwright 真实 Chrome 端到端
│   └── check-endpoint.mjs  逐个引擎探测可达性
└── tools/
    └── build.mjs           打包脚本
```

## 安装

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录下的 **`src`** 目录

## 使用

- 工具栏图标 → 「翻译此页」／「还原原文」，角标数字是已翻译块数
- `Alt+T` 快捷键随时开关当前页面
- **标题与正文**：译文直接显示在原文下面
- **外围内容**（分类标签、导航、面包屑、元信息、侧栏这类）：平时不占版面，鼠标移上去才弹出译文气泡。
  判断是看语义不是看长短——分类标签、导航项即使不短也走悬停；反过来，正文里的长段落不会因为"短"就变成悬停
- **用户名 / 作者名不翻译**（弹窗里可关）：识别 `rel=author`、`itemprop=author`、类名里的
  `username`/`byline`、`@handle`、"by xxx" 以及指向 `/user/`、`/profile/` 这类用户页的链接
- 弹窗里还能切目标语言、勾选「Google 搜索页自动翻译」和「只看译文」

## 开发

```powershell
cd tests; npm install     # 首次（jsdom + playwright-core）
cd ..
npm test                  # 全部 147 项：逻辑回归 + 引擎适配层 + 真实 Chrome 端到端
npm run test:unit         # 只跑前两个（秒级）
npm run check:endpoint    # 逐个引擎探测可达性
```

改完 `src/` 里的文件，在 `chrome://extensions/` 点扩展卡片上的刷新按钮，再刷新网页即可生效。

## 打包分发给测试者

```powershell
npm run build
```

产出 `dist/bilingual-reader-v<版本>.zip`，里面是一层 `bilingual-reader-v<版本>/` 目录
加一份给测试者看的 `安装说明.txt`。直接把这个 zip 转发出去即可，对方解压后按说明
「加载已解压的扩展程序」选中那个目录就行（测试包不含测试、文档和 node_modules）。

打包脚本会打印 sha256，转发时可以连它一起发，方便对方核对完整性。

## 翻译引擎

默认用 **MyMemory**：免注册、免密钥、国内可直连，装完就能翻。想更好用就换一个：

| 引擎 | 需要什么 | 说明 |
|---|---|---|
| MyMemory | 无（填邮箱可 5000→50000 词/天） | 默认。零配置，质量中等 |
| 百度翻译开放平台 | APP ID + 密钥 | 国内最快，标准版 5 万字符/月免费 |
| 彩云小译 | Token | 国内快，免费额度适合个人 |
| DeepL | Auth Key | 质量最好，需要能连 api.deepl.com |
| OpenAI 兼容接口 | 地址 + Key + 模型名 | DeepSeek / 通义 / Ollama。**整页一次请求**，会带页面背景，术语一致 |
| Google 翻译 | 无 | 网络能到 Google 时质量速度都不错 |

切换方式：点扩展图标 → 「翻译引擎」下拉 → 填好凭证 → 点「**保存并测试**」。
这一步会真的打一次网络并报告结果，例如：

```
当前引擎：MyMemory（免费，免注册）
[ok] mymemory  721ms  →  你好世界
```

失败会直接显示原因（`HTTP 429` / `请求超时` / `响应无法解析`），不用猜。

### OpenAI 兼容接口

选这个引擎时整页只发一次请求：域名、页面标题、主标题、页面摘要会一起进提示词，模型据此判断
页面语境（模组页、维基条目、论坛帖），译名前后一致。提示词里写死了风格约束——只输出译文、
作品名用通行译法、代码与 URL 原样保留。批量返回做数量、编号与非空校验，不合规就退回逐条翻译，
不会把模型的错误输出贴到页面上。

### 默认引擎

Google 的端点在部分网络下不可达（`translate.googleapis.com` 属 googleapis.com 域，
`translate.google.com` 也常被规则漏掉），所以默认用 MyMemory：免注册、免密钥、国内可直连。
Google 的三个候选域名仍保留在引擎列表里，依次尝试。

### 长文本与失败处理

- MyMemory / 彩云 / DeepL 有单次长度上限，超长段落会自动按句切分再拼接
- 全线失败后熔断 20 秒，避免整页每块文本都白等一轮；点一次「保存并测试」即解除
- 缓存按引擎隔离，换引擎不会把上一个引擎的译文端上来
