# DBX packages 目录源码分析

## 1. 模块概述

`packages/` 目录包含 DBX 的 **Node.js 工具链层**，提供独立于 Rust 后端和 Vue 前端的第三套技术栈。包含 5 个子包：

| 包名 | npm 名称 | 代码量 | 职责 |
|------|----------|--------|------|
| `node-core` | `@dbx-app/node-core` | 15 个 .ts 文件，~4,500 行 | 共享核心库：数据库直连、连接管理、SQL 安全、Redis 命令解析 |
| `cli` | `@dbx-app/cli` | 2 个 .ts 文件，~470 行 | 命令行工具：终端查询数据库 |
| `mcp-server` | `@dbx-app/mcp-server` | 1 个 .ts 文件，~536 行 | MCP 服务器：让 AI Agent 查询数据库 |
| `app-tests` | (内部) | ~240 个 .test.ts 文件 | 前端应用级集成测试 |
| `test-globals.ts` | (内部) | 3 行 | 测试全局配置（时区） |

## 2. 目录结构

```
packages/
├── node-core/                       # 共享 Node.js 核心库
│   ├── package.json
│   └── src/
│       ├── index.ts                 # 模块入口，统一导出
│       ├── backend.ts               # Backend 接口抽象 + 工厂函数(38行)
│       ├── web-backend.ts           # Web 模式后端：通过 HTTP 调用 dbx-web(435行)
│       ├── bridge.ts                # Bridge 通信：与运行中的 DBX 桌面版交互(26行)
│       ├── connections.ts           # 连接管理：读取/写入 DBX SQLite 存储(377行)
│       ├── database.ts              # 数据库直连引擎：PG/MySQL/SQLite/Redis/MongoDB(1857行)
│       ├── diagnostics.ts           # 环境诊断工具(133行)
│       ├── entrypoint.ts            # 入口点工具
│       ├── format.ts                # 格式化输出
│       ├── paths.ts                 # 跨平台路径管理(36行)
│       ├── production-safety.ts     # 生产数据库安全评估(315行)
│       ├── redis-command.ts         # Redis 命令解析与安全分类(214行)
│       ├── schema-context.ts        # Schema 上下文构建(67行)
│       ├── sql-risk.ts              # SQL 风险分类引擎(235行)
│       └── sql-safety.ts            # SQL 安全评估策略(187行)
│
├── cli/                             # 命令行工具
│   ├── package.json
│   └── src/
│       ├── cli.ts                   # CLI 主逻辑(410行)
│       └── cli-format.ts            # 输出格式化：表格/CSV/JSON(62行)
│
├── mcp-server/                      # MCP 服务器
│   ├── package.json
│   └── src/
│       └── index.ts                 # MCP 服务器完整实现(536行)
│
├── app-tests/                       # 前端集成测试(~240 文件)
│   ├── dataGridEditor.test.ts       # DataGrid 编辑器测试(1623行)
│   ├── connectionStoreErrorState.test.ts  # 连接 Store 错误状态(550行)
│   ├── connectionUrl.test.ts        # 连接 URL 解析(496行)
│   └── ...                          # 其他 ~237 个测试文件
│
└── test-globals.ts                  # 测试全局配置(TZ=Asia/Shanghai)
```

## 3. 架构总览

