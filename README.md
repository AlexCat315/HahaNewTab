# HahaNewTab - 新标签页导航

一个基于 **Material Design 3** 设计的纯前端新标签页导航应用，同时也是一个 **Chrome / Firefox 浏览器扩展（Manifest V3）**。它提供统一的应用导航中心，用于管理和快速访问各类开发者工具、外部链接和自定义网站。
![HahaNewTab](./public/image/logo/logo_girl-256.png)

---

## ✨ 功能特性

- **应用导航**：分类展示工具应用和外部链接，支持自定义分类、添加/编辑/删除网站
- **拖拽排序**：长按应用卡片即可拖拽排序，支持同分类排序和跨分类移动
- **隐藏站点**：支持隐藏不常用的站点，双击左上角 Logo 快速切换显示/隐藏
- **全局搜索**：集成 16 个搜索引擎，快捷键 `Ctrl+K` / `Cmd+K` 唤起，支持关键词补全
- **个性化主题**：12 套主题配色，每套都有「明亮 / 深色」两种变体（共 24 个），可单独切换明暗或跟随系统深色偏好
- **壁纸背景**：支持自定义壁纸 URL 或本地图片上传，可调节透明度、模糊度、遮罩
- **数据管理**：应用/分类的增删改查，数据导入/导出（JSON 格式备份）
- **UI 图标库**：约 48 个系统 SVG 图标 + 用户自定义图标管理；系统图标用 CSS mask 渲染，颜色跟随当前主题（含 `color` 覆盖），深色模式下不再有黑图标
- **云同步**：GitHub OAuth 一键授权登录，数据存进你自己的私密 Gist，支持多端双向增量合并（冲突本地优先）
- **跳转方式可选**：点击站点卡片 / 搜索时可选择「新标签页」或「覆盖当前页」，在个性化 → 页面布局里切换
- **本地媒体缓存**：站点图标与网络壁纸缓存进 IndexedDB（图标 7 天 / 壁纸 30 天），二次打开不再发请求；可在个性化 → 缓存里开关与清理

---

## 🚀 运行方式

### 方式一：作为网页版运行

```bash
# 安装开发依赖
npm install

# 启动开发服务器
npm run dev
# 然后访问 http://localhost:5173
```

网页版使用 `localStorage` 存储数据。

### 方式二：作为 Chrome 扩展运行

```bash
npm run build:chromium
# 此时 dist-chrome/ 目录即为 Chromium 扩展加载目录
```

1. 打开 Chrome 扩展管理页：`chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `./build-chromium.sh` 生成的 `build-chromium/` 目录（或 `npm run build:chromium` 生成的 `dist-chrome/`）
5. 打开新标签页即可看到 HahaNewTab

扩展版使用 `chrome.storage.local` 存储数据。

### 方式三：作为 Firefox 扩展运行

```bash
./build-firefox.sh
```

1. 打开 Firefox 扩展调试页：`about:debugging`
2. 点击「临时载入附加组件」
3. 选择 `build-firefox/manifest.json`
4. `js/background-firefox.js` 会自动处理启动时首个标签页的重定向

---

## 📁 项目结构

```
HahaNewTab/
├── index.html                  # 主入口（网页版 & 扩展新标签页）
├── view/
│   └── popup.html              # 扩展弹出窗口入口
├── manifest.json               # Chrome / Chromium Manifest V3（logo_girl 图标）
├── manifest.edge.json          # Microsoft Edge Manifest V3（logo_girl 图标，全浏览器统一）
├── manifest.firefox.json       # Firefox Manifest V3
├── public/                     # 静态资源（构建时原样复制到产物目录）
│   ├── config/                 # JSON 配置：主题、搜索引擎、默认数据
│   └── image/                  # 图标与 Logo
├── src/                        # Vue3 + TypeScript 源码
│   ├── App.vue                 # 新标签页根组件
│   ├── PopupApp.vue            # 弹出窗口根组件
│   ├── main.ts                 # 新标签页入口
│   ├── popup.ts                # 弹出窗口入口
│   ├── background.ts           # Firefox 后台脚本
│   ├── components/             # Vue 组件
│   ├── composables/            # 组合式函数
│   ├── services/               # 业务服务（BrowserAPI、Storage、Config、CloudSync 等）
│   ├── stores/                 # Pinia 状态管理
│   ├── styles/                 # SCSS 全局样式
│   ├── types/                  # TypeScript 类型定义
│   └── utils/                  # 工具函数
├── build-chromium.sh           # Chromium 扩展构建脚本
├── build-firefox.sh            # Firefox 扩展构建脚本
├── sign-firefox.sh             # 扩展打包/签名脚本（同时生成 Chromium .zip 与 Firefox .xpi/.zip）
├── scripts/
│   ├── postbuild.js            # 构建后根据目标生成 <产物目录>/manifest.json
│   ├── gen-themes.mjs          # 由 theme-seeds.json 生成 themes.json + 结构/对比度体检（--check 查漂移）
│   └── audit-styles.mjs        # 样式护栏：统计组件与 composables 里绕过 token 的写法
├── public/config/
│   └── theme-seeds.json        # 主题唯一的手写来源：12 族 × 明/暗调色板
├── package.json
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
└── README.md
```

---

## 🛠️ 开发说明

### 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript |
| 状态管理 | Pinia |
| 构建工具 | Vite |
| UI 设计 | Material Design 3 |
| 样式 | SCSS + CSS 变量 |
| 存储 | localStorage / chrome.storage.local / browser.storage.local |
| 扩展 API | Chrome / Firefox Manifest V3 |
| 测试 | Vitest + jsdom + @vue/test-utils |

### 常用命令

```bash
# 安装依赖
npm install

