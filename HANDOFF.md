# 大肥鱼CyberRelic（dsh-CyberRelic）交接文档（跨设备同步插件，原 dsh-sync-fish）

> 写于摸鱼会话，交接给新会话继续。角色：蓝色大肥鱼 🐋（鲸鱼娘）。用户称「主人」。

## 目标

做一个 DSH 插件，让**多台电脑 + 手机（DSH Go）**之间同步：

1. **记忆**（当前由 dsh-fish-memory 提供）
2. **习惯**（设置 / 技能 / agent 预设 / 插件清单）
3. 会话：可选，按设备隔离，不硬合并

要求：本地部署和网络部署的 DSH 都能用；跨公网（公司 + 家）。

## 硬约束（已确认）

- **DSH Go 有两种模式**：
  - 本机运行：Android App 内 Ubuntu（PRoot），免 Root，插件装在手机那套环境里；
  - 远程连接：连电脑/服务器的 DSH，插件只装电脑端。
- 插件必须**纯 JS、零原生依赖**（PRoot 里没有原生模块），加密用 WebCrypto 或纯 JS libsodium，不用 age 二进制。
- **不能用「网盘同步文件夹」通道**——安卓上没有 OneDrive/坚果云同步盘客户端。通道只能走 HTTP(S)：WebDAV / S3 兼容 / 自建同步服务。
- 手机切后台会被杀 → 同步只能「打开 App / 启动时 / 手动按钮」触发，不能常驻轮询。
- DSH Go 远程模式下插件管理只有开关，不能装 → 手机要用就本机模式装，或直接连电脑那台。

## 现状（本机）

- DSH 家目录：`C:\Users\Administrator\.dsh`
- 当前 profile：`desktop`，插件目录 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules`
- 鱼记忆插件：`dsh-fish-memory@1.5.5`
  - 数据：`~/.dsh/fish-memory/session-<uuid>.json`（一个会话一个文件，纯文本 JSON）
  - 配置：`~/.dsh/fish-memory-config.json`
  - 备份：`~/.dsh/fish-memory-backup/<日期>/`
  - **已有记录级合并内核**：`node_modules/dsh-fish-memory/lib/store-merge.mjs`
    （按 id 合并、比较 editedAt/relatedAt/reinforcedAt/deletedAt/createdAt、带删除墓碑 deleted[]、traces 取并集）
  - 原子写：`lib/atomic-file.mjs`（同目录 staging + rename）
- 记忆是**按会话**的：另一台机器没有同一 session id → 光同步目录读不到。要跨机可读，必须改成「全局记忆库 + 每场会话启动时合并注入」，或换全局记忆插件。
- 本机 git 可用：`git version 2.56.0.windows.4`；`dsh` 不在 PATH（用 GUI 装插件）。

## 架构设想

```
┌──────────────┐   WebDAV / S3 / 自建 HTTP   ┌──────────────┐
│ Windows DSH  │ ◄─────────────────────────► │  Android DSH │
│  (公司/家)    │        加密的“记录包”        │   Go (PRoot) │
└──────────────┘                              └──────────────┘
        │                                            │
        └──────── 同一个同步插件（纯 JS） ─────────────┘