```
┌───────────────────────────────────────────────────────────┐
│                      调用方                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐    │
│  │ 终端用户 │  │ AI Agent │  │ 前端 Vue 测试套件    │    │
│  │ (CLI)    │  │ (MCP)    │  │ (vitest)             │    │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘    │
│       │              │                   │                │
│       ▼              ▼                   ▼                │
│  ┌─────────┐   ┌──────────┐     ┌──────────────┐        │
│  │  cli    │   │mcp-server│     │  app-tests   │        │
│  │ (410行) │   │ (536行)  │     │ (~240 文件)  │        │
│  └────┬────┘   └────┬─────┘     └──────────────┘        │
│       │              │                                    │
│       ▼              ▼                                    │
│  ┌─────────────────────────────────────────────────┐     │
│  │          node-core (共享核心库)                   │     │
│  │                                                   │     │
│  │  ┌─────────────┐  ┌──────────────────────────┐  │     │
│  │  │ Backend     │  │ 数据库直连引擎            │  │     │
│  │  │ 接口抽象    │  │ database.ts (1857行)     │  │     │
│  │  │ backend.ts  │  │  ├─ PostgreSQL (pg)      │  │     │
│  │  │             │  │  ├─ MySQL (mysql2)       │  │     │
│  │  │ ┌─────────┐ │  │  ├─ SQLite (better-sql) │  │     │
│  │  │ │Desktop  │ │  │  ├─ Redis (ioredis)     │  │     │
│  │  │ │Backend  │ │  │  └─ MongoDB (HTTP API)  │  │     │
│  │  │ │(直连DB) │ │  │                          │  │     │
│  │  │ └─────────┘ │  │ 连接管理                 │  │     │
│  │  │ ┌─────────┐ │  │ connections.ts           │  │     │
│  │  │ │Web      │ │  │  ├─ 读取 DBX SQLite    │  │     │
│  │  │ │Backend  │ │  │  ├─ 密码/密钥解密       │  │     │
│  │  │ │(HTTP)   │ │  │  └─ 传输层配置还原      │  │     │
│  │  │ └─────────┘ │  │                          │  │     │
│  │  │ ┌─────────┐ │  │ 安全策略                 │  │     │
│  │  │ │Bridge   │ │  │  ├─ sql-risk.ts        │  │     │
│  │  │ │(桌面IPC)│ │  │  ├─ sql-safety.ts      │  │     │
│  │  │ └─────────┘ │  │  ├─ production-safety  │  │     │
│  │  └─────────────┘  │  └─ redis-command.ts   │  │     │
│  │                    └──────────────────────────┘  │     │
│  └───────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────┘
```

## 4. node-core — 共享核心库

### 4.1 Backend 接口抽象 (backend.ts)

`Backend` 是所有后端的统一接口，CLI 和 MCP Server 都通过这个接口操作数据库：

```typescript
export interface Backend {
  loadConnections(): Promise<ConnectionConfig[]>;
  findConnection(name: string): Promise<ConnectionConfig | undefined>;
  addConnection(config): Promise<ConnectionConfig>;
  removeConnection(name: string): Promise<boolean>;
  listTables(config, schema?): Promise<TableInfo[]>;
  describeTable(config, table, schema?): Promise<ColumnInfo[]>;
  executeQuery(config, sql, options?): Promise<QueryResult>;
  executeRedisCommand?(config, db, command, options?): Promise<RedisCommandResult>;
  close?(): Promise<void>;
}
```

`createBackend()` 工厂函数根据环境选择后端实现：

```
createBackend(env)
  ├─ env.DBX_WEB_URL 存在 → WebBackend (HTTP 模式)
  └─ 否则 → DesktopBackend (直连 SQLite + 原生驱动)
```

### 4.2 双后端实现

#### DesktopBackend（直连模式）

直接读取 DBX 桌面版的 SQLite 数据库文件获取连接配置，使用 Node.js 原生驱动连接数据库：

- **连接存储**：`better-sqlite3` 读取 `dbx.db`
- **PostgreSQL**：`pg` 库，连接池 max=3
- **MySQL**：`mysql2/promise`，连接池 limit=3
- **SQLite**：`better-sqlite3`
- **Redis**：`ioredis`（仅 standalone 模式，无 SSH 隧道时）
- **MongoDB**：通过 HTTP API 调用

#### WebBackend (web-backend.ts, 435行)

通过 HTTP 调用运行中的 `dbx-web` 服务：

- 自动认证：检测 `DBX_WEB_PASSWORD`，登录获取 Session Cookie
- 401 自动重试：Session 过期时重新登录
- 支持所有数据库类型（通过 dbx-web 的 Rust 后端）
- MongoDB Shell 命令解析与路由

### 4.3 数据库直连引擎 (database.ts, 1857行)

这是 node-core 最大的文件，实现了 Node.js 侧的数据库直连能力：

#### 连接池管理

```typescript
// 全局连接池注册表，按 connectionId:database 键控
const pools = new Map<string, PoolEntry>();
// 空闲超时 5 分钟自动释放
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// 查询超时 30 秒
const QUERY_TIMEOUT_MS = 30_000;
// 最大返回行数 100
const MAX_ROWS = 100;
```

#### 代理隧道支持

实现了完整的 SOCKS5 和 HTTP CONNECT 代理隧道：

