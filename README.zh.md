# DSH Desktop（官方 runtime）

一个**薄 Electron 外壳**，把官方安装的 DeepSeek Harness 包成一个 Windows 桌面应用：双击图标 → 后台拉起官方 `dsh --profile web` 服务 → 在带沉浸式标题栏的独立窗口里打开 Web UI → 托盘图标可显示窗口或退出。

**不使用**社区版的 vendored / patched runtime，也不 fork 任何 DSH 代码：外壳只负责找官方 CLI、启动它、把它显示出来。官方包一升级，桌面应用跟着升级。

## 沉浸式标题栏（两个视图）

标题栏**不是**往官方页面里注入 CSS，也不是 Cordis 插件——它是同一个窗口里的**第二个 `WebContentsView`**（与社区版 DSH Desktop 的兼容模式同一做法）：

```
BrowserWindow（自身文档从不加载，只当容器）
└─ contentView
   ├─ content view   {x:0, y:36, w, h-36}   ← 官方 DSH 页面，原样不动
   └─ chrome view    {x:0, y:0,  w, 36}     ← 本项目的 chrome.html
```

- 官方布局**一个字节都不改**：它只是从 36px 之下开始，滚动容器、slot、主题全都照常。
- 谁画在上面由 `addChildView` 的**顺序**决定（先 content 后 chrome），不是 z-index。
- 窗口参数：`titleBarStyle:'hidden'` + `titleBarOverlay:{color:'#00000000', symbolColor:'#7f858f', height:36}`，即**系统最小化/最大化/关闭按钮保留**，只是标题栏区域交给我们。帧左侧留出 138+8px 给这些原生按钮。
- **不要 `backgroundMaterial`**：Mica 需要 Windows 11（NT build 22621+），在 Windows 10 上是空操作，所以这里保持不透明背景。
- 帧上**没有按钮**：重载 / 在浏览器打开 / 开发者工具都在托盘菜单里，36px 的带子里再放一份没有价值。
- **侧边栏的颜色延续到标题栏**：帧的左侧一条 `--sidebar-width` 宽的色带用 `--sidebar-fill` 填充，连右边框一起带上，所以侧边栏和标题栏在视觉上是一整块。数据全部取自活页面：
  - 颜色来自官方 token `--dsw-specific-sidebar-fill`，它的描述本身就是"Sidebar column and title-row background"——官方设计本来就打算这么用；
  - 宽度靠"谁的底色等于这个 token 且贴左、高度过半"来定位，**不依赖类名**（类名是带哈希的，如 `pI_x6G_sidebarCol`，每次构建都变）。
- 帧颜色**取样自官方页面的真实背景**（按亮度判定明暗），所以明暗切换时不会出现"浅色页面配深色标题栏"的接缝。每 2 秒重新取样一次，侧边栏折叠/展开也会跟上。
- 帧文档用 `loadFile()` 加载，IPC 处理器把发送方 URL 钉死在该文件路径上：换成 http 或加 query 会**静默失效**（命令全部 fail closed）。`--dsh-probe-ui` 会实测这一点。

## 它怎么找到"官方 harness"

按顺序探测，取第一个存在的：

1. 设置文件里的 `dshBin`
2. 环境变量 `DSH_DESKTOP_DSH_BIN`
3. 本工程 `node_modules/@deepseek-ai/dsh/lib/bin.js`
4. npm 全局：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
5. npx 缓存：`%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js`（取最新）
6. PATH 上的 `dsh` shim，反解出真实的 `lib/bin.js`

Node 运行时同理（`DSH_DESKTOP_NODE` / PATH 上的 `node` / 常见安装路径）。**服务跑在系统 Node 上，不跑在 Electron 的 ABI 里**，所以 `node-pty`、`sharp` 这类原生依赖不会有 ABI 不匹配问题。

## 服务生命周期

**外壳始终自己拥有服务进程，不接管别人的。** 这不是偏好，是必须的：DSH 用一次性 launch token 保护 Web 界面，服务启动时只在**自己进程的 stdout** 上打印一行

```
dsh web: http://127.0.0.1:3080/?token=<一次性 token>
```