# 开发服务器
npm run dev

# 类型检查 + 生产构建
npm run build

# 预览生产构建
npm run preview

# 运行测试（监听模式）
npm run test

# 运行测试（单次）
npx vitest run

# 单独类型检查
npx vue-tsc --noEmit

# 样式护栏：列出组件与 composables 里绕过 token 的写法（加 --fail 给 CI 用）
npm run audit:styles

# 由 seeds 重新生成主题，并做结构/对比度体检
npm run themes:gen

# 只体检：不改文件，并检查 themes.json 是否落后于 seeds
npm run themes:check
```

### 主题与样式 token

调色板只手写在一处：[public/config/theme-seeds.json](public/config/theme-seeds.json)（12 个主题族，每族明亮 / 深色两套 23 色）。
改这里，然后 `npm run themes:gen` 生成 [public/config/themes.json](public/config/themes.json)——运行时加载的是后者，
它由脚本拼装（`id`/`family`/`mode`/`legacyIds`/默认主题），不要手改。

生成脚本只做三件事，且是**幂等**的：只读 seeds、绝不回读 themes.json（所以重复运行不会越改越歪）；
seeds 里缺哪一半才按 Material 明暗对称派生哪一半，已给的手写值原样保留；对比度不达标时只报错、不写文件。
阈值比 WCAG 正文标准松一档，因为这套主题始终浮在半透明表面与壁纸上，具体数字与理由写在脚本的 `THRESHOLDS`。

组件侧的约束由 `npm run audit:styles` 守着：颜色走 `var(--card-bg)` / `var(--glass-bg-*)` / `var(--tint-*)`，
几何走 `var(--space-*)` / `var(--radius-*)` / `var(--card-*)` / `var(--z-*)`，明暗差异交给暗色变体主题而不是
组件里再写一套 `.dark-mode`。确实必须脱离 token 时（例如壁纸层要 `z-index:-1`），在那一行加 `token-allow` 注释并写明原因。

### 构建产物结构

执行 `npm run build:chromium` / `npm run build:edge` / `npm run build:firefox` 后，产物分别位于
`dist-chrome/`、`dist-edge/`、`dist-firefox/`，目录结构如下：

```
dist-chrome/   # Chrome / Chromium
dist-edge/     # Microsoft Edge（图标统一为 logo_girl）
dist-firefox/  # Firefox
├── index.html
├── view/
│   └── popup.html
├── manifest.json               # 由 scripts/postbuild.js 根据目标生成
├── js/
│   ├── main-*.js
│   ├── popup-*.js
│   ├── global-*.js
│   ├── background-firefox.js   # Firefox 后台脚本（仅 Firefox 包使用）
│   └── *.css
├── config/
│   ├── themes.json
│   ├── searchEngines.json
│   └── defaultData.json
└── image/
    ├── icons/
    └── logo/