```
Node.js 进程
  │
  ├─ PostgreSQL 连接 → 本地端口 → SOCKS5/HTTP 代理 → 目标数据库
  ├─ MySQL 连接     → 本地端口 → SOCKS5/HTTP 代理 → 目标数据库
  └─ ...
```

- `connectionEndpoint()` — 检查是否有代理层，有则创建本地 TCP 代理服务器
- `socks5Connect()` — SOCKS5 握手 + 可选认证
- `httpConnect()` — HTTP CONNECT 隧道 + Basic 认证

#### 数据库类型路由

```
executeQuery(config, sql)
  ├─ PostgreSQL 系 (postgres/redshift/gaussdb/kwdb/opengauss/questdb)
  │   └─ pg Pool → information_schema 查询
  ├─ MySQL 系 (mysql/doris/starrocks/manticoresearch)
  │   └─ mysql2 Pool → information_schema 查询
  ├─ SQLite → better-sqlite3 直连
  ├─ rqlite → HTTP API
  ├─ Cloudflare D1 → HTTP API (需 Bridge)
  ├─ Redis → ioredis (standalone 无隧道)
  ├─ MongoDB → HTTP API (需 Bridge)
  └─ 其他 50+ 种 → Bridge 模式 (需 DBX 桌面版运行)
```

#### Bridge 模式

对于没有 Node.js 原生驱动的数据库类型（如 Oracle、SQL Server、Elasticsearch 等 50+ 种），需要 DBX 桌面版运行，通过本地 HTTP 端口文件通信：

```typescript
// 读取 DBX 桌面版写入的端口文件
const port = await readFile(bridgePortFilePath(), "utf-8");
// 向桌面版发送 HTTP 请求
const res = await fetch(`http://127.0.0.1:${port}/execute-query`, { ... });
```

### 4.4 连接管理 (connections.ts, 377行)

直接读取 DBX 桌面版的 SQLite 存储文件：

#### 核心功能

| 函数 | 说明 |
|------|------|
| `loadConnections()` | 从 `dbx.db` 读取所有连接配置 |
| `findConnection(name)` | 按名称查找连接（大小写不敏感） |
| `addConnection(config)` | 写入新连接 + 加密密码到 `connection_secrets` |
| `removeConnection(name)` | 删除连接及其密钥 |
| `inspectConnectionStore()` | 诊断连接存储状态 |

#### 密钥还原

连接密码和隧道密码存储在 `connection_secrets` 表中，按 `connection_id + key` 关联：

```
connections 表          connection_secrets 表
┌────────────┐         ┌─────────────────────────────────┐
│ id         │◄────────│ connection_id                   │
│ config_json│         │ key: "password"                 │
└────────────┘         │ secret: (明文)                  │
                       ├─────────────────────────────────┤
                       │ key: "transport_layers.X.ssh_   │
                       │       password"                 │
                       │ secret: (SSH 密码)              │
                       ├─────────────────────────────────┤
                       │ key: "redis_sentinel_password"  │
                       │ secret: (Sentinel 密码)         │
                       └─────────────────────────────────┘
```

#### 传输层配置还原

支持从旧版扁平 SSH 配置迁移到新版 `transport_layers` 数组：

```typescript
// 旧版字段: ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_password...
// 新版字段: transport_layers: [{ type: "ssh", ... }, { type: "proxy", ... }]
normalizeTransportLayers(config) // 自动兼容旧版格式
```

### 4.5 SQL 安全体系

#### sql-risk.ts — SQL 风险分类引擎 (235行)

将 SQL 语句分类为 5 个风险等级：

```typescript
type SqlRiskLevel = "read" | "write" | "ddl" | "transaction" | "unknown";
```

分类规则：

| 风险等级 | 关键词 |
|----------|--------|
| `read` | SELECT, SHOW, DESCRIBE, VALUES, TABLE |
| `write` | INSERT, UPDATE, DELETE, MERGE, REPLACE, UPSERT, LOAD, CALL, EXEC, FLUSH |
| `ddl` | CREATE, ALTER, DROP, TRUNCATE, RENAME, GRANT, REVOKE, DENY, COMMENT, REINDEX, VACUUM, OPTIMIZE |
| `transaction` | BEGIN, START, COMMIT, ROLLBACK, ABORT, SAVEPOINT, RELEASE |
| `unknown` | 其他无法识别的语句 |

特殊处理：
- `EXPLAIN` / `EXPLAIN ANALYZE` — 递归分析内部语句
- `COPY ... FROM` — 归类为 write
- `COPY ... TO` — 归类为 read
- `SELECT ... INTO` — 归类为 write
- `PRAGMA` — 安全的只读 PRAGMA 为 read，其他为 write
- `WITH` (CTE) — 取内部最高风险

SQL 文本清理：`sqlSafetyText()` 去除注释、字符串字面量，保留标识符，防止误判。

#### sql-safety.ts — SQL 安全策略 (187行)

基于风险分类做出允许/拒绝决策：

```typescript
evaluateSqlSafety(sql, options): SqlSafetyDecision
  ├─ 空 SQL → 拒绝
  ├─ 多语句且不允许 → 拒绝
  ├─ DDL/transaction/unknown 且 allowDangerous=false → 拒绝
  ├─ 写操作且 allowWrites=false → 拒绝
  ├─ UPDATE/DELETE 无 WHERE 且 allowDangerous=false → 拒绝
  └─ 通过 → 允许