只有用这个 URL 访问一次，服务才会 303 重定向并种下签名 cookie；直接开裸 `/` 会拿到 `401 dsh web authentication required`（一段默认黑字的纯文本，落在深色背景上就是"黑屏"）。别人的服务进程读不到它的 stdout，也就永远拿不到 token。

所以外壳会：隐藏窗口拉起 `dsh --profile web --no-open --port <端口>` → 把 stdout 写进日志 → 从日志里解析出带 token 的 URL → 用这个 URL 加载窗口。token 每次启动都不同，所以**每次启动都必须由外壳自己拉起服务**。

- 默认用 `3080`；端口被占用（比如你终端里另开了一个 `dsh web`）就自动换一个空闲端口。
- 关窗口 = 收进托盘，服务继续跑（会话/后台任务不会断）。
- 服务是 detached 启动的，**应用退出后它仍在后台跑**（已实测），下次启动秒开。
- **不会重复启动**：启动时先把上次的 `server.json`（端口 + 进程号 + 带 token 的 URL）读出来，用那个 URL 探一下——服务还活着且 token 仍有效（返回 303）就直接**复用**，不再起第二个；探不通说明记录已失效，才拉起新的。
- **插件市场不许自重启**：`dshmarket` 的"重启"是先起一个同参数的替换进程、500ms 后再 SIGTERM 自杀（`dshmarket/lib/restart.js`）。在外壳下这会多出一个服务，还让外壳失去对进程的掌控。市场自己的路由就有开关：`allowRestart: false` 会得到 403（`dshmarket/lib/routes.js`），而这正是它文档里给"由 supervisor 托管"的宿主准备的答案。
  - 外壳在**每次拉起服务之前**都把它断言成 `false`——写 `~/.dsh/settings.yaml` 的 `dsh-market.allowRestart`，写前留一份 `settings.yaml.dsh-desktop-backup`，且只在值不同时才落盘。之所以不是"只写一次"：新机器、删掉设置文件、重装插件之后，断言必须仍然成立。
  - **重启改由外壳负责**：标题栏右侧、紧贴系统三键左边有一个重启键（46×36，与系统三键同框、同符号色）。
  - 托盘的「**允许插件市场自重启**」是唯一的放行口，**仅在检测到 `dshmarket` 时才出现**；勾上会写回 `true`，并提示重启后生效。
- 应用本身也有单实例锁：重复双击只会把已有窗口唤到前台。
- 托盘菜单：
  - 显示 / 隐藏窗口、重新加载界面、在浏览器中打开、复制服务地址、重启 DSH 服务
  - **退出（保留后台服务）** —— 只关应用，服务常驻，下次秒开
  - **退出并停止服务** —— 连服务进程树一起 `taskkill`
  - 开机自启（默认关闭，需手动勾选）
- 单实例锁：重复启动只会把已有窗口唤到前台。
- **关窗口 ≠ 退出**：X 按钮是把窗口收进托盘（这是服务常驻的前提），每次收进托盘都会弹一次提示。要真正退出，用托盘菜单，或者不依赖托盘的方式：

  ```powershell
  DSH.exe --dsh-quit     # 让正在运行的实例退出并停止服务
  ```

  `--dsh-quit` 靠单实例锁把请求投递给已运行的实例。如果你当初是用自定义 `--user-data-dir` 启动的，这条命令要带上同一个 `--user-data-dir`（锁是按 userData 分的）；默认启动方式则不用带。

## 开发态运行

```powershell
npm install
npm start
```

## 打包

```powershell
npm run dist:dir   # 只产出解包目录 dist\win-unpacked\DSH.exe（快，够用）
npm run dist       # 产出 NSIS 安装包 + 便携版单文件（安装包会自动建桌面/开始菜单快捷方式）
```

若 Electron 二进制或 electron-builder 的辅助程序下载卡住（默认走 GitHub），换镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install
```

## 出问题时怎么查

外壳把窗口做的一切都写进 `%APPDATA%\DSH\logs\app.log`：每次导航、`did-fail-load`、渲染进程崩溃、页面 console 报错、以及**加载完成后页面正文的前 200 字**。黑屏时先看这个文件。

两个无界面自检入口（不开窗口，写 JSON 报告后退出）：

```powershell
# 只验证 runtime 定位 + 服务启动（不碰界面）
DSH.exe --dsh-selftest=report.json