```

---

## 💾 数据备份与恢复

1. 点击页面右下角「个性化」按钮
2. 在设置面板中找到「数据管理」
3. 支持导出当前配置为 JSON 文件，或导入已有的 JSON 备份

**注意**：数据结构、存储键名与旧版原生实现保持一致，旧版数据可直接导入。

---

## ☁️ 云同步（GitHub OAuth）

云同步面板（右下角菜单 → 云同步）里点「使用 GitHub 登录」，扩展会自动打开 GitHub 授权页，
并把授权码复制到剪贴板；粘贴、确认一次即完成连接。**使用者不需要申请 Token，也不需要填写任何配置。**
凭据由 GitHub 下发并保存在本机扩展存储中，数据写进自己账号下的**私密 Gist**。

### 项目维护者：内置 Client ID（一次性）

GitHub 规定任何第三方登录都要对应一个注册过的 OAuth App，因此扩展需要一个 **Client ID**
（公开标识，不是密钥）。这一步由**项目维护者做一次并内置在扩展里**，使用者完全无感：

打开 <https://github.com/settings/developers> →「New OAuth App」，按下表填写：

| 字段 | 填什么 | 说明 |
|------|--------|------|
| Application name | `HahaNewTab` | 授权页上显示的名字，自己认得出即可 |
| Homepage URL | `https://github.com/AlexCat315/HahaNewTab` | 与 `manifest.json` 的 `homepage_url` 一致 |
| Application description | `HahaNewTab 新标签页的云同步，用于读写你自己的私密 Gist` | 授权时会展示给使用者 |
| Redirect URIs | `https://github.com/AlexCat315/HahaNewTab` | Device Flow 不走回调，随便填一个你控制的合法 URL；能留空就留空 |
| Allow wildcard matching | **不勾** | 用不到，勾了只会扩大风险 |
| Enable Device Flow | **勾上** | 必选，没勾会报 `device_flow_disabled` |
| Expire user access tokens | **不勾** | 勾了 token 8 小时过期并需要刷新令牌，当前扩展未实现刷新，会变成每隔几小时就要重新授权 |

提交后复制页面上的 **Client ID**，填进
`src/services/cloudSync/oauthConfig.ts` 的 `BUILT_IN_CLIENT_ID`。本项目已经填好，
普通构建无需再动；只有自建实例才需要在构建时覆盖：

```bash
VITE_GITHUB_CLIENT_ID=<你的 Client ID> npm run build
```

**Client secret 不需要**：Device Flow 不用它，也不要把它放进前端代码。若注册时忘了勾
Device Flow，可到应用设置页补勾。

Device Flow 不需要 client secret，所以扩展里只有公开的 Client ID：没有密钥、没有后端、没有回调页。
GitHub 的标准 Web 跳转流程在换取 token 时强制要求 `client_secret`，纯前端扩展无法安全保存，
因此这里采用 Device Flow。扩展只申请 `gist` scope，不接触账号密码，也不参与浏览器账号同步区。

### 多设备

每台设备首次打开面板点一次「使用 GitHub 登录」完成授权，之后凭据一直保存在该设备的扩展存储里；
站点数据仍通过 Gist 做双向增量合并（冲突本地优先）。新设备授权完成后点一次「立即同步」，
或开启「自动同步」让后续每次启动自动拉取合并。凭据被撤销或过期时，平台返回 401，
本机凭据会被清掉，重新授权一次即可。

> Gitee 已停用。旧版本留下的平台标记会在启动时清理，旧的 Gitee Token 在校验失败后自动失效，
> 需要改用 GitHub 授权重新连接。

---

## 📦 浏览器扩展打包

项目提供 `sign-firefox.sh` 脚本，一次运行即可同时打包 Chromium（Chrome / Edge）与 Firefox 扩展。

1. 安装全局依赖：
   ```bash
   npm install -g web-ext
   ```