```

环境变量控制：
- `DBX_MCP_ALLOW_WRITES=1` — 允许写操作
- `DBX_MCP_ALLOW_DANGEROUS_SQL=1` — 允许 DDL 等危险操作

#### splitSqlStatements() — 多语句分割

完整的 SQL 状态机解析器，正确处理：
- 单引号/双引号/反引号/方括号字符串
- 行注释 (`--`, `#`)
- 块注释 (`/* */`)
- PostgreSQL 美元引用 (`$$...$$`, `$tag$...$tag$`)
- 转义字符

### 4.6 生产安全 (production-safety.ts, 315行)

检测 SQL 是否针对标记为"生产"的数据库执行写操作：

```typescript
assessProductionSql(sql, config, activeDatabase): ProductionSqlAssessment
  ├─ 连接标记 is_production=true → 所有写操作都是生产操作
  ├─ 数据库在 production_databases 列表中 → 该库的写操作是生产操作
  ├─ USE 语句切换到生产库 → 后续写操作是生产操作
  ├─ database.table 限定引用生产库 → 该语句是生产操作
  └─ 无法确定目标 → 保守标记为不确定
```

支持 65+ 种数据库类型的限定名解析规则：
- 三段式 (`database.schema.table`)：SQL Server, Snowflake, Trino, Databricks, BigQuery
- Schema 优先 (`schema.table`)：PostgreSQL, Oracle, Dameng 等 30+ 种
- 数据库优先 (`database.table`)：MySQL 等

### 4.7 Redis 命令安全 (redis-command.ts, 214行)

将 Redis 命令分为 4 个安全级别：

| 级别 | 命令示例 | 说明 |
|------|----------|------|
| `allowed` | GET, SETNX, HGET, INFO, DBSIZE | 只读或安全操作 |
| `write` | SET, HSET, LPUSH, SADD, ZADD, XADD | 写操作 |
| `confirm` | DEL, EXPIRE, RENAME, FLUSHDB | 需确认的危险操作 |
| `blocked` | KEYS, FLUSHALL, SHUTDOWN, CONFIG, EVAL | 默认阻止的极危险命令 |

`parseRedisCommandArgv()` — 完整的 Redis 命令参数解析器，支持引号、转义字符。

### 4.8 路径管理 (paths.ts)

跨平台数据目录定位，与 Rust 侧 `data_dir.rs` 保持一致：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/com.dbx.app/` |
| Windows | `%APPDATA%/com.dbx.app/` |
| Linux | `~/.local/share/com.dbx.app/` |
| 环境变量 | `DBX_DATA_DIR` 覆盖所有默认值 |

关键文件：
- `dbx.db` — SQLite 数据库
- `mcp-bridge-port` — Bridge 端口号文件

### 4.9 Schema 上下文 (schema-context.ts)

为 AI Agent 构建紧凑的数据库 Schema 上下文：

```typescript
buildSchemaContext(backend, config, options): SchemaContext
  ├─ 列出可用表
  ├─ 按请求筛选或取前 N 个 (默认 8，最大 20)
  ├─ 并行获取每个表的列定义
  └─ 返回结构化上下文