# 开真窗口，等页面稳定后报告渲染结果（标题/元素数/正文）
DSH.exe --dsh-probe-ui=report.json

# 制造一次启动失败，驱动恢复界面（按钮、标红、禁用/启用）并报告
DSH.exe --dsh-probe-recovery=report.json
```

开发态同样可用：`node_modules\.bin\electron . --dsh-probe-ui=report.json`。
另有 `node scripts/selftest.js` 用于不依赖 Electron 地检查 runtime 定位与端口，
以及 `electron scripts/tray-check.js` 用于确认托盘图标能否解码——图标解码失败或尺寸不对会让
托盘不可见，而窗口关掉之后托盘是唯一的交互入口。

托盘图标在 Windows 上会被显式缩到 16×16 再交给系统：Electron 会按屏幕缩放系数放大 `.ico`
（32px 的条目实测被报成 256×256），过大的托盘图标在部分 Windows 配置下会渲染成空白。

## 启动失败时的恢复

服务起不来时窗口显示的是**失败页**（不是空白），日志下面按钮居中：

| 按钮 | 作用 |
| --- | --- |
| **重启 DSH 服务** | 停掉当前服务、重新拉起一次 |
| **打开插件列表** | 列出 profile 里的插件，**日志点到的可疑对象标红**，逐行可禁用/启用 |

插件列表页底部的按钮是 **返回 / 打开日志 / 打开 profile 目录**。「返回」只回到失败页，**不会顺手重启**——要重启请回失败页点那个按钮，这样你能先改完别的再说。

**什么时候不显示「打开插件列表」**：两种情形——profile 里**没有第三方插件**（只有官方 bundle，没什么可禁用的），或者 profile 的 `package.json` **根本读不出来**。这两种情况失败页都只显示「重启 DSH 服务」，并写明原因。一个按下去只会打开空列表、或注定失败的按钮，比没有按钮更糟。

**不需要 dshmarket**：插件清单直接来自 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`），market 装没装都一样。实测过：把 manifest 换成完全没有 `dshmarket` 的版本，列表照常列出并可禁用。

「禁用」是从 `dsh.profile.bundles` 里摘掉这个名字、**依赖仍然装着**，所以可逆（同一行可再启用），不需要 pnpm，也不需要联网。

可疑对象怎么判定的：解析服务日志里的

```
failed to import loader entry neu-theme (dsh-neu-theme): ...
```

entry id 和包名都取；另外把"出现在含 error/failed 的行里的已知包名"也算上。loader 自己的 `include (cordis:include)` 会被滤掉——那是机制，不是插件。

**为什么不能直接调用 dshmarket 的禁用功能**：profile 起不来的时候 market 自己也起不来。它的源码里就写了这句话（`dshmarket/lib/install.js`：*"the whole profile, not just this plugin, refuses to start, with the market's own page unreachable"*）。所以这里做的是**照抄它的做法**——`dshmarket/lib/profile.js` 的 `removeProfileBundle` / `addProfileBundle` 本质就是对这个数组做一次过滤/追加，本项目的 `src/dsh-profile.js` 实现了同样的逻辑，含同款原子写回（写临时文件再 rename，崩溃也不会把 manifest 截断）。

**隔离**：恢复按钮的桥（`src/content-preload.js`）只在**外壳自己的 `data:` 页面**上暴露。官方 DSH 页面虽然共用同一个视图，但拿不到它——`--dsh-probe-ui` 会断言 `hasRecoveryBridge === false`。主进程侧再校验一次：发送方必须是页面视图，且文档必须是 `data:`。

## 图标

`assets/` 下的 `icon.ico` / `icon.png` / `tray.ico` / `tray.png` 由脚本从**官方** `@deepseek-ai/dsh-web-frontend/dist/favicon.svg` 生成：

```powershell
npm run icons
```

脚本需要 `sharp`（只在这一步用到，产物已随仓库提交，应用本身不依赖它）。

