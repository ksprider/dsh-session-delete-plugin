# dsh-session-delete-plugin

给 **DeepSeek Harness** 的 Web GUI 侧边栏会话列表加一个「**删除对话**」动作：在某条对话的 `…`
菜单里点它并确认后，插件会删掉该对话在**磁盘上的全部本地记录**，并**立即刷新列表**——
不需要刷新页面，也不需要重启 App。

> 背景：DSH 自带的「归档」只是把对话从列表隐藏（数据保留），而它的持久化接口是**只追加**的，
> 官方没有删除 API（文档原文：*"No deletion or retention API"*、*"Nothing deletes session files"*）。
> 本插件补上这个能力：删除会话日志目录 + 列表缓存记录。

---

## 安装（从 GitHub）

在 DeepSeek Harness 里安装本仓库：

```
dsh plugin --profile desktop add https://github.com/ksprider/dsh-session-delete-plugin
```

或者用 GUI：**侧边栏 → 插件 → 安装**，把上面这个地址粘进去。安装完成后**重启 DeepSeek Harness**，
宿主与页面会一起加载插件。

**注意**：这个仓库的根目录就是包的根目录（`package.json` 在最外层），所以直接给仓库地址即可；
不要把包放进仓库的子目录里。

### 固定版本（建议）

直接给仓库地址装到的是**默认分支当时的 HEAD**。想固定版本，请使用 tag 或 commit 形式
（例如 `https://github.com/ksprider/dsh-session-delete-plugin#v1.0.0`）。
**具体写法以你所用的 DSH 版本为准**——不同安装器接受的 git spec 形式可能不同，
建议先在一台测试机上验证再教给别人。

### 本地目录安装（开发用）

```bash
dsh plugin --profile desktop add /绝对路径/dsh-session-delete-plugin
```

---

## 使用方式

1. 鼠标移到左侧会话列表里目标对话上，点右侧出现的 `…`（更多）；
2. 在菜单里选择「**删除对话**」（垃圾桶图标，红色文字）；
3. 弹出确认框，点「确定」；
4. 列表立刻少一条，**不需要重启**。

如果这条对话**当前正打开着**，插件会拒绝并提示：
「该对话仍处于打开状态，请先归档或切换到其它对话后再删除。」
—— 正在运行的会话可能还在往日志里追加内容，直接删除会丢数据。

---

## 它到底删了什么

一条对话在磁盘上有两处记录，插件会同时删掉：

| 记录 | 路径 |
| --- | --- |
| 会话日志（含 `session.vN.jsonl.zstd`、`session.lock`） | `<DSH_HOME>/sessions/--<项目目录编码>--/<会话ID>/` |
| 列表标题缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<会话ID>.json` |

`<DSH_HOME>` 通常是 `~/.dsh`（被 `DSH_HOME` 环境变量覆盖时以它为准）。
**删除不可撤销**，请确认后再点。

## 安全边界

- 只删除 `<DSH_HOME>/sessions/` 下的目标会话目录和
  `<DSH_HOME>/storages/session_projcache/sessions/` 下的对应缓存文件；
  路径必须通过「是会话根目录的后代」校验，会话 ID 里的路径分隔符会被直接拒绝。
- 正在打开的会话一律拒绝删除。
- 宿主侧的路径推导（`projectKey` / `encodeSegment`）是从 Harness 自带实现逐字复刻的，
  并用「与宿主实现逐输入比对」的测试固定住（见下）。

---

## 兼容性与升级注意

本插件依赖 Harness 的**未公开内部接口**，DSH 升级后可能失效：

- 会话日志的目录命名规则（来自 `@deepseek-ai/dsh-session-persistence-jsonl`）；
- slot 名 `sidebar.workspaces.session.menu.item`（来自 `@deepseek-ai/dsh-client-ui-workspace`）；
- 客户端模块表里的 `react` / `react/jsx-runtime`；
- 自建认证路由 `POST /api/dsh-session-delete`。

所以升级 DSH 之后，**请先跑一遍自检**：`tests/verify-plugin.mjs` 会直接从已安装的
`app.asar` 里读出宿主实现做逐输入比对，接口一变它立刻会红。

---

## 自检

需要 Node。macOS 上系统通常没有 `node`，可用 Harness 自带的：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
# 或：~/.dsh/dsh-runtimes/*/dependencies/node/bin/node

$NODE --check index.js
$NODE --check client.js
$NODE tests/verify-plugin.mjs       # 路径推导与 Harness 自带实现逐输入比对
$NODE tests/verify-delete.mjs       # 删除行为（临时目录，不碰真实数据）
$NODE tests/verify-route.mjs        # HTTP 路由往返（真实起服务 + fetch）
$NODE tests/verify-client.mjs       # 客户端半边（stub 浏览器模块表）
$NODE tests/verify-interaction.mjs  # 点击→确认→请求→刷新→关菜单 全流程
$NODE tests/verify-slot-ledger.mjs  # 用真实 slot 账本校验注册契约
```