```

`formatSchemaContext()` — 格式化为 Markdown 文本，供 AI 理解数据库结构。

### 4.10 诊断工具 (diagnostics.ts)

```typescript
getDbxDiagnostics(): DbxDiagnostics
  ├─ 数据目录路径
  ├─ SQLite 数据库状态
  ├─ 连接表/密钥表存在性
  ├─ 连接加载结果
  ├─ Bridge 端口文件状态
  ├─ 直连支持的数据库类型列表
  └─ 需要 Bridge 的数据库类型列表
```

数据库类型分类：
- **直连类型** (10种)：postgres, redshift, mysql, doris, starrocks, manticoresearch, sqlite, rqlite, kwdb, questdb
- **Bridge 类型** (50+种)：其余所有需要 DBX 桌面版运行的类型

## 5. cli — 命令行工具

### 5.1 命令结构

```
dbx <command> [args] [options]

命令:
  query <connection> <sql>       # 执行 SQL 查询
  schema list <connection>       # 列出表
  schema describe <conn> <table> # 描述表结构
  connections list               # 列出连接
  context <connection>           # 获取 Schema 上下文(AI 用)
  doctor                         # 环境诊断
  capabilities                   # 列出支持的数据库类型
  open <connection> <table>      # 在 DBX 桌面版中打开表

选项:
  --format table|json|csv        # 输出格式
  --schema <name>                # Schema 名称
  --database <name>              # 数据库名称
  --tables <t1,t2>               # 指定表名
  --max-tables <n>               # 最大表数
  --max-rows <n>                 # 最大行数
  --timeout-ms <n>               # 超时毫秒
  --file <path>                  # 从文件读取 SQL
  --allow-writes                 # 允许写操作
  --allow-dangerous              # 允许危险 SQL
  --json                         # JSON 输出
  --version                      # 版本号
  --help                         # 帮助
```

### 5.2 执行流程

```
runCli(argv, options)
  │
  ├─ 解析参数和标志
  ├─ 创建 Backend (createBackend)
  │
  ├─ doctor → getDbxDiagnostics() → 格式化输出
  ├─ capabilities → 列出直连/Bridge 类型
  ├─ connections list → backend.loadConnections() → 格式化
  ├─ schema list → backend.listTables() → 格式化
  ├─ schema describe → backend.describeTable() → 格式化
  ├─ query →
  │   ├─ SQL 安全检查 (evaluateSqlSafety)
  │   ├─ backend.executeQuery()
  │   └─ 格式化输出 (table/json/csv)
  ├─ context → buildSchemaContext() → formatSchemaContext()
  └─ open → postBridge("/open-table") → 通知桌面版
```

### 5.3 环境变量

| 变量 | 说明 |
|------|------|
| `DBX_CONNECTION` | 默认连接名 |
| `DBX_MCP_ALLOW_WRITES` | 允许写操作 |
| `DBX_MCP_ALLOW_DANGEROUS_SQL` | 允许危险 SQL |
| `DBX_DATA_DIR` | 数据目录覆盖 |
| `DBX_WEB_URL` | Web 模式 URL（设置后使用 WebBackend） |
| `DBX_WEB_PASSWORD` | Web 模式密码 |

## 6. mcp-server — MCP 服务器

### 6.1 概述

MCP (Model Context Protocol) 服务器让 AI Agent（Claude Code、Cursor 等）通过标准协议直接查询数据库。基于 `@modelcontextprotocol/sdk`，通过 stdio 传输通信。

### 6.2 暴露的 MCP 工具

| 工具名 | 说明 | 条件 |
|--------|------|------|
| `dbx_list_connections` | 列出所有数据库连接 | 始终可用 |
| `dbx_list_tables` | 列出表/视图 | 始终可用 |
| `dbx_describe_table` | 获取列定义 | 始终可用 |
| `dbx_execute_query` | 执行 SQL 查询 (max 100行) | 始终可用 |
| `dbx_execute_redis_command` | 执行 Redis 命令 | 始终可用 |
| `dbx_get_schema_context` | 获取紧凑 Schema 上下文 | 始终可用 |
| `dbx_add_connection` | 添加新连接 | 非 scope 模式 |
| `dbx_remove_connection` | 删除连接 | 非 scope 模式 |
| `dbx_open_table` | 在桌面版中打开表 | 桌面模式 |
| `dbx_execute_and_show` | 在桌面版中执行并展示 | 桌面模式 |

### 6.3 安全机制

MCP 服务器实现了多层安全防护：

```
AI Agent 请求
  │
  ├─ 1. SQL 风险评估 (evaluateSqlSafety)
  │     ├─ DDL/transaction → 默认阻止
  │     ├─ 写操作 → 需要 DBX_MCP_ALLOW_WRITES=1
  │     └─ UPDATE/DELETE 无 WHERE → 需要 DBX_MCP_ALLOW_DANGEROUS_SQL=1
  │
  ├─ 2. 生产数据库保护 (assessProductionSql)
  │     └─ 生产库的写操作 → 始终阻止 (返回 SQL 让用户在桌面版执行)
  │
  ├─ 3. Redis 命令安全 (evaluateRedisCommandSafety)
  │     ├─ blocked 命令 → 默认阻止
  │     ├─ write/confirm → 需要 allowWrites
  │     └─ 生产库的非只读命令 → 阻止
  │
  ├─ 4. MongoDB 安全
  │     ├─ 写操作检测 (isLikelyMongoMutation)
  │     └─ 生产库写操作 → 阻止
  │
  └─ 5. Scope 隔离
        ├─ DBX_MCP_SCOPE_CONNECTION_ID — 限定连接 ID
        └─ DBX_MCP_SCOPE_CONNECTION_NAME — 限定连接名