## 设置

`%APPDATA%\DSH\settings.json`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` / `host` | `3080` / `127.0.0.1` | 首选监听地址；端口被占用时**本次**改用空闲端口，设置里的值不变 |
| `dshBin` | `""` | 显式指定官方 CLI 入口（`lib/bin.js`） |
| `nodeBin` | `""` | 显式指定 Node 可执行文件 |
| `workspace` | `""` | 拉起服务时的工作目录（决定默认 workspace） |
| `closeToTray` | `true` | 关窗口收进托盘 |
| `startMinimized` | `false` | 启动时不显示窗口 |
| `openAtLogin` | `false` | 开机自启（托盘菜单可切换） |

日志（`%APPDATA%\DSH\logs\`）：

| 文件 | 内容 |
| --- | --- |
| `app.log` | 窗口加载、页面报错、渲染进程崩溃、页面正文摘要 |
| `dsh-server.log` | 服务进程本次启动的完整 stdout/stderr，含带 token 的 URL 行 |

## 来源与参考（重要）

本工程**没有复制任何第三方源码**。它是纯 JavaScript 手写的；外部知识只用于理解机制，然后在自己的代码里重新实现，并在注释里标了出处（可用 `grep -r dshmarket src` 核对）。

| 参考对象 | 参考了什么 | 对应本工程的实现 |
| --- | --- | --- |
| 社区版 DSH Desktop（`deepseek-harness-desktop`，MIT） | 兼容模式的双 `WebContentsView` 布局、36px 帧、`addChildView` 顺序、Window 参数、preload 只暴露一个桥、拖拽区与平台留白、Mica 的版本门槛 | `src/shell-views.js`、`src/window-chrome.js`、`src/chrome-preload.js`、`src/chrome.css` |
| `dshmarket`（插件市场，装在 profile 里） | `removeProfileBundle`/`addProfileBundle` 的软禁用做法、`INBOX_BUNDLES` 名单、"坏 bundle 会让整个 profile 起不来"的结论、`allowRestart` 的语义与 403 守卫 | `src/dsh-profile.js`、`src/dsh-settings.js` |

**明确没有搬的**（这些正是社区版里占绝大部分的部分）：Tailwind / shadcn / Base UI 组件、`DesktopNativeActions`、弹层 expand/collapse 机制、locale 字典、advanced / extended 布局、内嵌终端、更新器、pnpm 与 profile 服务、设置页、市场。

数字常量（36 / 138 / 80 / 8）和 `titleBarOverlay` 的取值与社区版相同，但那是**平台度量**——帧高度、Windows 三键宽度、macOS 交通灯占位。要和系统控件严丝合缝，就只能取同一组值。

运行时**不依赖任何第三方包**；`electron`、`electron-builder`、`@electron/asar` 只用于构建与自检。

## 目录

```
src/main.js            Electron 主进程：窗口、托盘、快捷键、生命周期、诊断日志
src/shell-views.js     两个 WebContentsView：建立/layout/IPC sender 校验/销毁
src/window-chrome.js   帧几何常量（36 / 138 / 80 / 8）+ 窗口参数，单一事实来源
src/chrome.html        帧文档骨架 + CSP
src/chrome.css         36px 帧样式、拖拽区、平台留白、明暗
src/chrome.js          帧行为：动作按钮 + 跟随取样到的页面状态（无框架、无构建）
src/chrome-preload.js  帧文档唯一的桥（contextBridge，最小 API）
src/server-manager.js  后台拉起服务 / 解析 launch token / 等待就绪 / 停止进程树
src/runtime-locator.js 定位官方 dsh CLI 与 Node 运行时
src/dsh-profile.js     profile 读写：列插件、禁用/启用 bundle、从日志提取可疑对象
src/dsh-settings.js    向 settings.yaml 断言市场自重启开关（定点行编辑，不引 YAML 依赖）
scripts/make-icons.mjs 从官方 favicon 生成图标
scripts/selftest.js    不依赖 Electron 的定位与端口自检
scripts/tray-check.js  确认托盘图标能否解码及尺寸
```