```

### 数据模型

```
记忆: { id, 内容, 类型, 重要度, createdAt, updatedAt, deletedAt, device }
习惯: 设置 / 技能 / agent 预设 / 插件清单 → 文件级 + 三方合并(base/local/remote)
会话: 可选，按设备隔离
```

- 合并：记录级 LWW（后写胜），删除留墓碑防复活，双方都改的进 conflict 队列
- 加密：口令派生密钥（scrypt）+ libsodium/WebCrypto，云端只存密文
- 触发：写入后 2s 防抖 + 定时（桌面 30s）+ 启动时 + 手动按钮；离线排队、联网补传
- 身份：每台机一个 device id，记录带来源

## 进展（2026-11-06）

`dsh-sync-fish@0.1.0` 已经写完并 `plugin_manager install_bundle` 装进 desktop profile（link 到本工作区目录），
**还差重启 DSH 才会加载**（安装结果是 `restart-required`：新包换了目录）。

已实现（纯 ESM、零依赖）：

| 文件 | 作用 |
| --- | --- |
| `lib/merge.js` | 记忆按 id LWW（时间相同用内容哈希收敛）、墓碑并集；文件三方合并 |
| `lib/memory.js` | 合并所有会话库 → `~/.dsh/sync-fish/memory/global.json`；按 id 注回每个库（保留 `purgeEpoch`，新建库用 `''`） |
| `lib/files.js` | 技能目录/设置文件快照、三方合并、冲突副本 |
| `lib/channel.js` | folder + WebDAV 通道（PROPFIND/PUT/MKCOL，20s 超时） |
| `lib/crypto.js` | AES-256-GCM + scrypt，口令不落盘 |
| `lib/engine.js` | 一轮同步：读远端 → 合并记忆/文件 → 写本地 → 写自己快照 + manifest |
| `lib/index.js` | 插件入口：`sync_now` / `sync_status` / `sync_conflicts` / `sync_setup`；启动 8s、每分钟检查定时、`agent/created` 注入新会话 |
| `test/` | 两台模拟机（sync 6 + plugin 3 + util 4，共 13 个用例，全过） |

已定设计：
- 记忆采用**全局库 + 注入**（会话 id 跨机不可能相同），注入保留每个库自己的 `purgeEpoch`
- 第一版通道先 **folder**（同步盘/U 盘即可），WebDAV 已实现待真机验证
- 远端布局 `<prefix>/devices/<deviceId>.json` 每台一份完整快照 + `manifest.json`
- 不导出 Config（避开 schemastery），配置走 `~/.dsh/sync-fish/config.json`，工具写；插件行 config 只做运行时覆盖

安装后要做：重启 DSH → `sync_status` 确认通道 → 每台机 `sync_setup` 一次 → `sync_now`。

已验证（2026-11-06 重启后）：四个工具都挂上了；本机用 `dsh-sync-demo/` 作 folder 通道跑了两轮
（第一轮全局 5 条、注入 +11，第二轮注入 +0 幂等），4 个会话库都是 5 条记忆且 `purgeEpoch` 保留；
又用临时 DSH_HOME 模拟了第二台机读取同一份快照（读到 1 台设备、合并出 5 条记忆、manifest 出现两台设备）。
正式数据备份在 `~/.dsh/fish-memory-backup/2026-11-06-202341-pre-sync/`。

坚果云 WebDAV 真机验证（2026-11-06 晚）：
- 端点 `https://dav.jianguoyun.com/dav/`，账号 `594240637@qq.com`，用「应用密码」（不是登录密码）；本机直连正常，不需要代理。
- **坑：坚果云不允许在 WebDAV 根目录新建文件** —— `PUT /dav/<file>` → `404 ObjectNotFound`；
  写在不存在的目录里 → `409 AncestorsNotFound`；必须先在目录里（`MKCOL` 建目录 → `PUT` 才 201）。
- 因此 `WebdavChannel.ping()` 改成把探针写进 `<prefix>/` 目录里再删掉（`lib/channel.js` 的 `remove()` 用 DELETE），
  之前写根目录的探针在坚果云上必然 404。`write()` 原有的「409/404 → MKCOL 父目录 → 重试」逻辑保持不变。
- 实测一轮真实同步成功：ping OK、读到 0 台其它设备、全局 6 条记忆、注入 4 个库、202ms；
  云端得到 `<prefix>/manifest.json` + `<prefix>/devices/c486e63b-....json`，手工探针文件已删。

加密 + 多机（2026-11-06 晚）：
- `sync_setup passphrase=...` 打开口令加密后，云端快照变成 `dsh-sync-fish/enc/v1` 信封
  （AES-256-GCM + scrypt，salt/iv/tag 随机）；同一口令在另一台机上能解开，错口令抛 `SYNC_DECRYPT`。
- 第二台电脑（DESKTOP-9I70ELV）装了同一个包、同一通道后，本机一轮同步看到两台设备，
  manifest 里两台各 8 条，注入 +8；两个设备快照都是密文。

安卓 DSH Go 本机模式（2026-11-06 晚，手机 vivo V2304A / Android 14）：
- App 是 `io.github.ccch1mneyyy.dsh_app`（DSH Go），**不可调试**、数据目录不可读，也没有可用的 HTTP token；
  只能用 `adb shell input tap/text` + `screencap` 驱动 App 内的会话，让手机上的 agent 自己动手。
