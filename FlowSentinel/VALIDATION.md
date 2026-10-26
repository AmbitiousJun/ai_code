# FlowSentinel 1.1.0 验收记录

日期：2026-10-22（北京时间）

## 测试环境

Windows 11 x64；本机 Google Chrome；Electron 45.0.0；Playwright Core 1.64.1；Node.js 22.23.3。Vue 3.5.44 本地测试页，两个独立 localhost 端口形成真实跨源 iframe，最深两层嵌套。

## 结果

| 验证内容 | 结果 |
| --- | --- |
| PNG 可信区域裁剪、位置偏移容差、图像缺失判定 | 通过 |
| 非法配置、模板语法、随机数边界校验 | 通过 |
| 中断 60 秒等待 | 通过，测试要求 5 秒内完成停止 |
| 流程原子保存、读取、删除和路径检查 | 通过 |
| 真实 Chrome 录制 Vue 用户名、密码、select 与登录按钮 | 通过 |
| 跨源 iframe 输入框、两层嵌套输入框和 checkbox | 通过 |
| 嵌套 iframe 中 Canvas 拖动与方向键回放 | 通过 |
| 两个独立无头 Chrome 实例回放与图像巡检 | 通过，样例正常图像匹配率 95.9% |
| 整字段随机整数、字段中间随机数字和实例编号 | 通过，已检查实际 iframe 输入值 |
| 主动删除可信图像 | 连续失败后保存截图，自动重建并恢复到正常状态 |
| 停止巡检和停止长时间回放等待 | 通过，浏览器集合清空 |
| 日志隐藏固定密码、表单输入与生成值 | 通过 |
| 录制多个中途截图检查点、框选暂停记录 | 通过 |
| 忽略每步 60 秒录制停顿，用检查点等待异步页面状态 | 通过 |
| 检查点超时阻止后续步骤并保存证据 | 通过 |
| 等待检查点期间停止 | 通过，测试要求 3 秒内停止 |
| GUI 框选检查点、保存独立超时、Esc 取消并恢复录制 | 通过 |
| Electron 源码版界面、配置保存、Windows 加密 | 通过 |
| 打包版 GUI：变量保存、双实例回放、巡检、顶栏停止 | 通过，无 renderer 异常，无页面横向溢出 |
| 单文件便携 EXE 解压启动、录制、停止、加密保存 | 通过 |

5 个单元测试全部通过。真实浏览器集成测试与桌面 GUI 测试通过。单文件便携启动器需要使用 `portable-smoke.js` 通过本机 CDP 连接进行测试；不能直接依赖 Electron 测试启动器读取它的调试输出。这个限制属于测试接入方式，正常双击启动不受影响。

## 复现

```powershell
npm ci
npm test
npm run test:e2e
node test/checkpoint-e2e.js
node test/ui-smoke.js
npm run dist
node test/ui-smoke.js --packaged
node test/portable-smoke.js
```

测试截图和文本日志生成在 `test-results`，自动化样例测试数据与用户实际配置隔离。Canvas 滚轮、原生对话框以外的特殊组件，以及超过两个实例的资源容量未做专项压力测试。

## 用户模拟环境排查

用户明确确认目标流程是纯测试/模拟环境，不涉及真实资金。在应用正常的 Windows 用户加密机制内读取录制，未导出密码或密钥。原流程有 76 步：第 62 步开始操作 Canvas 时，截图仍是加载进度条。可见模式对照也出现未就绪，证明依赖录制停顿无法可靠等待加载。

另外，原最终基准包含动态发光边缘，在成功进入目标页面后整图匹配约 86.4%，而内部静态图标匹配 100%。保留 90% 检测阈值，将基准裁为内部静态图标，并在地图就绪、引导就绪、引导关闭后的画面就绪位置插入三个检查点。无头回放全部 79 步，连续三次最终巡检均为 100%，随后停止测试。修复副本加密保存为原名称后加“（检查点修复）”，原录制未覆盖。

该结果是一次完整无头回放和三次连续巡检，不代表任意网络条件或网站后续更新下都保证成功。就绪画面发生变化时，需要重新录制对应检查点。实际网站录制、截图和诊断脚本不包含在源码分发包内。

## 1.2.0 发布验收（2026-10-23）

