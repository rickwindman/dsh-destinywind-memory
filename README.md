# dsh-destinywind-memory

在 DeepSeek Harness Web GUI 的设置面板中提供长期记忆库：**SQLite 存储、正文原样存取、不受 Markdown 语法影响**，并且用三层注入让 Agent 真的按记忆做事。

## 它做什么

- 设置面板新增「记忆」页（`settings.section` Slot，`order: 16`）：紧跟在设置导航的「插件」页之下、排在「技能」页之上；可添加（带可选标签）、浏览、删除记忆条目，也可点「刷新」重新读取。
- 记忆保存在一个 **SQLite 数据库**里（`memory.sqlite`），正文按原样存取：**写进去是什么，读出来就是什么**。
- 每条记忆注入**所有**会话的系统提示词。
- 纯插件实现：不修改 DSH 任何其他文件。

## 为什么是 SQLite 而不是 Markdown

v1 用 `memory.md` 保存，靠 `##` 标题划分条目。这带来一个**会静默损坏数据**的缺陷：

| 你写的正文 | v1 的后果 |
|---|---|
| 含一行以 `## ` 开头（如 `## 二级标题`） | 该条被**拆成两条**，标题被吞掉 |
| 含形如 `<!-- tags: x -->` 的注释 | 这一行的内容被当作**真标签**写回 |
| 含 `###`、列表、引用、代码围栏 | 在无标题的宽松解析下可能被**当成结构丢弃** |

数据库没有这个歧义：正文是一个不透明的值，任何解析器都不会再去解释它。所以从 v2 起改用 SQLite。

## 存储格式

`%USERPROFILE%\.dsh\destinywind-memory\memory.sqlite`（`DSH_HOME` 环境变量可覆盖）

```sql
CREATE TABLE memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- 条目 id，单调递增、删除后不复用
  title      TEXT NOT NULL DEFAULT '',           -- 摘要，缺省取正文首句
  text       TEXT NOT NULL,                      -- 正文，原样保存
  created_at TEXT NOT NULL DEFAULT (...)
) STRICT;

CREATE TABLE tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT    NOT NULL,
  position  INTEGER NOT NULL,                    -- 保留标签书写顺序
  PRIMARY KEY (memory_id, tag)
) STRICT;
```

- 数据库文件就是一个普通 SQLite 文件，可用任意 SQLite 客户端打开；运行中也可复制（WAL 模式下读不会阻塞写）。
- 上限：正文 8000 字符（超出截断）、标签最多 12 个、条目最多 1000。
- **不再有 Markdown 镜像文件。** `memory.md` 只作为升级迁移的输入读取一次，此后不再读写；升级时会改名为 `memory.md.v1.bak` 保留。

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

## 从 v1（Markdown / JSON）升级

v2 首次启动时会**自动导入**旧库，然后改名备份（不会丢记忆）：

| 旧位置 | 处理 |
|---|---|
| `destinywind-memory/memory.md`（v1.1） | 解析后导入 SQLite，原文件改名为 `memory.md.v1.bak` |
| `destinywind-memory/memory.json`（v1.0） | 导入，原文件改名为 `memory.json.v1.bak` |
| `hindsight-memory/memory.json`（更早的插件名） | 同样导入，原文件改名备份 |

迁移只执行一次，用 `.migrated-to-sqlite` 标记文件记录。若数据库里已有条目，则不会把遗留文件合并进来（避免重复）。旧文件解析失败时**原地保留**，不会在背后改名。三者都不存在时以空库启动，且**不会**创建任何文件，直到第一次写入。

> 注意：从 v1 的 `memory.md` 导入时，上述 `##` 缺陷**已经发生过的损坏无法自动还原**——被拆成两条的仍然是两条。导入后请检查一遍条目数是否符合预期。

## HTTP API（可选）

设置页用的就是这套接口；你也可以在脚本里调用。

| 操作 | 请求 |
|---|---|
| 列表 | `GET /dsh-destinywind-memory/memories` → `{ ok, memories: [{id,title,text,tags}], file }` |
| 新增 | `POST /dsh-destinywind-memory/memories`，body `{ text, title?, tags? }`（标题缺省取正文首句） |
| 删除 | `DELETE /dsh-destinywind-memory/memories/<id>`，`id` 是数据库主键 |

端口按实际运行的 DSH Web 端口填（不一定是 3080）：

```powershell
$port = 19387   # 换成你的实际端口
$body = @{ text = '记忆正文'; tags = @('标签') } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:$port/dsh-destinywind-memory/memories" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -ContentType 'application/json; charset=utf-8'
```

新增的条目 id 由数据库自增分配；已有条目的 id 不会因为新增或删除而改变。

## 推荐写法

记忆库会进入**每一个**对话的系统提示，越短越好：

1. 约束型信息（「必须／禁止」类）直接写清楚，一行一条，可带 `约束` 标签。
2. 长知识写成技能，记忆里只留一句索引；技能正文放 `%USERPROFILE%\.dsh\skills\<名字>\SKILL.md`。
3. 更大的资料放磁盘文档，记忆里只给路径。

## 文件

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半：SQLite 存储、旧库一次性迁移、HTTP 路由、系统提示词 section / 运行时上下文 / 末尾提醒 |
| `src/store-sqlite.js` | SQLite 存储层：建表、增删查、事务、WAL |
| `client.js` | Client 半：设置面板「记忆」页 UI |
| `cordis.patch.yml` | 把本插件插入 composition（含 `tailReminder` 配置示例） |
| `locale/zh.json`、`locale/en.json` | 插件元信息文案（中 / 英） |
| `icon.svg` | 插件图标（大脑剖面 + 记忆节点） |
| `tests/store-sqlite.test.mjs` | 存储层单测：特殊符号往返、id 语义、标签顺序、持久化 |
| `tests/memory-bank.test.mjs` | 端到端：迁移、HTTP API、三层注入 |

跑测试：

```powershell
node tests/store-sqlite.test.mjs
node tests/memory-bank.test.mjs
# 或
npm test
```

需要 **Node ≥ 22.5**（用到内置的 `node:sqlite`，无原生依赖）。

Host 侧改动（`index.js`、`src/`）**重启 `dsh web`** 生效；Client 侧改动（`client.js`）刷新页面（F5）即可。

## 安装与卸载

- 本插件声明了 `dsh.bundle.patch`，装完即生效。
- 从 GitHub 安装：`plugin_manager { action: "install_bundle", target: "<owner>/<repo>" }`，安装后重启 `dsh web`。
- 卸载**不会**删除已存记忆：内容在 `~/.dsh/destinywind-memory/memory.sqlite`，需要自行删除。

## 许可

MIT，见 [LICENSE](LICENSE)。