- 安装流程（在手机 App 的会话里发指令即可）：
  1. `adb push dsh-sync-fish-0.1.0.tar.gz /sdcard/Download/`
  2. 让 agent 解压到 `/root/.dsh/plugins/dsh-sync-fish`，再 `plugin_manager install_bundle` 该目录（changed true）
  3. 把写好的 `config.json` push 到 `/sdcard/Download/sync-config.json`，让 agent 复制到 `/root/.dsh/sync-fish/config.json`
     （手机 DSH_HOME=`/root/.dsh`，profile=`web`）
  4. `sync_now`：记忆全局 8 条、读到两台设备
- 坑：`adb shell input text` 空格要写 `%s`；文本里带 `(` 会让设备端 shell 报 `syntax error`。
  输入框聚焦：键盘收起时点 (470,2330)，键盘打开后发送键在 (977,1415)。
- 手机端 agent 发现并修掉一个真 bug：`lib/util.js:119 looksLikeText()` 只取前 8192 字节，
  当截断点正好落在一个汉字的第一个字节（`\xe4`）上时 `isUtf8()` 判 false，整份纯文本技能被当二进制跳过。
  修法：截断前用 `completeUtf8End(head)` 退到完整 UTF-8 字符边界；补 `test/util.test.js`（4 例）。
  修后同一份技能目录从 55 个文件变成 56 个，`warnings: []`。
- 手机上改完源码要「关掉再打开 `include:sync-fish`」触发 ESM 重载（Node 不会因为文件变化重载模块）。

## v0.2.0 正式化（2026-11-06 夜）

主人要求把原型整合成正式插件，五项：①手机连 USB 一键装 DSH Go ②设置页里网盘邮箱/应用密码单独输入框
③工作区/插件设置/记忆/习惯/任务各自开关 ④可调刷新间隔 ⑤可选加密口令。已全部实现，代码与测试就绪：

| 文件 | v2 变化 |
| --- | --- |
| `lib/files.js` | `DEFAULT_SCOPES`、`buildTargets(config)`（skills tree / plugins glob / tasks / workspaces）、`keyAllowedByTargets`、`expandGlob`、`mergeWorkspaceRegistries`（按 title/path 合并工作区，`sessionIds` 留本机） |
| `lib/config.js` | `CONFIG_VERSION=2`：新增 `scopes`、`extraTargets`、`phone`；v1 的 `files`/`memory.enabled` 自动迁移；`isScopeEnabled`；webdav 缺账号只 warning |
| `lib/engine.js` | 记忆受 `scopes.memory` 控制；文件目标来自 `buildTargets`；快照带 `scopes`；工作区先合注册表再三方合并 |
| `lib/phone.js` | 纯 JS tar+gzip、找 adb、推包、启动 App、`input text` 让手机 agent 解压安装并同步、轮询 manifest 验证 |
| `lib/server.js` | 设置页 API：`/api/sync-fish/{status,phone,conflicts,config,test,sync,conflicts/clear,phone/install}`，同源校验 |
| `lib/index.js` | `inject` 加 `webServer`；新增 `sync_phone` 工具；`sync_setup` 支持 `scopes/phoneName/adbPath`；设置页保存后立即重排同步 |
| `client.js` | 设置页「跨设备同步」：状态卡、WebDAV 地址/邮箱/应用密码、五个分类开关、间隔、加密口令、手机一键装 |
| `package.json` | 0.2.0；`./client` 导出；`dsh.client` 声明 web 平台与三个 client 依赖 |

测试：`sync 6 + plugin 3 + util 4 + config 6 = 19 pass 0 fail`。

### 已验证（2026-11-06 夜，重启后）