- `npm test`：9/9 通过，覆盖原位置优先、远距离搜索、点击偏移、重复目标阻断、缺失阻断、范围隔离、取消、空白及透明模板拒绝。
- `node test/visual-e2e.js`：通过。目标在 pointerdown 后立即消失仍保存点击前图；Canvas 内部分辨率为显示尺寸两倍；跨域 iframe；两个隔离上下文不同座位并发回放；重复/缺失目标不点击；WebGL 默认缓冲区和位移回放。
- `npm run test:e2e`：通过原有表单、双浏览器、嵌套 Canvas 拖动、变量、巡检、自动恢复与停止。
- `node test/checkpoint-e2e.js`：通过；测试画布增加稳定图案，以符合新录制图像有效性要求。
- `node test/ui-smoke.js` 和 `node test/ui-smoke.js --packaged`：通过，额外确认点击缩略图成功解码为 48×48，并保存界面截图。
- `node test/portable-smoke.js`：通过最终单文件启动、真实 Chrome 录制、停止和加密保存。
- 构建：默认解压目录 rename 遭遇 Windows EPERM；使用 `npm run dist -- --config.electronDist=node_modules/electron/dist` 成功，Electron 仍为锁定的 45.0.0。
- 产物：`dist/FlowSentinel-1.2.0-win-x64.exe`，102933342 字节。SHA-256：`885027af06a9202d57a2dd4d394bafce1fe2e2d696628d8df0b9087b6727e7da`，校验文件同目录。

验证边界：未连接用户实际捕鱼游戏、未验证 64 实例性能；本地并发为 2 实例/上下文。相同图案无法判断玩家归属，动画背景、旋转、缩放和受污染 Canvas 不保证定位。旧流程必须重新录制才有点击图像。最终可信图和检查点依旧是局部位置容差匹配。

## 1.2.1 大厅点击截图修复验收（2026-10-23）

- 只读检查“自动化 ParadiseFishing”：68–71 步没有 visual 且标为不可用，72–81 步均有 visual；故障证据 PNG 中大厅按钮可见。未运行用户真实游戏流程，也未改写原流程。
- `npm test`：12/12 通过，包含点击前/后帧选择与资源释放。
- `node test/capture-e2e.js`：透明 Canvas 叠加 CSS 图案、跨域污染 Canvas、静态 WebGL 无动画回调、iframe 坐标、点击后立即换图、低特征图片显示并提示，全部通过。
- `node test/visual-e2e.js`：位移、并发隔离、WebGL、缺失与歧义阻断通过。
- `npm run test:e2e` 与 `node test/checkpoint-e2e.js`：表单、拖动、双实例恢复、等待和停止通过。
- 源码与打包版 `ui-smoke.js` 均通过；`portable-smoke.js` 通过最终单文件 EXE 的启动、录制、停止与保存。
- 核对 app.asar 内 capture.js、recorder-script.js、engine.js 与源码字节一致，包内版本 1.2.1。
- 构建命令：`npm run dist -- --config.electronDist=node_modules/electron/dist`。
- 产物：`dist/FlowSentinel-1.2.1-win-x64.exe`（102934272 字节），SHA-256：`07617ef349d04b49ecddfb13df83751117551e27d1c82401fefd21caa14b38e4`。

边界：保存的旧错误没有区分 Canvas 读回失败的具体浏览器原因；上述回归覆盖可导致该问题的渲染场景。未声称已实测真实游戏。旧录制缺失的截图需要重录，截图匹配阈值和重复目标阻断行为未降低。

## 1.2.2 回退原坐标验收（2026-10-23）

- `npm test`：12/12 通过，匹配分类、取消、采集帧选择与存储回归正常。匹配器仍返回定位失败类别，由回放层实施回退策略。
- `node test/visual-e2e.js`：原位优先、唯一目标重定位、多个/缺失目标回退、旧 visualError 与损坏 PNG 回退、模拟截图异常回退、warn 日志、准确录制落点、后续表单继续、取消不点击均通过。两个隔离浏览器上下文并发验证，包含 iframe、缩放 Canvas 和 WebGL。
- `node test/checkpoint-e2e.js`：通过，检查点仍等待，超时仍阻断，不受 Canvas 点击回退策略影响。
- `node test/ui-smoke.js --packaged`：通过打包版界面、图像预览和双实例回放。
- `node test/portable-smoke.js`：最终单文件 EXE 启动、录制、停止及保存通过。
- 已核对包内 engine.js、vision.js、ui/app.js 与源码字节一致，版本 1.2.2。
- 构建：`npm run dist -- --config.electronDist=node_modules/electron/dist`。产物 `dist/FlowSentinel-1.2.2-win-x64.exe`，102932963 字节；SHA-256：`9cd03034fe8d0232f89a964cdb9b519130790762b3fc0c13634bfc8ba27ab180`。

未在真实捕鱼游戏中重跑。原有流程可直接使用新回退策略，不改写用户的录制数据；缺图步骤无法重定位但能按原坐标继续。

## 1.2.3 连续九次加注回归（2026-10-23）

