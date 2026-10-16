# dsh-session-delete-plugin

给 **DeepSeek Harness** 的 Web GUI 侧边栏加一个「**删除对话**」动作：在某条对话的 `…` 菜单里
点它并确认后，插件会删掉该对话在**磁盘上的本地记录**（会话日志 + 列表缓存），
并**立即刷新列表**——不需要刷新页面，也不需要重启 App。

## 为什么需要它

Harness 自带的「归档」只是把对话从列表里隐藏，**数据仍然保留**；而它的会话持久化接口是
**只追加**的，官方没有提供删除能力：

> *"No deletion or retention API — pruning stored sessions is out-of-band backend maintenance."*
> — `@deepseek-ai/dsh-session-persistence`

> *"Nothing deletes session files — logs accumulate under `root` until removed externally."*
> — `@deepseek-ai/dsh-session-persistence-jsonl`

本插件补上这个能力，并把删除入口放进会话列表本身。

---

## 安装

```
dsh plugin --profile desktop add https://github.com/ksprider/dsh-session-delete-plugin
```

或在 GUI 里操作：**侧边栏 → 插件 → 安装**，把上面的地址粘进去。
安装完成后**重启 DeepSeek Harness**，宿主与页面会一起加载插件。

仓库根目录就是包的根目录（`package.json` 在最外层），因此直接使用仓库地址即可。

### 固定版本

直接给仓库地址安装的是**默认分支当前的 HEAD**。要固定版本，使用 tag 形式，例如：

```
dsh plugin --profile desktop add https://github.com/ksprider/dsh-session-delete-plugin#v1.0.0
```

> 可用的 git spec 写法取决于你的 DSH 版本，建议先自行验证一次。

### 本地目录安装（开发调试用）

```bash
dsh plugin --profile desktop add /绝对路径/dsh-session-delete-plugin
```

---

## 使用方式

1. 把鼠标移到左侧会话列表里目标对话上，点右侧出现的 `…`（更多）；
2. 选择「**删除对话**」（垃圾桶图标，红色文字）；
3. 在确认框里点「确定」；
4. 该条立刻从列表消失，**不需要重启**。

**正在打开的对话无法删除**：插件会拒绝并提示先归档或切换到其它对话。
正在运行的会话可能还在向日志追加内容，直接删除会造成数据丢失，因此这是刻意的保护。

---

## 它会删除什么

一条对话在磁盘上对应两处记录，插件会同时删除：

| 记录 | 路径 |
| --- | --- |
| 会话日志（含 `session.vN.jsonl.zstd`、`session.lock`） | `<DSH_HOME>/sessions/--<项目目录编码>--/<会话ID>/` |
| 列表标题缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<会话ID>.json` |

`<DSH_HOME>` 通常是 `~/.dsh`；若设置了 `DSH_HOME` 环境变量，则以该变量为准。

> ⚠️ **删除不可撤销。** 请确认目标对话后再操作。

### 安全边界

- 只操作 `<DSH_HOME>/sessions/` 下的目标会话目录，以及
  `<DSH_HOME>/storages/session_projcache/sessions/` 下的对应缓存文件；
- 待删除路径必须通过「是会话根目录的后代」校验，会话 ID 中出现路径分隔符会被直接拒绝；
- 正在打开的会话一律拒绝删除；
- 会话目录的命名规则（`projectKey` / `encodeSegment`）是从 Harness 自带实现逐字复刻的，
  并由「与宿主实现逐输入比对」的测试固定住。

---

## 兼容性

本插件依赖 Harness 的**未公开内部接口**，Harness 升级后可能失效：

| 依赖 | 来自 |
| --- | --- |
| 会话日志的目录命名规则 | `@deepseek-ai/dsh-session-persistence-jsonl` |
| slot 名 `sidebar.workspaces.session.menu.item` | `@deepseek-ai/dsh-client-ui-workspace` |
| 客户端模块表中的 `react` / `react/jsx-runtime` | Harness Web 前端 |
| 自建认证路由 `POST /api/dsh-session-delete` | 本插件 |

因此**升级 Harness 之后，请先运行测试**：`tests/verify-plugin.mjs` 会直接从已安装的
`app.asar` 中读取宿主的真实实现做逐输入比对，接口一旦变化它会立即失败。

---

## 测试

运行测试前需要先安装 DeepSeek Harness —— 多数用例会从 `app.asar` 里读取宿主的真实实现，
而不依赖 fixture。

macOS 上系统通常没有 `node`，可用 Harness 自带的（路径按你的安装位置调整）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"

$NODE --check index.js
$NODE --check client.js
$NODE tests/verify-plugin.mjs       # 路径推导与 Harness 自带实现逐输入比对
$NODE tests/verify-delete.mjs       # 删除行为（在临时目录里执行，不触碰真实数据）
$NODE tests/verify-route.mjs        # HTTP 路由往返（真实起服务 + fetch）
$NODE tests/verify-client.mjs       # 客户端半边（复刻浏览器模块表）+ 打包一致性检查
$NODE tests/verify-interaction.mjs  # 点击 → 确认 → 请求 → 刷新 → 关菜单 全流程
$NODE tests/verify-slot-ledger.mjs  # 用真实 slot 账本校验注册契约
```

