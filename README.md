# dsh-piliaurora-wall

PiliAurora 视频墙 —— 在 DSH **右侧边栏**以面板页签的形式提供 B 站视频墙：输入关键词即可并行打开 N 个**独立播放窗口**并自动网格排列。
全程只用指令通道（自建 WebSocket 父进程 + Windows 窗口搬运），**不移动鼠标、不截屏、不读 UIA、窗口先建在屏幕外再搬运**。

## 界面

![视频墙操作面板：关键词搜索、窗口数、网格排列、声音/连播、上次会话快照](screenshots/1-overview.png)

## 功能

| 能力 | 说明 |
| --- | --- |
| 搜索并开窗 | 面板输入关键词 → 抓 bilibili 视频池 → 开 N 个独立播放窗口 → 自动网格排列（按主屏实际像素计算网格与坐标） |
| 网格数量 | 1~16 窗任选，网格布局自动适配窗数 |
| 一键声音 | 全部窗口有声 / 全部静音（走 PiliAurora 的协议 `mute` 消息） |
| 全部隐藏 / 显示 | 窗口进程继续播放，只是隐藏到任务栏之外 |
| 下一批 | 换成候选池里本批次以外的视频（候选池容量 > 2×窗数时成立；池不足则按顺序轮转复用） |
| 自动连播 | 按抓取到的视频时长（自开窗时刻计时，含冷启动/缓冲）自动换下一个；候选池用尽后按顺序轮转 |
| 入口形态 | 默认「侧栏」按钮（跟随侧边栏显隐，**独占一整行、与「日程助手」「DeepSeek 网页面板」上下排列**；收起侧边栏时变 36×36 圆钮）；可切换成 34×34 独立悬浮球 |
| **依赖自检** | 面板状态灯区分「运行中 / 服务未启动 / 缺脚本 / 缺程序」，不再一律显示"未启动" |
| **自动拉起** | 开窗前若 PiliAurora 主程序没在跑，自动拉起（可在设置页关掉）；脚本目录或 Python 缺失时只提示不代装 |
| **设置页** | 面板头部「设置」页签：程序路径 / 服务脚本目录 / Python 路径全部可手填，带「浏览」（接受 .lnk 自动解析）、「解析快捷方式」、「启动」、「保存」 |
| **官方下载地址** | 设置页直接显示 PiliAurora 的 GitHub 地址并给「打开下载页 / 复制 / 新仓库」三个按钮，用户不用再去搜 |
| **检查更新** | 底部「检查更新」四态（检查中 / 有新版 / 已是最新 / 失败），有新版时悬浮球亮红点 |

## 原理（为什么不需要 UI 自动化）

PiliAurora 的播放小窗是**多进程**：每个小窗是 `PiliAurora.exe --piliaurora-player-window` 子进程，
父进程起回环 `WebSocket` 服务器，通过环境变量 `PILIAURORA_WINDOW_ID / _PORT / _TOKEN` 与子进程握手，
握手成功后发一条 `initialization` JSON（内含 `request`、`bounds`、`cacheDirectory` 等），子进程据此加载视频页面。

本插件不带任何 UI 自动化，而是**自己当父进程**：

1. `<脚本目录>\wall_server.py` 启动 N 个播放窗口进程，握手后把 `bounds` 设到屏幕外；
2. 子进程就绪约 2 秒后，用 `user32.MoveWindow / SetWindowPos` 把窗口搬到网格位（延迟 3 秒，避开 Flutter 启动时回写 bounds）；
3. 声音靠协议消息 `{"type":"mute","muted":false}`（必须在 ready 后约 2.5 秒发，早发会被静默丢弃）；
4. 命令通道：写 `wall\cmd.json`，服务回写 `wall\result.json`。

## 使用

1. 侧边栏底部点「视频墙」图标（或切到悬浮球模式后点球）；
2. 输入关键词 → 选窗数 → 「开窗排列」；
3. 面板下方实时显示每个窗口的标题与播放进度；
4. 依赖没配好时点头部「设置」页签：留空即用自动探测结果，填错可「浏览」重选 → 「保存」。

## 依赖与自动探测

| 依赖 | 自动探测顺序（命中即用） | 可在设置页覆盖 |
| --- | --- | --- |
| 服务脚本目录 | 配置 `autoDir` → 环境变量 `PILIAURORA_AUTO_DIR` → `E:\dsh-tmp\piliaurora-auto` → `E:\DSH\tmp\dsh-tmp\piliaurora-auto` → `%USERPROFILE%\.dsh\piliaurora-auto` → 插件包内置 `scripts`（缺脚本时自动释放到 `~\.dsh\piliaurora-auto`） | ✅ |
| PiliAurora | 配置 `exePath` → 5 个常见安装路径 → 桌面/公共桌面 `.lnk` 快捷方式解析 | ✅ |
| Python | 配置 `pythonPath` → 环境变量 `PILIAURORA_PYTHON` → `E:\Python311..313` / `C:\Python311..312` 的 `pythonw.exe` → `python` → `py` | ✅ |

- 判定「脚本目录」的硬条件是**该目录同时存在 `wall_server.py` 与 `fetch_pool.py`**；只有空 `wall\` 数据目录不算命中。
- 配置文件：`%USERPROFILE%\.dsh\piliaurora-wall.config.json`（首次保存时自动创建）。
- 脚本目录必须同时是数据目录（`wall\status.json`、`pool.json` 都写在这里），宿主启动服务时会显式传 `PILIAURORA_AUTO_DIR` / `PILIAURORA_EXE` 环境变量，因此脚本放哪都能把状态写回同一处。

## PiliAurora 官方地址

设置页会直接显示并在需要时用系统浏览器打开（宿主 `POST /open-url`，只放行 `https://github.com`）：

