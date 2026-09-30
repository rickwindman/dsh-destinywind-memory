# dsh-destinywind-memory

在 DeepSeek Harness Web GUI 的设置面板中提供长期记忆库：**Markdown 存储、可直接编辑、保存即生效**，并且用三层注入让 Agent 真的按记忆做事。

## 它做什么

- 设置面板新增「记忆」页（`settings.section` Slot，`order: 16`）：紧跟在设置导航的「插件」页之下、排在「技能」页之上；可添加（带可选标签）、浏览、删除记忆条目，也可点「刷新」重新读取文件。
- 记忆保存在一个**人类可读的 Markdown 文件**里，插件按文件修改时间自动重载：用编辑器、别的 AI、脚本改这个文件都立即生效，**不需要重启、也不需要走 API**。
- ⚠️ 反过来，**Agent 自己改不了这个文件**：`DSH_HOME`（默认 `%USERPROFILE%\.dsh`）在工作区之外，DSH 沙箱拒绝 Agent 直接写；Agent 增删记忆**只能走 HTTP API**（见下）。你自己用编辑器改则不受影响。
- 每条记忆注入**所有**会话的系统提示词。
- 纯插件实现：不修改 DSH 任何其他文件。

## 存储格式

`%USERPROFILE%\.dsh\destinywind-memory\memory.md`（`DSH_HOME` 环境变量可覆盖）

```markdown
# 长期记忆库

> 本文件由 dsh-destinywind-memory 插件管理……

## 思考和回复必须使用中文
<!-- tags: 偏好 -->

思考和回复必须使用中文，禁止使用英文回复和思考。

## MCP github 读大文件报错
<!-- tags: github, 排错 -->

MCP github 读大文件报 embedded resource unsupported 时改 web_fetch 拉 raw……
```

规则：

- 每条记忆是一个 `##` 小节：**标题是摘要，正文是内容**。删除整个小节即删除该条记忆。
- 正文前可写 `<!-- tags: a, b -->` 声明标签（可选）。
- 宽容解析：**如果文件里没有任何 `##` 小节**（例如你直接把一份随手写的 Markdown 笔记丢进来），则每个 `-` 开头的列表项、或每个空行分隔的段落各算一条记忆；一级标题、`>` 引用块和 HTML 注释会被忽略。
- 上限：正文 8000 字符（超出截断）、标签最多 12 个、条目最多 1000。

## 为什么 Agent 会按记忆做事

一条「请参考」的软措辞埋在系统提示中段，是模型最容易跳过的东西。本插件把记忆注入三个位置：

| 位置 | 内容 | 作用 |
|---|---|---|
| 系统提示 `order: 216` | 全库，**拆成「硬性约束（必须遵守）」与「背景知识（相关时参考）」两组** | 让「必须做的事」不会被当成背景资料读过去 |
| 运行时上下文 `order: 100`（user 角色快照） | **只有硬性约束** | user 角色的短指令比 system 长段落更被遵循；每轮刷新且不堆积 |
| 系统提示 `order: 9999`（末尾） | 一行「记忆核对」提醒 | 利用末尾位置（recency），提示动手前自检 |

哪条算「硬性约束」由插件判定：**标签**含「约束／规则／偏好／规范／要求」（或 `constraint`），或**正文**含「必须／禁止／不要／不得／务必／一定要／只能／只用／都要／偏好／约束／规则／规范」等词。想强制归类，就加一个 `约束` 标签。

末尾提醒可以用配置关掉：

```yaml
config:
  tailReminder: false
```

## 从 v1（JSON）升级

第一次读取时若 `memory.md` 不存在，会自动把旧库迁移过来并**改名备份**，不会丢记忆：

| 旧位置 | 处理 |
|---|---|
| `destinywind-memory/memory.json`（v1 格式） | 迁移为 `memory.md`，原文件改名为 `memory.json.v1.bak` |
| `hindsight-memory/memory.json`（更早的插件名） | 同样迁移，原文件改名为 `memory.json.v1.bak` |

两者都不存在时，以空库启动，且**不会**创建任何文件，直到第一次写入。

## HTTP API（可选）

设置页用的就是这套接口；你也可以在脚本里调用。API 与手工编辑等价。

| 操作 | 请求 |
|---|---|
| 列表 | `GET /dsh-destinywind-memory/memories` → `{ ok, memories: [{id,title,text,tags}], file }` |
| 新增 | `POST /dsh-destinywind-memory/memories`，body `{ text, title?, tags? }`（标题缺省取正文首句） |
| 删除 | `DELETE /dsh-destinywind-memory/memories/<id>`，`id` 是该条在文件中的序号（从 1 开始） |

```powershell
$body = @{ text = '记忆正文'; tags = @('标签') } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:3080/dsh-destinywind-memory/memories' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -ContentType 'application/json; charset=utf-8'
```

新条目追加到文件末尾（已有的 `id` 不会被重新编号）。

## 推荐写法

记忆库会进入**每一个**对话的系统提示，越短越好：

1. 约束型信息（「必须／禁止」类）直接写清楚，一行一条，可带 `约束` 标签。
2. 长知识写成技能，记忆里只留一句索引：「需要 X 时加载技能 Y」；技能正文放 `%USERPROFILE%\.dsh\skills\<名字>\SKILL.md`。
3. 更大的资料放磁盘文档，记忆里只给路径。

## 文件

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半：Markdown 存储、HTTP 路由、系统提示词 section / 运行时上下文 / 末尾提醒 |
| `client.js` | Client 半：设置面板「记忆」页 UI |
| `cordis.patch.yml` | 把本插件插入 composition（含 `tailReminder` 配置示例） |
| `locale/zh.json`、`locale/en.json` | 插件元信息文案（中 / 英） |
| `icon.svg` | 插件图标（大脑剖面 + 记忆节点） |
| `tests/memory-bank.test.mjs` | 存储解析、迁移、HTTP API、三层注入的回归测试 |

跑测试：`node tests/memory-bank.test.mjs`

Host 侧改动（`index.js`）**重启 `dsh web`** 生效；Client 侧改动（`client.js`）刷新页面（F5）即可。

## 安装与卸载

- 声明了 `dsh.bundle.patch`，装完即生效：`plugin_manager { action: "install_bundle", target: "<本仓库绝对路径>" }`，安装后重启 `dsh web`。
- 卸载**不会**删除已存记忆：内容在 `~/.dsh/destinywind-memory/memory.md`，需要自行删除。
- 若不希望某些条目继续注入对话，删掉对应 `##` 小节，或用设置页 / API 删除。

## 许可

MIT，见 [LICENSE](LICENSE)。
