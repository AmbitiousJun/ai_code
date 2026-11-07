# GameTrail 游戏资源预热器

## 使用

macOS arm64 版本在 dist/GameTrail-0.1.1-macOS-arm64.zip。解压并双击 GameTrail.app，程序会在默认浏览器打开本地工作台。发行包自带 Node、Chromium、WebKit 和 Apple Vision 文字识别组件。右上角“退出程序”关闭服务；运行中先点“停止”。关闭工作台标签页后，可再次打开应用。

1. 入口默认使用提供的 JILI 模板。变量按行填写，例如 gameId=573,2,403 和 lang=zh-CN,en-US。每种取值先做 URL 编码，然后按笛卡尔积组合。选择两个设备将产生 12 个独立运行。
2. 勾选设备。内置 Windows Chrome、macOS Safari、iPhone 和 Android 的横竖屏预设。Safari 环境通过 WebKit 模拟。自定义配置在“自定义机型与探索参数”里填写，离开输入框后即可勾选。例如：
   
   ```json
   [{"id":"tablet","name":"平板横屏","engine":"chromium","viewport":{"width":1024,"height":768},"deviceScaleFactor":2,"isMobile":true,"hasTouch":true}]
   ```

3. 点击“启动任务”。每个入口和设备使用单独的浏览器上下文；模板变量 lang 同时设置浏览器 locale。任务串行运行，每个环境默认等待 60 秒、最多探索 8 步、静态补抓 40 个候选地址。加载慢的站点可以把等待时间调到 120 秒。
4. 时间线可筛选异常、探索、iframe 或缓存命中。总进度按已运行环境数计算；GET 200 指标按完整 URL 去重。同 URL 跨设备或语言的具体结果可查逐请求日志。黄色和红色事件附文字。顶部异常次数统计网络失败及 HTTP 4xx/5xx。
5. 在“任务报告”打开某个环境的结束截图，展开成功资源清单，或下载 JSON 和 NDJSON。report.json 中的 runs 数组记录入口、设备、变量和异常数。resources[].runs 可反查各资源出现在哪些环境。events.ndjson 记录时间、运行序号、方法、URL、HTTP 状态、来源和探索事件。报告保留完整 URL，使用生产 token 时需注意报告的存放与分享范围。

## 架构和运行边界

本机网页工作台通过 HTTP JSON 调用 Node 服务。服务只绑定 127.0.0.1，默认选用空闲端口。UI 每 600 毫秒按事件序号增量读取最近的请求；完整事件逐行写入任务目录。服务一次执行一个任务，SQLite 写锁使同一数据目录只有一个服务实例。

任务调度器将模板组合与设备预设展开为运行列表。每个运行启动无头浏览器，在导航前注册上下文级请求/响应、失败和子 frame 导航监听。页面正常发出的 POST 会保留原方法。浏览器实际访问的第三方资源同样记入报告。静态补抓只访问从源文档解析出的同源候选，支持 HTML src/srcset、CSS url/@import 与 JSON 中明显的资源路径；队列按完整 URL 去重，带数量和超时上限。游戏自己的动态 JS、嵌套 frame 和接口由浏览器执行。Service Worker 默认禁用以保证请求可观察，因此依赖其离线逻辑的站点可能表现不同。

探索顺序为可见 DOM 控件、可识别的 Cocos Creator 2.x Button 节点、Canvas 文字识别。Cocos 节点坐标通过引擎视口投影到实际画布。识别器只尝试具有帮助、游戏规则、菜单、公告等浏览含义的名称；教程文字中出现“不再显示”等上下文时还可尝试“继续”。Mac 包使用本机 Vision，源码版 Windows 若 PATH 上有 Tesseract 可使用 TSV 文字识别，语言包通过 GAMETRAIL_OCR_LANG 指定，默认 eng。“额外允许点击的入口名称”接受逗号分隔的精确名称，作用于整批游戏的 DOM、Cocos 节点和 OCR 字样；可把共用的游戏指南名称补充一次。填写的文字会授权程序尝试点击同名控件。各设备重新定位按钮，单个任务内曾伴随新增请求的名称获得优先级。

一次点击、随后出现 GET、以及观察到 iframe 导航分别记录。页面轮询也可能产生 GET。任务按探索预算结束，缺少交互入口时保留提示和结束截图。未暴露节点的纯图标、遮挡、非标准引擎、登录失败及服务端活动开关都会影响覆盖。每次运行的截图是结束时刻的画面。

## 缓存

默认容量 1 GiB，可改为 0–100 GiB，设为 0 会清空并禁用。容量约束针对响应正文文件；索引、任务报告、浏览器临时目录独立计量。命中后直接向浏览器返回已存正文，并记录 source=cache。需要确保访问到代理时，可在任务前清空缓存并将容量设为 0。

SQLite 保存键、大小、命中次数、最近使用时间、到期时间和响应头；文件名使用请求键的 SHA-256。键包括完整 URL、环境、语言和请求头，静态补抓使用自己的分区。可复用 GET 200 静态文件和明确资源后缀的响应可进入缓存。遵守 max-age、Expires，并可用 Last-Modified 生成最长一天的启发式有效期。带 Cookie、Authorization、Range、常见 token 查询参数或禁止缓存指令的请求绕过缓存；响应带 Set-Cookie、private、no-store、no-cache 或 Vary:* 时跳过。单个正文上限 16 MiB。无可用新鲜度信息时重新请求。命中计数跨任务保留；空间不足时按命中次数从低到高淘汰，同次数优先删最久未用；调低容量立即执行淘汰。