| 用途 | 地址 |
| --- | --- |
| 下载 / 更新（当前在本仓库发布） | https://github.com/wallpap/PiliAurora/releases/latest |
| 后续版本（2.0.2 起本仓库只读归档） | https://github.com/wallpap/PiliAuroraNext |

## 语言

面板文案目前仅中文（硬编码）；`locale/zh-CN.json` 与 `locale/en.json` 的 `meta` 段用于 DSH 插件市场的展示名称与描述，`panel` 段暂未被界面读取。

## 侧边栏入口布局（0.2.4）

**真实结构**（2026-11-26 用 DevTools 在官方版 DSH 里实测，侧栏 280px 时）：

```
wtg9ga_footArea              264x102  column
└ wtg9ga_footerActions       264x50   row / nowrap / position:relative   ← 宿主容器
   └ div[display:contents]             ← 宿主透明包装层，子项直接参与容器的 flex 布局
      ├ dsc-launch-layer               264x42  position:absolute  bottom:calc(100% - 8px)  ← 日程助手，钉在容器上方
      ├ dsw-webpanel-toggle-layer      264x42  position:relative  margin-top:8px           ← DeepSeek 面板，常规流
      └ 本项（修复前）                  67x30   position:static                            ← 被 nowrap 挤到 x=272，只剩右缘
```

**根因**：容器是 `nowrap`，而每个注册项自身都是 `width:100%`。三个 `width:100%` 的项横排在一行里互相挤压，落到容器可视区里的只剩一条被压扁的竖线——就是侧栏右缘那两条短竖线。能正常上下排列的两家，**都不是靠 wrap，而是各自脱离常规流**：日程助手 `position:absolute` 钉在容器上方，DeepSeek 面板 `position:relative` + `margin-top:8px`。

**修法**（只作用于本插件自己，一条 `flex-direction` / `flex-wrap` 都不改）：

1. 容器侧：`[class*="footerActions"]{position:relative}` —— 仅加定位参照；容器高度、方向、兄弟节点位置一律不动。
2. 本项侧：`.wall-foot-outer` **绝对定位**到容器上方一层
   `position:absolute; left:0; right:0; bottom:calc(100% + 24px); height:32px; pointer-events:none`
   —— 正好让本项顶边与「日程助手」顶边等距 32px（一整行高）；外层 `pointer-events:none` 不挡邻居点击。
3. 入口按钮 `.wall-foot-entry` 与「日程助手」`.dsc-launch-btn` **完全同构**：
   `height:32px; padding:0 10px 0 8px; border:3px solid transparent; background-clip:padding-box; border-radius:var(--dsw-radius-md); font-size:14px`
   —— `border:3px transparent` + `background-clip:padding-box` 让高亮背景条左右各缩 3px（与邻居一致），
   内容起点 `3px(border) + 8px(padding)` = 11px，与邻居图标 x 严格对齐。
4. 同时把邻居两行也压到同一节奏（统一背景/对齐/间隙）：`.dsc-launch-layer{height:32px}`、`.dsw-webpanel-toggle-layer{height:32px;margin-top:8px}`（habit 行不动）。
5. 收起侧边栏（宿主传 `wide:false`）时降级成 36×36 圆钮，只留图标。
6. 颜色全部走 `--dsw-alias-*` 令牌，图标尺寸由 `1.25em` 派生而非写死像素。

**为什么不用「给容器加 `flex-wrap:wrap`」**（试过，实机无效）：给容器改 `flex-direction` / `flex-wrap` 会连带把**按钮内部**的图标与文字也竖排（「日程助手」1.1.24 踩过并已撤销，见其源码 1.1.25 注释），且与「日程助手」已经使用的 absolute 定位相互干扰。正确做法是容器保持宿主原样，**只把自己这一项绝对定位**——本条与「日程助手」「DeepSeek 网页面板」完全同一套路。

**为什么早先 0.2.4 的 apply 会让入口消失**（一度 `fiber.state=1 loading`）：`apply()` 里若调用 `ctx.effect(...)` / `ctx.locale.register(...)` / `require("./locale/*.json")`，cordis 的 `_execute` 会因这些调用永不完成而卡在 LOADING，整条插件 entry 不激活。**修法 = `apply` 保持同步最小化**（只做 `ensureEntryCss()` + 两个 `slots.inject`），不返回 Promise、不调 effect/locale。

Chromium 实测（真实 DOM 层级 + 三家真实 CSS，侧栏 264px，三行均 32px）：

| 指标 | 日程助手 | DeepSeek 面板 | 视频墙 |
| --- | --- | --- | --- |
| 行宽 | 264 | 264 | **264** |
| 行高 | 32 | 32 | **32** |
| 图标 x | 11 | 11 | **11** |
| 背景条左右缩进 | 3px | 3px | **3px** |
| 顶到顶间距 | — | 与上段 32px | **与日程助手 32px** |

最终视觉顺序：**视频墙 → 日程助手 → DeepSeek 网页面板 → 设置区**，宽度 / 对齐 / 上下间隙三样统一。
## 生效方式

| 改动 | 生效方式 |
| --- | --- |
| `lib/index.js` / `package.json` / `cordis.patch.yml` | **彻底退出 DSH 客户端再启动**（宿主是 Node 进程，没有热重载） |
| `lib/client.js` / `locale/*.json` | **彻底退出 DSH 客户端再启动**（客户端模块在宿主进程里注册一次就常驻，硬刷新只刷页面、不卸载模块，会让人误判「改了没用」） |
| `scripts/*.py` | 下一次开窗自动生效（每次开窗都会重新起服务进程） |

## 许可

MIT