```

### 6.4 Scope 模式

通过环境变量限制 MCP 服务器可访问的连接范围：

```bash
# 只允许访问特定连接
DBX_MCP_SCOPE_CONNECTION_ID=uuid dbx-mcp-server
DBX_MCP_SCOPE_CONNECTION_NAME=mydb dbx-mcp-server

# 限定数据库
DBX_MCP_SCOPE_DATABASE=production dbx-mcp-server
```

Scope 模式下：
- `dbx_add_connection` 和 `dbx_remove_connection` 不可用
- 连接解析会验证请求的连接在 scope 范围内
- 超出 scope 的连接返回 `CONNECTION_OUT_OF_SCOPE` 错误

### 6.5 Web 模式 vs 桌面模式

```
DBX_WEB_URL 存在 → Web 模式
  ├─ 通过 HTTP 调用 dbx-web
  ├─ 自动认证 (DBX_WEB_PASSWORD)
  └─ 无 dbx_open_table / dbx_execute_and_show

DBX_WEB_URL 不存在 → 桌面模式
  ├─ 直连数据库 (node-core)
  ├─ Bridge 通信 (mcp-bridge-port 文件)
  └─ 有 dbx_open_table / dbx_execute_and_show
```

### 6.6 MongoDB Shell 命令支持

MCP 服务器支持 MongoDB Shell 风格的命令语法：

```javascript
db.projects.find({}).limit(100)
db.version()
db.projects.countDocuments({})
db.projects.getIndexes()
db.projects.stats()
db.projects.createIndex({...})
db.projects.insertOne({...})
db.projects.updateOne({...}, {$set: {...}})
db.projects.deleteOne({...})
db.projects.drop()
```

## 7. app-tests — 前端集成测试

### 7.1 概述

~240 个测试文件，使用 vitest 框架，覆盖前端核心功能。测试文件命名规范：`<功能名>.test.ts`。

### 7.2 测试覆盖分类

| 分类 | 文件数 | 示例 |
|------|--------|------|
| DataGrid | ~25 | editor(1623行), sort, filter, pagination, selection, transpose |
| AI | ~12 | prompt, agent plan, schema comments, SQL execution policy |
| 连接管理 | ~10 | store error state(550行), URL(496行), clipboard, deep link |
| Schema 浏览 | ~8 | tree, search, capabilities, DDL export |
| 导出/导入 | ~8 | formats, database export plan, table import |
| Redis | ~5 | command parsing, pubsub |
| MongoDB | ~5 | document store, GridFS |
| 编辑器 | ~6 | CodeMirror SQL dialect, brackets, settings |
| 其他 | ~160+ | ER 图, 字段血缘, 历史, 配置加密, 二进制查看等 |

### 7.3 测试配置

- 全局时区：`Asia/Shanghai`（test-globals.ts）
- 测试框架：vitest
- 配置文件：根目录 `vitest.config.ts`

## 8. 依赖分析

### 8.1 node-core 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `better-sqlite3` | ^12.9.0 | SQLite 直连（读取 DBX 存储） |
| `pg` | ^8.16.0 | PostgreSQL 直连 |
| `mysql2` | ^3.14.1 | MySQL 直连 |
| `ioredis` | ^5.11.1 | Redis 直连 |
| `keytar` | ^7.9.0 | 系统密钥链访问 |

### 8.2 cli 依赖

| 依赖 | 用途 |
|------|------|
| `@dbx-app/node-core` | 共享核心库 |
| `tsx` | TypeScript 执行 |
| `typescript` | 类型检查 |

### 8.3 mcp-server 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@dbx-app/node-core` | workspace:^ | 共享核心库 |
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP 协议 SDK |
| `zod` | ^3.25.20 | 参数校验 Schema |