- 只读提取用户指定流程中 Canvas 的坐标、间隔和局部图片；第 68–76 步位置完全一致，模板像素一致率 99.9566%–100%。新同点判定能将九步识别为同一段。没有导出表单步骤或修改原流程。
- `npm test`：15/15 通过；新增轻微图像变化/不同图像区分、拖动和长按排除、实例/几何/长间隔失效测试。
- `node test/repeat-e2e.js`：首次重定位成功后立即改变按钮外观，九次独立 down/up 均命中目标，仅首击截图，后八次输出复用日志；不同位置、超时、Canvas 替换及导航后不复用。两个 Runner 实例分别在不同座位完成九次点击，无回退警告。
- `node test/visual-e2e.js`：原有独立点击定位、未找到/多目标/无效图的原坐标回退、取消测试通过。
- `node test/checkpoint-e2e.js`：检查点等待、超时和停止通过。
- 源码与打包版 `ui-smoke.js`、最终 EXE 的 `portable-smoke.js` 均通过。包内 repeat-clicks.js 与 engine.js 和源码字节一致，版本为 1.2.3。
- 构建：`npm run dist -- --config.electronDist=node_modules/electron/dist`。产物 `dist/FlowSentinel-1.2.3-win-x64.exe`，102935102 字节，SHA-256：`101ae21663c874b7b1b7f3a268d68e9489631679ab57422fa73bacb588ce72eb`。

未在用户真实游戏中执行九次加注，现有日志不能单独证明具体是悬停、按压还是其他视觉状态改变；本次修复并复现验证的是“每步独立匹配且丢弃已确认重定位坐标”导致的连续点击问题。首击若从未匹配，仍按 1.2.2 策略回退，不会假称已确认目标。旧流程无需重新录制。

## 1.2.4 实际可见流程复现与修复（2026-10-23）

- 关闭无头模式运行用户的“自动化 ParadiseFishing”，单实例，在第 76 步后停止。原录制数据未改写，诊断副本不执行后续挂机操作。首次运行在第 63 步游戏加载超时；重试成功进入游戏，复现第 68–76 步全部 VISUAL_NOT_FOUND。
- 现场截图与录制图比对：加号外围背景及底部滚动条不同，完整图一致率 78.7326%，中央 32×32 为 100%。这说明上一版仅复用首次成功坐标不足以解决当前流程。
- 修复后再次可见运行，诊断副本检查点超时放宽至 180 秒：第 68 步中央特征通过，第 69–76 步依次复用，8 条复用日志，九连击段无 warn/error。现场证据位于 test-results/live-paradise-fixed；诊断配置副本已清理，未导出表单内容。
- npm test：16/16 通过；visual-e2e.js、repeat-e2e.js 通过，覆盖外围变化、重定位、多候选、平坦中心、原坐标回退、取消及双实例隔离。
- 包内 vision.js、engine.js、repeat-clicks.js 与源码一致，包内版本 1.2.4。

验证边界：实际游戏验证为单实例九连击段；不同座位并发由本地双实例夹具验证。第 66 步旧截图不可用、第 67 步无匹配仍按已有策略回退，未宣称整个流程每张图均匹配。检查点等待策略、流程数据和阈值未改动。

打包版 ui-smoke.js --packaged 和最终 portable-smoke.js 均通过。构建命令：npm run dist -- --config.electronDist=node_modules/electron/dist。产物 FlowSentinel-1.2.4-win-x64.exe，102935390 字节；SHA-256：2eb81641ba25f9677d7fc03ed4fb40e6dca967fad31892799bb91914ba149ce7。

## 1.2.5 无头巡检日志截图（2026-10-23）

- `npm test`：16 项单元测试通过。首次沙箱执行遇到临时文件 rename 权限限制；沙箱外重跑全部通过。
- `node test/e2e.js`：真实 Chrome 录制、双实例回放、失败恢复与停止通过；新增断言验证无头正常/失败巡检携带 PNG，有头巡检不携带图片。
- `node test/ui-smoke.js`：源码版 GUI 验收通过。首次新增测试在 dialog close 事件触发前检查图片释放，调整为等待 close 处理完成后通过。
- `node test/ui-smoke.js --packaged`：1.2.5 解包版通过缩略图、放大、原始尺寸、Esc/按钮关闭、刷新恢复、64 张保留上限和磁盘文字日志检查；无渲染异常。截图见忽略目录 `test-results/log-image-packaged.png`，报告见 `test-results/packaged-report.txt`。
- 本轮功能测试使用独立数据目录和本地夹具，不操作用户已有流程。24 MiB 编码预算经过代码核对；未执行 64 实例长时间内存压力测试。
- `npm run dist` 与 `node test/portable-smoke.js`：成功；单文件 EXE 解压启动、录制、停止和加密保存通过。产物 `dist/FlowSentinel-1.2.5-win-x64.exe`，102,865,234 字节；SHA-256：`605855A5D9868CF85550914422985DE8B1FD4E19C841927F6F25804F56F4995D`。