这些测试需要**本机已安装 DeepSeek Harness**（多数用例会从 `app.asar` 里读宿主的真实实现）。

命令行兜底工具（插件装不上或 GUI 出问题时用）：

```bash
PY=~/.dsh/dsh-runtimes/*/dependencies/python/bin/python3
$PY tests/dsh-session-tool.py list
$PY tests/dsh-session-tool.py delete --title 某个标题
```

---

## 目录说明

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` 声明补丁层，`dsh.client` 声明浏览器半边 |
| `cordis.patch.yml` | 向 profile 插入一行插件 |
| `index.js` | 宿主半边：删除逻辑 + 认证路由 `POST /api/dsh-session-delete` |
| `client.js` | 浏览器半边：在 `sidebar.workspaces.session.menu.item` slot 注册菜单项 |
| `locale/zh.json`、`locale/en.json` | 插件管理界面里显示的标题与说明（可选元数据） |
| `LICENSE` | MIT |
| `tests/verify-plugin.mjs` | 路径推导与宿主实现逐输入比对（直接从已安装的 Harness asar 里读宿主源码） |
| `tests/verify-delete.mjs` | 删除行为测试（在临时目录里跑，不碰真实数据） |
| `tests/verify-route.mjs` | 把插件注册的路由用 `node:http` 真实起服务，用 `fetch` 打真实请求 |
| `tests/verify-client.mjs` | 复刻浏览器模块表执行 `client.js`，验证 slot 注册、词典与渲染 |
| `tests/verify-interaction.mjs` | 有状态 React 替身，跑通点击全流程与三条异常路径 |
| `tests/verify-slot-ledger.mjs` | 用真实的 `@deepseek-ai/dsh-client-ui-slots` 当账本校验注册契约 |
| `tests/dsh-session-tool.py` | 命令行版会话列表/删除工具（插件不可用时的兜底） |

---

## 改包名要注意（重要的坑）

`package.json` 的 `name`、`cordis.patch.yml` 里补丁行的 `name`、以及 `client.js` 里
`window.__ModuleLoader__.load({ id: ... })` 的 **id 三者必须完全一致**。
Harness 把插件行解析到浏览器 bundle 时会比对包名，对不上就**不会加载浏览器半边**
（表现：`…` 菜单里没有「删除对话」这一项）。

想把包名从 `@local/dsh-session-delete` 改成自己的（例如 `@yourname/dsh-session-delete`），
需要同时改这三处，然后重跑 `node tests/verify-client.mjs`（它会校验 id 与包名一致、且
`package.json` 里所有 `files` 都存在）。

---

## 卸载

```bash
dsh plugin --profile desktop remove @local/dsh-session-delete
```

或在 GUI 的插件页里取消选择本 bundle，然后重启 App。

---

## 已知限制

- 删除只移除磁盘记录；如果该对话曾被「归档」，它的 ID 可能仍留在
  `~/.dsh/storages/workspace.json` 的归档集合里（一个字符串，不影响列表显示）。
- **正在打开的对话不能删**（会提示先归档或切换），这是刻意的保护。
- 与所有 profile 插件一样，安装/升级宿主半边后需要**重启 App** 才会加载新代码；
  只改了 `client.js` 的话，**重载一次页面**即可（插件资源按修订号长缓存）。
- 仅在 macOS 版 DeepSeek Harness 上验证过；其他平台理论上可用但未实测。

## 许可

MIT，见 [LICENSE](LICENSE)。