2. （可选）设置 Firefox API 密钥环境变量 `WEB_EXT_API_KEY` 与 `WEB_EXT_API_SECRET`
3. 执行 `./sign-firefox.sh`

生成文件：

- `dist/haha_newtab-chromium.zip`：Chrome / Edge 商店提交包 / 开发者模式加载包
- `dist/hahanewtab-*.xpi`：Firefox 已签名安装包（需设置 API 密钥）
- `dist/hahanewtab-*.zip`：Firefox 未签名包（未设置密钥时生成，用于临时加载测试）

---

## 🚀 自动发版与 Firefox 自动更新

推一个 tag 就能完成「构建 → 签名 → 发布 → 生成更新清单」，不需要本地打包。

### 发版

```bash
./scripts/release.sh          # 版本号自动 +1（基于最新 tag / manifest），
                              # 例如 1.0.0.110 → 1.0.0.111，1.0.1.0 → 1.0.1.1
./scripts/release.sh 1.0.2.0  # 或指定版本号（必须大于已发布的最新版本）
```

版本号以 git tag 与 manifest 为准，由 `scripts/resolve-version.js` 统一解析，
不再使用可被意外清零的 `.build-num`。

脚本会写入三份 manifest（Chrome / Edge / Firefox）的版本号、提交、打 `v<版本>` tag 并推送。随后
`.github/workflows/release.yml` 自动执行：

1. `npm ci` + 构建 Firefox / Chromium 两个产物
2. `web-ext sign --channel unlisted` 调用 AMO 签名 Firefox 包
3. 打包 Chromium zip
4. 生成 `updates.json`（Firefox 更新清单，含 sha256 校验）与 `latest.json`（应用内更新检查用）
5. 创建 GitHub Release，附上四个文件

推送失败（网络抖动、`SSL_ERROR_SYSCALL` 等）时提交和 tag 已经在本地建好，
**直接重新运行 `./scripts/release.sh` 即可**：脚本会检测到 HEAD 上未推送的 tag，
跳过版本递增只做补推，不会白白消耗一个版本号。

### 首次配置（只需一次）

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 值 |
| --- | --- |
| `WEB_EXT_API_KEY` | AMO 的 JWT issuer，形如 `user:12345:67` |
| `WEB_EXT_API_SECRET` | AMO 的 JWT secret |

> 仓库首次启用 Actions 时，需要在 Actions 页面点一次「I understand my workflows, go ahead and enable them」。

### Firefox 自动更新是怎么生效的

`manifest.firefox.json` 里声明了：

```json
"browser_specific_settings": {
  "gecko": {
    "id": "{8f0e09af-c367-46bf-bab8-fc88cbc885c1}",
    "update_url": "https://github.com/AlexCat315/HahaNewTab/releases/latest/download/updates.json"
  }
}
```

Firefox 每 24 小时（`extensions.update.interval`，默认 86400 秒）拉取该 `updates.json`，
发现 `version` 高于已安装版本就静默下载并安装。

### Chrome / Edge 为什么没有自动更新

Chrome 和 Edge 只对**商店分发**的扩展做自动更新，自托管的包（开发者模式加载、拖入 zip）
永远不会自己升级——`update_url` 在 Chromium 系只有 Linux 或企业策略托管环境才生效。
Firefox 是唯一支持「自托管 + 自动更新」的浏览器。

所以 Chromium 侧退一步做**应用内更新提示**：`useUpdateCheck` 定时读
`releases/latest/download/latest.json`，比对扩展自身 manifest 版本，有新版本时在左下角
显示提示条，点「立即更新」直接下载对应安装包。

- 数据源优先用静态清单 `latest.json`，GitHub REST API 只作兜底
  （未认证接口限 60 次/小时/IP，共享出口容易被刷满）
- 检查结果缓存 6 小时，避免每开一个新标签页都发请求
- 忽略某个版本后不再提示，下一个版本发布后会重新提示
- 网络异常、限流一律静默失败，不会打扰用户

几个必须遵守的约束：