## 9. 关键设计模式

### 9.1 Backend 抽象

`Backend` 接口统一了三种运行模式：
- **Desktop**：直连 SQLite + 原生驱动
- **Web**：HTTP 调用 dbx-web
- **Bridge**：HTTP 调用 DBX 桌面版

CLI 和 MCP Server 不关心底层使用哪种模式，实现了解耦。

### 9.2 渐进式直连

数据库类型按 Node.js 驱动可用性分层：
1. **完全直连**：PG/MySQL/SQLite/Redis — 使用 Node.js 原生驱动
2. **部分直连**：rqlite/Cloudflare D1 — 使用 HTTP API
3. **Bridge 模式**：其余 50+ 种 — 通过 DBX 桌面版的 Rust 后端

### 9.3 多层安全防护

从内到外：
1. SQL 风险分类 → SQL 安全策略 → 生产数据库保护
2. Redis 命令分类 → 安全评估
3. MongoDB 写操作检测
4. Scope 隔离 → 连接范围限制

### 9.4 零信任 Bridge

Bridge 通信基于本地 HTTP，端口通过文件系统传递：
- DBX 桌面版启动时写入端口文件
- CLI/MCP 读取端口文件获取 URL
- 所有操作通过 HTTP POST 请求

## 10. 与 Rust 后端的关系

```
┌─────────────────────────────────────────────────────────┐
│                    DBX 产品矩阵                          │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Vue 前端 │  │ Rust 后端│  │Node.js   │              │
│  │(apps/)   │  │(crates/) │  │工具链    │              │
│  │          │  │          │  │(packages/)│              │
│  │ 桌面 GUI │  │ 核心引擎 │  │ CLI/MCP  │              │
│  │ Web UI   │  │ 65+ DB   │  │ 10+ DB   │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │             │                     │
│       │    Tauri IPC │             │ SQLite 直连         │
│       ├──────────────┤             │ HTTP Bridge         │
│       │              │             │                     │
│       │    HTTP REST │             │                     │
│       ├──────────────┤             │                     │
│       │              │             │                     │
│       │    dbx-web   │             │                     │
│       │   (Axum)     │             │                     │
│       └──────────────┴─────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

Node.js 工具链层与 Rust 后端的关系：
- **独立运行**：CLI/MCP 可独立于 Rust 后端运行（直连 PG/MySQL/SQLite/Redis）
- **共享存储**：通过 SQLite 文件共享连接配置
- **Bridge 协作**：对于无 Node.js 驱动的数据库，通过本地 HTTP 调用 Rust 后端
- **Web 模式**：MCP 也可通过 HTTP 调用 dbx-web 服务，间接使用全部 Rust 能力

## 11. 总结

`packages/` 目录是 DBX 的 **Node.js 工具链层**，约 **5,500+ 行 TypeScript 代码**（不含测试），具备以下特点：

1. **独立数据库访问**：不依赖 Rust 后端即可直连 PG/MySQL/SQLite/Redis
2. **AI 集成入口**：MCP 协议让 AI Agent 安全查询数据库
3. **命令行界面**：终端直接操作数据库，支持多种输出格式
4. **多层安全**：SQL 风险分类 + 生产保护 + Scope 隔离 + Redis/MongoDB 安全
5. **Bridge 架构**：通过本地 HTTP 扩展支持 50+ 种数据库
6. **共享核心**：node-core 统一 CLI 和 MCP 的底层能力
7. **质量保障**：~240 个前端集成测试覆盖核心功能