source=network 表示浏览器观察到网络响应，supplement 表示静态补抓，cache 表示本机命中。若浏览器直接连接 CDN，代理不会收到该请求。要确认反向代理端文件完整写入，需要对接该代理的写盘记录。本版本没有接入代理管理接口。

## 源码目录

| 位置 | 职责 |
| --- | --- |
| native/launcher.swift、native/GameTrail.icns | macOS 后台应用入口和 Finder 图标。启动器运行 AppKit 事件循环，管理本地服务，重复打开应用可回到工作台。 |
| src/server.js | 本机 HTTP 服务、单实例锁、任务生命周期、增量事件、报告、缓存控制接口 |
| src/config.js | 默认样例、设备和自定义配置、模板展开、范围及组合数量校验 |
| src/runner.js | 浏览器上下文、缓存拦截、网络和 frame 事件、补抓队列、截图和清理 |
| src/explore.js | 可见按钮/Cocos 场景树识别、坐标点击、探索预算、结果观测 |
| src/ocr.js 和 native/vision.swift | Canvas 截图文字识别；Mac 使用 Vision，其他系统可调用 Tesseract |
| src/discover.js | HTML/CSS/JSON 资源引用提取、相对 URL 解析和同源限制 |
| src/cache.js | SQLite 元数据、正文文件、命中计数、有效期、容量与 LFU 淘汰 |
| ui/index.html、ui/app.js、ui/style.css | 中文配置界面、实时请求表、任务历史、报告查看和缓存操作 |
| test/core.test.js | 模板组合、静态发现、缓存持久化、容量及隐私条件测试 |
| test/browser.test.js | 受控站点的 Chromium/WebKit 真实点击、双层 iframe、JSON/CSS 递归及二次缓存命中 |
| scripts/install-browsers.js、scripts/package-mac.sh | 跨平台安装浏览器、生成本机可运行的 macOS 应用包 |
| package.json、package-lock.json、.gitignore | 启动和构建命令、依赖锁定、生成文件排除 |
| dist/ | 本机发行包，默认不纳入 Git |

## 从源码运行

安装 Node.js 24（含 node:sqlite），在项目根目录执行下列命令。macOS 和 Windows 使用相同的启动入口。

```sh
npm ci
npm run browsers
npm start
```

macOS 源码运行时可用 `swiftc -O native/vision.swift -o native/vision` 启用系统 OCR。Windows 在没有 Tesseract 时仍可运行 DOM 和 Cocos 识别。浏览器版本固定在与当前 Mac 的 macOS 13 兼容的 Playwright 1.48.2；变更版本时同时更新 lockfile、重新安装浏览器并运行两种引擎的回归测试。本次未在 Windows 主机验收。

```sh
npm test
npm run package:mac
```

macOS 打包需要 Swift 编译工具和 Node 24。可用 GAMETRAIL_NODE 指定打包时内嵌的 Node 路径。发行包在本机生成，未做 Developer ID 公证。

macOS 默认数据目录为 ~/Library/Application Support/GameTrail，Windows 为用户目录的 .gametrail 子目录。GAMETRAIL_DATA 可覆盖路径；PORT 可固定端口；GAMETRAIL_NO_OPEN=1 关闭自动打开浏览器。cache/ 保存正文及索引，settings.json 保存最近的任务配置，reports/ 按任务保存报告、结束截图和原始事件。手动清缓存仅清理 cache/ 中的资源条目。

## 2026-11-07 本机验收

在 macOS 13.5.2 arm64 上以发行包对应的 Chromium 执行三个 gameId、两种语言。每环境等待 60 秒、最多 8 次探索、20 个静态补抓候选。下表包含浏览器及补抓命中的不同 GET 200 URL；每行独立去重。站点返回和网络时序会影响重复测试结果。

| gameId | lang | 不同 GET 200 URL | 实际点击 | 观察到的子 iframe 导航 |
| --- | --- | ---: | ---: | ---: |
| 573 | zh-CN | 376 | 1 | 0 |
| 573 | en-US | 373 | 1 | 0 |
| 2 | zh-CN | 294 | 1 | 0 |
| 2 | en-US | 294 | 1 | 0 |
| 403 | zh-CN | 270 | 1 | 0 |
| 403 | en-US | 270 | 1 | 0 |

六组均点击了教程中的“继续”或“Continue”。573 中文的结束截图停在 PLAY 标题页。样例中观察到 HTTP 400/404 以及页面脚本的 index out of range 异常；无法据此确定服务端原因，也未确认真实游戏内的活动 iframe 已覆盖。受控站点的浏览器回归测试则覆盖了点击后才出现的双层 iframe、语言 JSON、补抓、正文缓存复用和清理。

打包验收从 dist 的 ZIP 解压后启动应用，使用本地工作台提交测试任务，核对了运行结束、GET 200 清单和 iframe 导航结果。