## 1.2.6 浅色与系统主题（2026-10-23）

- npm test：16/16 通过。首次沙箱执行因临时文件 rename 权限失败，沙箱外重跑通过。
- node test/theme-smoke.js 与 --packaged：源码与解包版均通过。覆盖三种主题、模拟系统实时变化、手动模式优先、刷新及应用重启持久化、非法值回退系统、无横向溢出。首次沙箱内 Electron 启动失败，沙箱外通过。
- 浅色和暗色界面已截图检查，证据见 test-results/theme-light.png、theme-dark.png 及对应 -packaged.png；沿用原布局，主题覆盖表单、日志和实例状态。
- node test/ui-smoke.js --packaged：已有 GUI 回归通过，包括录制、检查点框选、配置保存、双实例回放、日志截图放大/关闭、刷新恢复和图片数量限制。
- npm run dist -- --config.electronDist=node_modules/electron/dist：成功。node test/portable-smoke.js：最终单文件 EXE 启动、真实 Chrome 录制、停止与加密保存通过。
- 产物：dist/FlowSentinel-1.2.6-win-x64.exe，102937883 字节。SHA-256：3C543E6802AB3346D4DB0BC982D9F30F0585B11BA7A02DFBF82D22DCEF11BFFA。
- 验证范围：使用独立测试数据，不操作用户已有流程；系统颜色切换通过 Playwright 媒体模拟验证，未修改 Windows 个人设置。本轮未重跑全部 Canvas 专项 E2E，录制回放核心代码无变更。

## 1.2.7 流程交换验收（2026-10-23）

- npm test：20/20 通过；之后新增完整字段往返用例，node --test test/transfer.test.js：5/5 通过。
- node test/transfer-smoke.js 与 --packaged：通过。真实 Electron 界面/IPC/Windows 加密 Store 验证默认原名、实时重名、主进程二次拦截、修改名称、取消不落盘、新 UUID、默认下载目录、导出包含表单原值、两个独立数据目录往返以及新协议拒绝/最低版本提示。
- 原生文件对话框在自动测试中替换返回值并核对参数；没有自动点击系统文件选择器。两个目录模拟另一处安装，未在第二台物理机器测试。
- 交换单元测试覆盖损坏封装、不支持的数据版本/步骤、较新导出版本仍兼容、最低导入版本阻止、模板/参考图/检查点/自定义配置保留。
- 初次沙箱内 Store 测试受临时目录重命名权限限制，沙箱外重跑通过。此次没有重跑全部游戏回放 E2E；录制、匹配和回放引擎未改动。

- npm run dist：成功生成 dist/FlowSentinel-1.2.7-win-x64.exe（102869050 字节）。node test/portable-smoke.js：通过单文件解压启动、界面桥接、真实 Chrome 开始/停止录制及加密持久化。便携脚本的通用输出提到完整回放，但本轮仅执行上述测试，不将该文字作为本轮完整回放证据。

## 1.2.8 恢复缓存验收（2026-10-26）

- npm test：21/21 通过。首次沙箱运行的 Store 原子重命名遇到 EPERM，在沙箱外运行通过。
- node test/cache-e2e.js：真实 Chrome 双实例各自首次请求静态脚本一次；同一实例巡检失败、关闭旧标签页及再次打开后，服务端资源请求总数仍为 2，确认缓存复用。验证弹出页关闭、上下文身份不变、Cookie/localStorage 保留且实例隔离、page 监听器数量不累积、目标页关闭恢复、上下文关闭和浏览器断开后重启、恢复退避中停止及达到恢复上限释放浏览器。报告见 test-results/cache-report.txt。
- node test/e2e.js：录制、嵌套 iframe/Canvas、随机字段、双实例巡检、故障证据、自动恢复、停止和日志截图回归通过。
- node test/checkpoint-e2e.js：检查点等待、超时阻断、录制暂停和停止回归通过。
- 范围：HTTP 缓存验证使用带 public,max-age=3600 的本地静态脚本；不声称所有网站或 no-store 资源都能命中缓存，也不实现跨实例或跨任务缓存。
- node test/ui-smoke.js --packaged：新版解包应用通过 GUI 启动、录制/停止、参数保存、加密持久化、双实例回放、日志图像与停止验收，无渲染异常。
- npm run dist：成功生成 dist/FlowSentinel-1.2.8-win-x64.exe（102871944 字节）。node test/portable-smoke.js：单文件解压启动、界面桥接、真实 Chrome 录制/停止和加密持久化通过。SHA-256：6e33755e8d8efe597bb43c41022006023e78680ea8708ce482a9e40e10b27e69。