### 命令行兜底工具

当插件不可用、或需要在不启动 GUI 的情况下查看/清理会话时使用
（同样使用 Harness 自带的 Python）：

```bash
PY=<harness 自带的 python3>
$PY tests/dsh-session-tool.py list
$PY tests/dsh-session-tool.py delete --title 某个标题
```

---

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` 声明补丁层，`dsh.client` 声明浏览器半边 |
| `cordis.patch.yml` | 向 profile 插入一行插件 |
| `index.js` | 宿主半边：删除逻辑 + 认证路由 `POST /api/dsh-session-delete` |
| `client.js` | 浏览器半边：在 `sidebar.workspaces.session.menu.item` slot 注册菜单项 |
| `locale/zh.json`、`locale/en.json` | 插件管理界面显示的标题与说明（可选元数据） |
| `LICENSE` | MIT |
| `tests/verify-plugin.mjs` | 路径推导与宿主实现逐输入比对（从已安装的 asar 读取宿主源码） |
| `tests/verify-delete.mjs` | 删除行为测试（临时目录，不触碰真实数据） |
| `tests/verify-route.mjs` | 用 `node:http` 真实起服务，用 `fetch` 打真实请求 |
| `tests/verify-client.mjs` | 复刻浏览器模块表执行 `client.js`，并校验打包一致性 |
| `tests/verify-interaction.mjs` | 点击全流程与取消 / 拒绝 / 网络失败三条异常路径 |
| `tests/verify-slot-ledger.mjs` | 用真实的 `@deepseek-ai/dsh-client-ui-slots` 作账本校验注册契约 |
| `tests/dsh-session-tool.py` | 命令行版会话列表 / 删除工具 |

---

## 卸载

```bash
dsh plugin --profile desktop remove @local/dsh-session-delete
```

或在 GUI 插件页中取消选择本 bundle，然后重启 App。

---

## 开发：重命名包名时要注意

`package.json` 的 `name`、`cordis.patch.yml` 中补丁行的 `name`、以及 `client.js` 中
`window.__ModuleLoader__.load({ id: ... })` 的 **id 三者必须完全一致**。

Harness 在把插件行解析到浏览器 bundle 时会比对包名，对不上就**不会加载浏览器半边**，
表现为 `…` 菜单中缺少「删除对话」这一项。

修改后请重新运行 `node tests/verify-client.mjs`：它会校验 id 与包名一致、
`cordis.patch.yml` 中确实插入了对应行、`dsh.client.platform` 与 `exports["./client"]` 齐备，
以及 `package.json` 里 `files` 声明的每个路径都真实存在。

---

## 已知限制

- 删除只移除磁盘记录。如果该对话曾被「归档」，其 ID 可能仍留在
  `<DSH_HOME>/storages/workspace.json` 的归档集合中（一个字符串，不影响列表显示）。
- **正在打开的对话不能删**，这是刻意的保护。
- 与所有 profile 插件一样：改动宿主半边（`index.js`）后需要**重启 App**；
  只改 `client.js` 时**重载一次页面**即可（插件资源按修订号长缓存）。

## 许可

[MIT](LICENSE)