- **扩展 ID 必须固定**（`{8f0e09af-c367-46bf-bab8-fc88cbc885c1}`）。改 ID 等于换了一个扩展，老用户收不到更新。
  早先用的是 `cyke0315@163.com`，那个 AMO 条目被删除后 ID 永久占坑、再也签不出名，
  所以换成了上面这个 UUID；**AMO 上删除扩展是不可逆的，不要删**。
  同一份 ID 还写在 [scripts/make-updates-json.js](scripts/make-updates-json.js) 的 `DEFAULT_ADDON_ID`，
  改 ID 必须两处一起改，否则 `updates.json` 的键和 manifest 对不上，自动更新直接失效。
- **版本号不能重复提交**。AMO 对同一版本只接受一次上传，重复会报
  `This upload has already been submitted`，必须升版本号重试。
- **`update_url` 一旦发布就尽量不要改**。已安装的扩展只会用自己 manifest 里写死的
  `update_url` 检查更新，改地址会导致老用户永远收不到更新（只能靠企业策略兜底）。
- **必须经 AMO 签名**。正式版 Firefox 只安装已签名的扩展，未签名的只能在
  Developer Edition / Nightly 里关掉 `xpinstall.signatures.required` 后使用。

### 更新通道必须与本仓库绑定（重要）

本项目是从 `MugenNewTab` 独立出来的新项目，两条更新通道必须彻底隔开，
否则装了旧版 MugenNewTab 的用户会被静默升级成本插件：

- 老插件的 `update_url` 写死指向它自己安装时那份 manifest 里的地址，
  所以 **本项目的 Release、`updates.json`、`latest.json` 只能发到本仓库**，
  绝对不要往旧仓库传任何版本。
- **不要把旧仓库改名成本仓库的名字**：GitHub 会对改名做重定向，
  旧地址 `.../MugenNewTab/releases/latest/download/updates.json` 会解析到新仓库，
  而 `updates.json` 里的 addon id 仍是同一个，Firefox 就会把新插件当成老插件的更新静默装上。
  要停掉旧插件的更新通道，正确做法是删除旧仓库（地址 404，Firefox 静默跳过，不会提示更新）。
- 本插件读取的更新地址由两处常量决定，迁移仓库时必须同步改掉：
  `manifest.firefox.json` 的 `browser_specific_settings.gecko.update_url`（Firefox 静默自动更新）
  与 `src/composables/useUpdateCheck.ts` 的 `RELEASE_REPO`（Chrome / Edge 应用内提示）。

### 安装方式

Firefox 桌面版：下载 Release 里的 `.xpi`，拖进 `about:addons` 页面，或直接用 Firefox 打开该文件。

> GitHub Releases 返回的 `Content-Type` 是 `application/octet-stream` 而非
> `application/x-xpinstall`，所以点链接不会自动触发安装，需要手动拖入或打开文件。
> 更新过程走 Firefox 自己的更新通道，不受这个限制影响。

### 本地调试更新

```bash
# about:config 里把检查间隔改短（最小 120 秒）
extensions.update.interval = 120
# 确认开关是打开的
extensions.update.enabled = true
```

然后打开「工具 → 浏览器工具 → 浏览器控制台」，按扩展名过滤即可看到更新请求日志。

---

## 🧪 测试

项目使用 Vitest 进行单元测试，覆盖 services、stores、composables 与 components。

```bash
# 运行全部测试
npx vitest run
```

核心存储契约测试位于 `src/services/__tests__/storage.legacy.test.ts`，保留自旧版 `tests/storage.test.js` 的 5 个核心契约：

- 写操作返回前已经持久化
- 修改前重新读取最新快照，避免旧缓存覆盖外部更新
- 存储失败会拒绝操作并回滚内存缓存
- 分类局部排序不会删除未出现在排序列表中的分类
- 旧数据缺少「全部应用」分类时会无损补齐

---

## 📄 许可证

本项目基于 MIT 许可证发布，详见 [LICENSE](./LICENSE)。

代码源自 MugenNewTab（MIT License, Copyright (c) 2026 Mieriki）并在此之上独立演进；
MIT 要求保留原始版权声明与许可文本，因此 LICENSE 中的上游版权声明继续保留。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。开发前请运行 `npm run build` 与 `npx vitest run` 确保构建与测试通过。
