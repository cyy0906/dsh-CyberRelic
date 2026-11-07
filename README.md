# 大肥鱼CyberRelic（dsh-CyberRelic）🐋

跨设备同步 DeepSeek Harness 的**鱼记忆**（dsh-fish-memory）、**习惯**（技能目录）、**插件设置**、**任务**和**工作区列表** —— 让几台电脑和手机上的 DSH Go 里，同一个鱼记得同样的事。

- 纯 JS、零原生依赖：Node 20+ / 安卓 PRoot 里都能跑
- 通道：本地同步文件夹（同步盘、U 盘都行）/ WebDAV（坚果云、Nextcloud、群晖、AList…）
- 有设置页：网盘邮箱、应用密码、分类开关、刷新间隔、加密口令都在页面里点，不用记命令
- 手机连 USB 可以**一键装到 DSH Go**（本机模式），装完自动跑第一轮
- 可选端到端加密：AES-256-GCM + scrypt，口令不落盘
- 记忆按 **id 逐条**合并（更新时间新的赢），删除用墓碑传播，不会「复活」
- 文件做**三方合并**：两台机都改了同一个文件 → 保留本地，远端另存成冲突副本
- 触发：启动后 8 秒 / 定时（默认 30 分钟）/ 新会话创建后去抖 120 秒 / 手动 `sync_now`

## 安装

从 GitHub 直接装：

```powershell
dsh plugin add github:cyy0906/dsh-CyberRelic
```

或者把发布包 `dsh-CyberRelic-0.2.4.zip` 解压到任意目录，用 `plugin_manager` 的
`install_bundle` 指向那个目录。装完重启 DSH（客户端设置页要等宿主重新加载 bundle 才出现）。

> 这是非官方插件，只通过 DSH 自带的扩展点工作，不包含 DSH 本体或商标素材。

## 设置页

装好并重启 DSH 后，打开 **设置 → 大肥鱼CyberRelic**，一页里能改完所有东西：

| 区块 | 内容 |
| --- | --- |
| 状态 | 本机设备名、上次同步时间、其它设备、全局记忆条数、冲突数；「立即同步」「刷新」「清冲突」 |
| 连接 | 通道类型；WebDAV 的**地址 / 邮箱 / 应用密码**（三个独立输入框，密码留空表示不改）/ 子目录；或本地文件夹路径；「保存并测试」 |
| 同步范围 | 记忆、习惯（技能）、插件设置、任务、工作区 —— 五个独立开关 |
| 节奏 | 同步间隔（分钟，0 = 只手动）、启动时同步、新会话去抖秒数 |
| 加密 | 口令（留空不改）、关闭加密 |
| 手机 | adb 状态、手机名、adb 路径、「一键装到手机」和实时日志 |

页面数据走本机接口 `/api/sync-fish/*`，只接受同源请求；密码/口令只写不回读。

## 同步哪些东西

| 分类 | 位置 | 默认 |
| --- | --- | --- |
| 记忆 | `~/.dsh/fish-memory/*.json` → 全局库 `~/.dsh/sync-fish/memory/global.json` | 开 |
| 习惯 | `~/.dsh/skills/**` | 开 |
| 插件设置 | `~/.dsh/*-config.json`、`~/.dsh/tts-bridge.json` | 开 |
| 插件配置 | 各插件在 cordis 里的设置（`configEditor` 读取），按 entry + key 三方合并 | 开 |
| 任务 | `~/.dsh/storages/schedule.json` | 开 |
| 工作区 | `~/.dsh/storages/workspace.json`（只合并列表，不带会话） | 关 |
| 额外 | 配置里的 `extraTargets`（`file` / `tree` / `glob`） | — |

`.credentials.yaml` 这类凭据文件永远不同步。插件配置里的机器相关/机密键（`pythonPath`、`adbPath`、`workspace`、`password`、`secret`、`token`、`apiKey`…）也不会跨机搬运。

## 为什么记忆要「全局库 + 注入」

dsh-fish-memory 默认一个会话一个库（`~/.dsh/fish-memory/<会话id>.json`），而两台机上不可能有同一个会话 id，所以：

1. 把本机所有会话库合并成一份全局库
2. 和别的设备的快照按 id 合并
3. 再把合并结果按 id 注回本机每个会话库；新会话创建时（`agent/created`）也会先注一遍

注入时**原样保留每个库的 `purgeEpoch`**（fish-memory 用它防旧任务写回被清空的库），新建库一律空串——跟它自己的 `blank()` 一致。

## 第一次使用

装好插件、重启 DSH，打开设置页填通道即可。也可以让 agent 调工具：

```
sync_setup channel=webdav url="https://dav.jianguoyun.com/dav/" username="you@example.com" password="应用密码" deviceName="书房电脑"
sync_setup channel=folder root="D:\\Sync\\dsh" deviceName="手机"
```

> 坚果云：地址填 `https://dav.jianguoyun.com/dav/`，密码用「设置 → 安全选项 → 第三方应用管理」里生成的**应用密码**（不是登录密码）。它不允许在 WebDAV 根目录直接建文件，快照都写在 `<remotePrefix>/` 里，插件会自己 MKCOL 建目录。

每台设备都配一次；WebDAV 填同一个地址，文件夹通道填各自看到的同步盘路径（可以不一样）。
想加密就每台都加同一个 `passphrase`——**设了之后，没口令的机器读不了已加密的快照**。

五个工具：