- 设置页挂载：client Slots `settings.section` 里出现 `sync-fish`（order 40，active），同页还有 bili-scroll 30、memory 51 等。
- 宿主 API：`GET /api/sync-fish/status` 200；`POST /config` 保存成功且空密码不清掉已存的应用密码（`hasPassword=true`）；`POST /test` 探测 webdav ✓；`POST /sync` 1090ms 成功；跨源请求 403。
- 手机一键装：先独立脚本、再走设置页真实接口 `POST /api/sync-fish/phone/install`，job 约 70s done，日志从找 adb、推 43.6KB 安装包、推配置、启动 DSH Go 到「手机已同步：手机 · 2026-11-06T13:58:42.292Z」，`verified:true`，manifest 手机 9 条记忆 / 60 文件。
- 修了真机上的点击坐标：输入框聚焦点从 `h*0.907` 改为 `h*0.971`，并加 `keyboardShown()`（`dumpsys input_method` 的 `mInputShown=true`）判断，没弹键盘就再点一次。
- 设置页「一直显示正在读同步状态…」的根因：给 API 用的 `buildStatusSafe()` 返回体里漏了 `config` 字段，客户端 `applyStatus()` 见不到 `data.config` 就静默 return，`form` 永远是 null、占位文字永远不消失。修法：`lib/index.js` 的 `buildStatusSafe()` 补 `config: described`；客户端缺 config 时改为显式提示而不是沉默。
- 顺带加固（已保留）：`sameOrigin()` 放行 `Origin: null`（桌面窗口如果是 `file://` 会发 null，外站 `http://evil.example` 仍 403）；`lib/server.js` 记录 `API 请求 / API 响应 → 状态码`；新增 `GET /api/sync-fish/self-test`（不需要 GUI token 的浏览器自测页，fetch status 后把结果写进 `<title>`）与 `POST /api/sync-fish/diag`（客户端 `navigator.sendBeacon` 上报阶段）；客户端 `refresh()` 改用 `AbortController + setTimeout(10s)`，不再依赖可能缺失的 `AbortSignal.timeout`。

已知限制：更新插件只能改文件 + 重启宿主（`install_bundle` 对已 link 的目录返回 `already-installed`）；client bundle 也要重启才换。

## 下一步

1. ~~重启 DSH，验证四个工具真的出现在会话里、`sync_status` 能读配置~~ → 已完成（现在是五个工具）
2. ~~WebDAV 真机验证（坚果云/AList），确认 MKCOL/中文路径/证书~~ → 坚果云已验证（见上）；AList 未测
3. ~~与本机真实鱼记忆做一次非 dryRun~~ → 已完成（folder demo + 坚果云各一轮）
4. ~~设置类同步：`~/.dsh/skills` 已覆盖~~ → v2 起按分类覆盖 skills / 插件设置 / 任务 / 工作区
5. ~~安卓 DSH Go 本机模式实测~~ → 已完成（本机模式装插件 + WebDAV 同步跑通）
6. ~~口令加密（passphrase）真机跑一轮~~ → 已完成；剩：S3 通道、AList/Nextcloud 兼容性
7. 桌面端下次重启后会加载修好的 `lib/util.js`（ESM 缓存），之后那 56 个技能文件不会再反复「恢复」
8. v0.2.0：重启加载设置页与 API → 设置页里保存/测试一次 → 手机 USB 一键装跑一次

## MVP 三步

1. 核心同步引擎 + 本地文件夹通道 ← **完成**
2. WebDAV/S3 通道 + 口令加密 ← WebDAV+加密已写，待真机验证；S3 未做
3. 打成 DSH 插件（`cordis.patch.yml` + `lib/index.js`）← **完成**，待重启验证

## 待定（开工前要问主人）

- ~~第一版通道：WebDAV / S3 / 先本地文件夹原型？~~ → 先 folder，WebDAV 已实现
- ~~记忆要「换全局记忆库」还是「保留按会话」？~~ → 全局库 + 注入，按会话存储不动
- 是否接受把鱼记忆数据迁到新插件 → 不需要迁移：第一次同步自动合并现有会话库


## 参考

