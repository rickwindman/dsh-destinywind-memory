# dsh-destinywind-memory

在 DeepSeek Harness Web GUI 的设置面板中提供长期记忆库，并支持随时增删。

## 它做什么

- 设置面板新增「记忆」页（`settings.section` Slot，`order: 16`）：紧跟在设置导航的「插件」页之下、排在「技能」页之上；可添加（带可选标签）、浏览、删除记忆条目。
- 每条记忆跨会话持久保存于 `DSH_HOME/destinywind-memory/memory.json`，并**自动注入 Agent 系统提示词**（`systemPrompt.section`，`order: 216`）——即每个新对话开场就能看到。
- 纯插件实现：不修改 DSH 任何其他文件。

## 存储格式

`%USERPROFILE%\.dsh\destinywind-memory\memory.json`（`DSH_HOME` 环境变量可覆盖）

```json
{ "memories": [ { "id": "uuid", "text": "正文", "tags": ["标签"], "createdAt": 1699999999999 } ] }
```

上限：`text` 8000 字符（超出截断）、`tags` 最多 12 个、条目最多 1000；`text` 为空则拒绝写入。

## 从旧版 dsh-hindsight-memory 升级

- 新存储目录首次读取时若不存在，会**自动收养**旧目录 `~/.dsh/hindsight-memory/memory.json` 里的记忆并写入新位置；旧目录保留原样作为备份，确认无误后可自行删除。
- 若两者都不存在，则以空库启动。

## ⚠️ 改数据请走 HTTP API，不要直接改 json

Host 半是 `let cache = null`，**只读一次文件**：直接编辑 `memory.json`，运行中的进程看不到（要重启才生效）。API 会同时更新内存数组并原子落盘（tmp + rename），**立即生效**。

| 操作 | 请求 |
|---|---|
| 列表 | `GET /dsh-destinywind-memory/memories` |
| 新增 | `POST /dsh-destinywind-memory/memories`，body `{ text, tags }` |
| 删除 | `DELETE /dsh-destinywind-memory/memories/<id>` |

```powershell
$body = @{ text = '记忆正文'; tags = @('标签') } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:3080/dsh-destinywind-memory/memories' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -ContentType 'application/json; charset=utf-8'
```

## 渲染规则与推荐写法

`renderPrompt()` 会把每条 `text` 里的**所有空白压成一个空格**，每条渲染成一个 `- ` bullet，抬头固定为「## 长期记忆（destinywind memory bank）」。

所以：**写紧凑单段**，不要依赖换行、缩进或 markdown 结构。

推荐做法：**记忆只写一句话索引**（「需要 X 时加载技能 Y」），细节写成技能 —— 因为每条记忆都会进入**每一个**对话的系统提示，越短越好：

- 记忆条：`维护 dsh-connect-* 插件时，先加载技能 dsh-connect-plugins。`
- 技能正文：`C:\Users\raoke\.dsh\skills\dsh-connect-plugins\SKILL.md`（长文档放这里，按需加载）

## 文件

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半：存储、HTTP 路由、系统提示词 section |
| `client.js` | Client 半：设置面板「记忆」页 UI |
| `cordis.patch.yml` | 一行，把本插件插入 composition |
| `locale/zh.json`、`locale/en.json` | 插件元信息文案（中 / 英） |
| `icon.svg` | 插件图标（大脑剖面 + 记忆节点），显示在设置导航与插件列表中 |

Host 侧改动（`index.js`）**重启 `dsh web`** 生效；Client 侧改动（`client.js`）刷新页面（F5）即可。

## 安装与卸载

- 声明了 `dsh.bundle.patch`，装完即生效：`plugin_manager { action: "install_bundle", target: "<本仓库绝对路径>" }`，安装后重启 `dsh web`。
- 卸载**不会**删除已存记忆：内容在 `~/.dsh/destinywind-memory/memory.json`，需要自行删除。
- 若不希望某些条目继续注入对话，用 `DELETE /dsh-destinywind-memory/memories/<id>` 或设置页删除即可。

## 许可

MIT，见 [LICENSE](LICENSE)。