- `sync_now` —— 立刻同步一轮（`dryRun=true` 只演练）
- `sync_status` —— 通道是否连通、上次同步、冲突数、全局记忆条数、各分类开关
- `sync_conflicts` —— 看冲突记录（`clear=true` 清队列，磁盘副本不删）
- `sync_setup` —— 写入配置（也支持 `scopes` / `phoneName` / `adbPath` / `targets`）
- `sync_phone` —— 手机连 USB 时一键装到 DSH Go

配置文件：`$DSH_HOME/sync-fish/config.json`（设置页/工具写；也可以手改，改完下一轮生效）。
插件行 `cordis.patch.yml` 里的 `config` 会覆盖文件配置，但不会写回文件。

```json
{
  "version": 2,
  "enabled": true,
  "deviceName": "书房电脑",
  "channel": {
    "type": "webdav",
    "url": "https://dav.jianguoyun.com/dav/",
    "username": "you@example.com",
    "password": "应用密码",
    "prefix": ""
  },
  "passphrase": "",
  "intervalMinutes": 30,
  "syncOnStart": true,
  "debounceSeconds": 120,
  "remotePrefix": "dsh-sync-fish",
  "scopes": { "memory": true, "skills": true, "plugins": true, "tasks": true, "workspaces": false },
  "memory": { "injectExisting": true, "maxRecords": 5000 },
  "extraTargets": [],
  "phone": { "adbPath": "", "deviceName": "手机" }
}
```

## 通道里长什么样

远程目录名（`remotePrefix`）保持旧的 `dsh-sync-fish`，这样改名后老设备、老快照还能直接续上；
改名只影响插件显示名和包名，不影响已经同步出去的数据。

```
<通道根>/dsh-sync-fish/
  manifest.json               # 各设备最后活跃时间、记忆/文件条数
  devices/<deviceId>.json     # 每台机一份完整快照（记忆 + 文件文本），可选加密
```

只传文本文件；超过 2MB 的单个文件、超过 20MB 的总量会跳过并写进 `warnings`。
第一次同步时，本机的每个会话库都会先在本地被合并（不需要远端存在）。

## 冲突怎么处理

- **记忆**：按 `id` 取更新时间较新的一条；时间相同时用内容哈希比大小，保证两边收敛到同一条
- **文件**：三方合并（本地 / 远端 / 上次同步基线）
  - 只有一边改 → 用改的那边
  - 本地删了、远端还在 → 按远端恢复（记在 `restored` 里）
  - 两边都改 → 保留本地，远端内容写到 `$DSH_HOME/sync-fish/conflicts/<设备>/<时间>-<文件名>`，并记一条冲突
- **工作区**：只合并注册表，同 title/path 认作同一个；`sessionIds` 永远留本机

## 手机：USB 一键装到 DSH Go（本机模式）

DSH Go 的远程模式连的是电脑上的宿主，插件装在电脑侧即可，手机上不用装。
要让手机**脱离电脑自己跑**，就让它在本机模式下装一次本插件：

1. 手机上打开「开发者选项 → USB 调试」，插上 USB，弹窗点「允许」
2. 电脑上（设置页「手机」区块点一键装，或让 agent 调 `sync_phone`）
3. 插件会：打包 → `adb push` 到 `/sdcard/Download/` → 启动 App → 在 App 会话里让手机上的 agent
   解压到 `/root/.dsh/plugins/dsh-CyberRelic`、`plugin_manager install_bundle`、把配置写到
   `/root/.dsh/sync-fish/config.json`、重载插件并跑第一轮
4. 成功判据：云端 `manifest.json` 里出现手机那台设备（名字默认「手机」）

前提：电脑侧通道必须是 **WebDAV**（folder 路径对手机没意义），并且 `adb` 能在 PATH 或设置里指定的位置找到
（Windows 默认会找 `C:\Users\<你>\dsh-tools\platform-tools\adb.exe`、`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`）。

手机上源码是 `file:` 链接，改了文件要关掉再打开 `include:sync-fish` 才会重新加载（Node 的 ESM 缓存不随文件变化失效）。

## 安卓上的定时同步

安卓会杀后台，所以「到点自动同步」不可靠。插件仍然会在**启动后 8 秒**和**新会话创建后**尝试同步；
手机上更实际的是打开 DSH 后手动点一次 `sync_now`，或者把 `intervalMinutes` 设小一点（比如 10）。

## 不做的事

- 不同步会话历史（`~/.dsh/sessions`）—— 体积大、容易把别人的上下文带过来
- 不同步凭据（`.credentials.yaml`）和 `config.json` 里的口令
- 不合并 agent 预设 / 插件安装清单（宿主没有稳定的文件位置，版本一换就坏）

## 开发

```bash
node --check lib/index.js && node --check client.js
node --test test/sync.test.js test/plugin.test.js test/util.test.js test/config.test.js
```

测试用两个临时目录模拟两台机（切换 `DSH_HOME`），不碰真实数据；手机安装包的 tar 也在测试里验证。

## 兼容、归属与许可

- 本项目是独立实现，代码原创，以 **MIT** 发布；不包含、也不重新分发任何第三方插件的代码。
- 它通过**读取和写入数据文件**与 dsh-fish-memory 互操作（同一套 store 结构、遵守 `purgeEpoch` 守卫），
  这样鱼记忆才能跨设备合并。感谢 dsh-fish-memory 的作者 **Yuuyuko-uu** 做的插件和清楚的许可说明。
- 设置页用的是 DSH 自带的扩展点（`__ModuleLoader__` + `settings.section` 槽位、宿主 `webServer` 路由），
  没有修改宿主文件。
- 安装包里不包含 DSH 本体、DeepSeek 的商标素材或别人的文档；插件名只用来描述「兼容 DeepSeek Harness」，
  不代表官方或与官方有关联。