- 鱼记忆源码：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-fish-memory\lib\store-merge.mjs`
- 现有社区同步插件（可借鉴，不重造）：`@weibaohui/dsh-sync`（Git/WebDAV/本地文件夹，技能/会话/设置/插件清单）、`dsh-plugin-dsh-sync`（局域网 P2P）、`dsh-sync-webdav`、`dsh-config-manager`
- 记忆插件备选：`dsh-mnemon`（全局/按工作区存储 + 内置 Git 同步 + 自动间隔）、`dsh-plugin-memory`（markdown+git，可迁移）
- DSH Go：https://github.com/ccch1mneyyy/dsh-go （本机运行 PRoot Ubuntu / 远程 SSH、DSHarness Remote）

## v0.2.6（2026-11-07 凌晨）手机一键装的两个修复

1. **不再依赖点输入框**：改用 Android 分享入口
   `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "<指令>" -n io.github.ccch1mneyyy.dsh_app/.share.ShareActivity`
   —— App 会新开一个对话并把指令预填进输入框、自动弹键盘；随后点一次发送箭头即可。
   之前 App 停在「插件详情」等页面时，点底部输入框永远点不中，会连续失败。
   指令按原样传，空格不再替换成 `%s`。
2. **设置页手机卡片不再误报「没看到手机」**：`buildStatusSafe().phone` 原来只有 `{adbPath, deviceName}`，
   而 `client.js` 读的是 `phone.adb.devices`；现在返回 `{...phoneInfo(), adbPath, deviceName}`，
   并给面板加了每 15 秒的静默刷新。

验证：ShareActivity 送指令后约 30 秒完成安装 + 首轮同步（手机 13 条记忆 / 60 文件）。
注意：每次安装会在手机上**新开一个对话**，旧对话可以手动删。

## v0.2.9 插件配置同步（pluginConfigs，2026-11-07 下午）

新增一个分类开关「插件配置（cordis）」，默认开：
- 数据源是宿主的 `configEditor`：`configuration()` 拿每个 entry 的 `override`，`edit(entry, fn)` 写回。
- 合并粒度是 **entry + 顶层 key** 的三方合并（base 存 `state.base.pluginConfigs`）：
  一边改取那一边；两边改成不同值就保留本机并记一条 `pluginConfig` 冲突；其余键照常同步。
- `DENY_KEY` 黑名单里的键（`pythonPath`、`adbPath`、`workspace`、`cwd`、`password`、`secret`、`token`、`apiKey`…）
  不参与同步；写回前用 `restoreDenied()` 把它们从本机原配置补回去，避免抹掉。
- 跳过本插件自己的 entry（`sync-fish` / `cyberrelic`），WebDAV 口令不会进快照。
- 实测：本机 215 个 entry，首轮只建 base（`applied: 0`），不改任何插件。
- 手机端还是 0.2.8，需要下一次「一键装」后其快照才带 pluginConfigs，桌面端才能拉到手机的设置。

## v0.3.0 朗读整合（2026-11-07 下午）

- 新增 `dsh-go-tts/`：手机端 dsh-go 朗读插件源码（composer.actions `read-latest` / `read-draft`、
  message.actions `read-message`、media `speech`），随主包分发，不再单独维护 `local-tts` 仓库。
- `lib/phone.js`：开启朗读时一键装会额外打包并推送 `local-tts.tar.gz`，让手机 agent
  `dsh plugin --profile web add /root/.dsh/dsh-go/plugins/local-tts`；配置里带 key/区域/音色/语速。
- 设置页新增「朗读」卡片：启用开关、Azure Key、区域、音色、语速、音高、每次最多字数。
- `read-latest` 直接读本机 DSH 会话日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，多帧 zstd 逐帧解），
  取最后一条 `assistant/message`；上限 400 字（免费层合成 400 字约 20 秒，更长会撞 30 秒媒体超时）。
- 真机验证（2026-11-07）：手机装 0.3.0 成功，`local-tts` 装好，两个胶囊都出现；
  `sync_now` 240 项插件配置、写回 4 项，只有一条 `agent-default-model.provider` 冲突（保留本机）。
- 协议限制：dsh-go 明确把「无点按自动触发」列为永不开放，所以只能做成「点一下读」。

## v0.3.2 免费朗读兜底（2026-11-07 傍晚）

- 用户要求：设置里保留 Azure Key 输入框与音色选择，但**没有 Key 时用免费兜底**。
- 免费音源：Edge 的 `speech.platform.bing.com` 已 403（带 Sec-MS-GEC 也不放行），改用
  百度翻译朗读 `GET https://fanyi.baidu.com/gettts?lan=zh&text=…&spd=…&per=4&source=web`
  （带 UA 与 `Referer: https://fanyi.baidu.com/`），返回 mpeg；`per=4` 是最接近「海星」的轻快女声。
- `dsh-go-tts/lib/index.js`：`rateToSpd()`（`+0%`→5，clamp 1–9）、`synthesizeFree()`；
  `synthesize()` 在没有 Key 或 `voice === 'free'` 时走免费源；`queue()` 不再要求 Key。
- 设置页音色改成下拉：免费兜底（默认）/ 晓爽 / 晓晓 / 晓伊 / 云希 / 云健 / 云夏 / 云扬；
  默认 `voice = hasKey ? 晓爽 : 'free'`。
- 本机实测免费链路：约 37KB mp3；手机实测点「读最新回复」后 **2 秒内** 创建 MediaPlayer（免费源比 Azure 快得多）。
- 手机 0.3.2 一键装 job 成功（`2026-11-07T07:55:37Z` 同步），两个朗读胶囊正常。


