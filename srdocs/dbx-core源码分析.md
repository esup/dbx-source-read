# DBX Core (dbx-core) 源码分析文档

## 模块概述

`dbx-core` 是 DBX 项目的**核心业务逻辑层**，位于 `crates/dbx-core/`。它是一个纯 Rust 库，不依赖任何 UI 框架，被 `src-tauri`（桌面应用）和 `dbx-web`（Web 后端）共同依赖。

**一句话定位：** 所有数据库操作、AI 功能、数据导入导出、Schema 管理等核心能力都在这个 crate 中实现。

### 基本信息

| 属性 | 值 |
|------|-----|
| 包名 | `dbx-core` |
| 版本 | 0.1.0 |
| Edition | Rust 2021 |
| 许可证 | Apache-2.0 |
| 模块数量 | 64 个公开模块 |
| 源码行数 | ~90,000+ 行 |
| 依赖数量 | ~45 个 crate |

### Feature Flags

```toml
[features]
default = ["duckdb-bundled", "mq-admin", "sqlite-sqlcipher"]
duckdb-bundled = ["duckdb/bundled"]   # 内嵌 DuckDB
mq-admin = []                          # 消息队列管理
sqlite-sqlcipher = ["rusqlite/bundled-sqlcipher-vendored-openssl"]  # SQLite 加密
```

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        dbx-core                                 │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ 连接管理  │  │ 查询引擎  │  │ Schema   │  │  AI 助手     │   │
│  │connection│  │  query   │  │  schema  │  │    ai.rs     │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       │              │              │               │            │
│  ┌────┴──────────────┴──────────────┴───────────────┴────────┐  │
│  │                    db/ (数据库驱动层)                       │  │
│  │  mysql  postgres  sqlite  sqlserver  redis  mongo  ...    │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│  ┌──────────┐  ┌──────────┴──┐  ┌──────────┐  ┌──────────┐    │
│  │ 数据传输  │  │ 数据网格SQL │  │ 导入导出  │  │ 安全保护  │    │
│  │ transfer │  │ data_grid   │  │ *export  │  │production│    │
│  └──────────┘  └─────────────┘  └──────────┘  └──────────┘    │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ JDBC代理  │  │ 云同步   │  │ 存储层   │  │ SQL工具  │       │
│  │  agent_* │  │cloud_sync│  │ storage  │  │  sql.rs  │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心模块详解

### 一、数据库驱动层 (`db/`)

这是 dbx-core 最底层的模块，封装了所有数据库的原生连接和操作。

#### 目录结构

```
db/
├── mod.rs                 ← 公共类型导出、超时控制、TCP 探测
├── mysql.rs (4956行)      ← MySQL 驱动实现
├── postgres.rs (4223行)   ← PostgreSQL 驱动实现
├── sqlite.rs (2258行)     ← SQLite 驱动实现
├── sqlserver.rs (2571行)  ← SQL Server 驱动实现 (tiberius)
├── redis_driver.rs (3214行) ← Redis 驱动实现
├── mongo_driver.rs (1857行) ← MongoDB 驱动实现
├── clickhouse_driver.rs (785行) ← ClickHouse HTTP 接口
├── elasticsearch_driver.rs (2096行) ← Elasticsearch HTTP 接口
├── elasticsearch_sql.rs (426行) ← ES SQL 转换
├── influxdb_driver.rs (790行) ← InfluxDB 驱动
├── vector_driver.rs (879行) ← 向量数据库 (Qdrant/Milvus/Weaviate)
├── rqlite_driver.rs (450行) ← RQLite 驱动
├── turso_driver.rs (750行) ← Turso/Cloudflare D1 驱动
├── manticoresearch.rs (237行) ← Manticore Search
├── questdb.rs (187行)     ← QuestDB 驱动
├── agent_driver.rs (2504行) ← JDBC 代理驱动客户端
├── duckdb_driver.rs (196行) ← DuckDB 连接封装
├── duckdb_sql.rs (291行)   ← DuckDB SQL 生成
├── duckdb_worker_process.rs (631行) ← DuckDB 独立进程 worker
├── duckdb_worker_protocol.rs (181行) ← DuckDB worker 通信协议
├── duckdb_worker_runtime.rs (593行) ← DuckDB worker 运行时
├── ssh_tunnel.rs (974行)   ← SSH 隧道实现
├── http_tunnel.rs (413行)  ← HTTP 隧道
├── proxy_tunnel.rs (259行) ← 代理隧道
├── transport_layer_tunnel.rs (438行) ← 传输层隧道管理
├── file_validator.rs (131行) ← 文件路径安全校验
├── wkb.rs (312行)          ← Well-Known Binary 地理数据解析
└── ob_oracle.rs (303行)    ← OceanBase Oracle 模式兼容
```

#### 关键设计

**连接超时控制：**
```rust
pub const CONNECTION_TIMEOUT_SECS: u64 = 5;
pub const TCP_PROBE_TIMEOUT_SECS: u64 = 3;

// 通用超时包装器
pub async fn with_connection_timeout<T, F>(label: &str, timeout: Duration, future: F)
    -> Result<T, String>
where F: Future<Output = Result<T, String>>

// TCP 端口探测（连接前预检）
pub async fn probe_tcp_endpoint(label: &str, host: &str, port: u16, timeout: Duration)
    -> Result<(), String>
```

**JavaScript 安全数值转换：**
由于前端使用 JavaScript，超过 `Number.MAX_SAFE_INTEGER` 的整数会被转为字符串传输：
```rust
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub fn safe_i64_to_json(v: i64) -> serde_json::Value
pub fn json_value_for_js(value: serde_json::Value) -> serde_json::Value
```

---

### 二、连接管理 (`connection.rs` — 5152 行)

这是 dbx-core 中最大的模块之一，管理所有数据库连接的生命周期。

#### 核心类型

```rust
// 连接池类型枚举（每种数据库一个变体）
pub enum PoolKind {
    Postgres(PgPool),
    Mysql(MysqlPool),
    Sqlite(SqlitePool),
    SqlServer(SqlServerPool),
    Redis(RedisPool),
    Mongo(MongoPool),
    DuckDb(DuckDbHandle),
    // ... 更多数据库类型
}

// 应用全局状态（所有连接共享）
pub struct AppState {
    storage: Storage,
    connections: RwLock<HashMap<String, PoolKind>>,
    plugin_registry: PluginRegistry,
    // ...
}
```

#### 连接生命周期

```
ConnectionConfig (JSON 配置)
    ↓
test_connection() — 测试连接是否可用
    ↓
connect_db() — 建立连接池
    ↓  创建 SSH 隧道（如配置了）
    ↓  创建代理隧道（如配置了）
    ↓  初始化连接池
    ↓  执行连接初始化 SQL
    ↓
PoolKind 存入 AppState
    ↓
execute_query() — 从连接池获取连接执行查询
    ↓
disconnect_db() — 关闭连接池，清理隧道
```

#### MySQL 模式兼容

```rust
pub enum MysqlMode {
    Normal,          // 标准 MySQL
    Bare,            // 裸连接（无初始化）
    OceanBaseOracle, // OceanBase Oracle 模式
}
```

#### 关键常量

```rust
pub const JDBC_PLUGIN_NOT_INSTALLED: &str = "JDBC plugin is not installed...";
const DEFAULT_AGENT_CONNECT_TIMEOUT_SECS: u64 = 30;
const POOL_CLOSE_TIMEOUT_SECS: u64 = 3;
const HEALTH_CHECK_POOL_ACQUIRE_TIMEOUT: Duration = Duration::from_millis(500);
```

---

### 三、查询引擎 (`query.rs` — 4318 行)

查询引擎是执行 SQL 的核心模块，负责 SQL 解析、执行、结果处理。

#### 核心常量

```rust
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";
```

#### 核心类型

```rust
// 连接池错误处理策略
pub enum PoolErrorAction {
    Keep,              // 保留连接
    Discard,           // 丢弃连接
    ReconnectAndRetry, // 重连并重试
}

// 多语句执行结果（带元数据）
pub struct ExecuteMultiResult {
    pub result: db::QueryResult,
    pub execution_error: bool,  // 区分合成错误和正常结果
}

// 查询执行预算
pub struct QueryExecutionOptions {
    pub query_timeout: Option<Duration>,
    // ...
}
```

#### 查询执行流程

```
SQL 字符串
    ↓
split_sql_statements() — SQL 解析拆分
    ↓
starts_with_executable_sql_keyword() — 判断是否可执行
    ↓
is_write_sql() — 判断是否为写操作
    ↓
从连接池获取连接
    ↓
执行 SQL（带超时和取消支持）
    ↓
结果转换为 QueryResult
    ↓
json_value_for_js() — 数值安全转换
    ↓
返回前端
```

#### 查询取消

使用 `CancellationToken` 实现：
```rust
use tokio_util::sync::CancellationToken;
// 每个查询关联一个 token，取消时触发
```

---

### 四、Schema 管理 (`schema.rs` — 6307 行)

项目中**最大的模块**，负责浏览和操作数据库结构。

#### 核心宏

```rust
// 从连接映射中提取特定类型的连接池
macro_rules! extract_pool {
    ($connections:expr, $key:expr, $variant:ident) => { ... }
}

// MySQL/Oracle 模式分发
macro_rules! dispatch_mysql {
    ($p:expr, $mode:expr, $mysql:path, $ob:path $(, $arg:expr)*) => { ... }
}

// SQL Server 快捷路径
macro_rules! try_sqlserver {
    ($connections:expr, $pool_key:expr, $method:ident $(, $arg:expr)*) => { ... }
}
```

#### 主要功能

| 函数 | 功能 |
|------|------|
| `list_databases()` | 列出所有数据库 |
| `list_tables()` | 列出表 |
| `get_columns()` | 获取列信息 |
| `list_indexes()` | 列出索引 |
| `list_foreign_keys()` | 列出外键 |
| `list_triggers()` | 列出触发器 |
| `get_table_ddl()` | 获取表 DDL |
| `list_schemas()` | 列出模式 |
| `list_functions()` | 列出函数 |
| `list_sequences()` | 列出序列 |
| `list_extensions()` | 列出扩展 |
| `get_object_source()` | 获取对象源码 |
| `list_doris_catalogs()` | Doris 多目录支持 |
| `list_sqlserver_linked_servers()` | SQL Server 链接服务器 |

每种数据库的 Schema 查询 SQL 各不相同，通过 `database_capabilities.rs` 描述能力差异。

---

### 五、AI 助手 (`ai.rs` — 3339 行)

内置的 AI SQL 助手，支持多种 AI 提供商。

#### 支持的 AI 提供商

```rust
pub enum AiProvider {
    Claude,           // Anthropic Claude
    Openai,           // OpenAI GPT
    Gemini,           // Google Gemini
    Deepseek,         // DeepSeek
    Qwen,             // 通义千问
    Ollama,           // 本地模型
    OpenaiCompatible, // 自定义 OpenAI 兼容端点
    CodexCli,         // Codex CLI
    Custom,           // 完全自定义
}
```

#### API 风格

```rust
pub enum AiApiStyle {
    Completions,         // 标准 /v1/completions
    Responses,           // OpenAI Responses API
    AnthropicMessages,   // Anthropic Messages API
}

pub enum AiAuthMethod {
    ApiKey,      // API Key 认证
    BearerToken, // Bearer Token
    BasicAuth,   // Basic Auth
}
```

#### 流式取消机制

```rust
// 全局流式响应注册表
static AI_STREAMS: LazyLock<RwLock<HashMap<String, Arc<Notify>>>> = ...;

pub async fn register_stream(session_id: &str) -> Arc<Notify>
pub async fn cancel_stream(session_id: &str) -> bool
pub async fn unregister_stream(session_id: &str)

// Agent 循环取消时的特殊错误标识
pub const AGENT_CANCELLED_ERROR: &str = "Agent loop cancelled";
```

---

### 六、JDBC 代理系统 (`agent_*.rs`)

通过 Java 进程扩展数据库支持，用于没有 Rust 原生驱动的数据库。

#### 模块关系

```
agent_catalog.rs (371行)    — 代理目录（可用代理注册表）
agent_manager.rs (977行)    — 代理管理器（安装/卸载/JRE管理）
agent_service.rs (1655行)   — 代理服务（代理进程生命周期）
agent_connection.rs (1068行) — 代理连接（与 Java 进程通信）
agent_loop.rs (1397行)      — 代理事件循环
agent_runtime.rs (253行)    — 代理运行时环境
agent_tools.rs (917行)      — 代理工具函数
agent_events.rs (94行)      — 代理事件定义
agent_explain.rs (75行)     — 代理执行计划
agent_kv.rs (420行)         — 代理 KV 存储操作
```

#### 代理管理器核心类型

```rust
pub struct AgentRegistry {
    pub jre: Option<JreInfo>,           // JRE 信息
    pub jres: HashMap<String, JreInfo>, // 多个 JRE 版本
    pub drivers: HashMap<String, DriverInfo>, // 已安装驱动
}

pub const DEFAULT_JRE_KEY: &str = "21";
pub const DOWNLOAD_CACHE_DIR_NAME: &str = "download-cache";
pub const DOWNLOAD_CACHE_MAX_AGE_DAYS: u64 = 7;
```

#### JAR 文件校验

```rust
fn is_valid_jar_file(path: &Path) -> bool {
    // 1. 检查文件是否存在
    // 2. 尝试作为 ZIP 打开
    // 3. 读取 META-INF/MANIFEST.MF
    // 4. 确认包含 Main-Class 条目
}
```

---

### 七、数据传输 (`transfer.rs` — 6651 行)

数据库间的数据迁移模块，是代码量最大的模块之一。

#### 核心类型

```rust
pub enum TransferMode {
    Append,    // 追加
    Overwrite, // 覆盖
    Upsert,    // 更新或插入
}

pub enum TransferTableNameCase {
    Preserve, // 保持原样
    Lower,    // 转小写
    Upper,    // 转大写
}

pub enum TransferOwnershipPolicy {
    Preserve,       // 保持原 owner
    Skip,           // 跳过
    ReassignMissing, // 重新分配缺失的
}

pub struct TransferRequest {
    pub transfer_id: String,
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub tables: Vec<String>,
    pub create_table: bool,
    pub mode: TransferMode,
    pub target_table_name_case: TransferTableNameCase,
    pub ownership_policy: TransferOwnershipPolicy,
    pub batch_size: usize,
}
```

#### 关键限制

```rust
const MAX_TRANSFER_WRITE_SQL_BYTES: usize = 512 * 1024;  // 512KB
const MAX_SQLSERVER_INSERT_ROWS: usize = 1000;
const MAX_ORACLE_INSERT_ALL_ROWS: usize = 500;
const MAX_ORACLE_MERGE_ROWS: usize = 500;
const TRANSFER_TARGET_TABLE_LOOKUP_LIMIT: usize = 1000;
```

#### 取消机制

```rust
static CANCELLED: LazyLock<RwLock<HashSet<String>>> = ...;
// 通过 transfer_id 跟踪可取消的传输任务
```

---

### 八、数据网格 SQL (`data_grid_sql.rs` — 4534 行)

处理数据网格中的内联编辑、保存、过滤等操作。

#### 核心类型

```rust
pub struct DataGridTableMeta {
    pub catalog: Option<String>,
    pub database: Option<String>,     // Doris/StarRocks 多目录
    pub schema: Option<String>,
    pub table_name: String,
    pub primary_keys: Vec<String>,
    pub columns: Option<Vec<DataGridColumnInfo>>,
}

pub struct DataGridSaveStatementOptions {
    pub database_type: Option<DatabaseType>,
    pub table_meta: DataGridTableMeta,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,         // 所有行
    pub dirty_rows: Vec<(usize, Vec<(usize, Value)>)>, // 修改的行
    pub deleted_rows: Vec<usize>,      // 删除的行索引
    pub new_rows: Vec<Vec<Value>>,     // 新增的行
}
```

#### 特殊数据库支持

通过内嵌子模块处理特殊数据库：
```rust
#[path = "data_grid_neo4j_sql.rs"]
mod data_grid_neo4j_sql;  // Neo4j 图数据库保存逻辑

#[path = "data_grid_tdengine_sql.rs"]
mod data_grid_tdengine_sql;  // TDengine 时序数据库保存逻辑
```

#### 特殊列名

```rust
const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";
```

---

### 九、存储层 (`storage.rs` — 3277 行)

本地数据持久化，使用 SQLite 作为底层存储。

#### 核心常量

```rust
const STORAGE_DB_FILE_NAME: &str = "dbx.db";
const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";
const APP_STATE_EDITOR_SETTINGS_KEY: &str = "editor_settings";
const APP_STATE_OPEN_TABS_KEY: &str = "open_tabs";
```

#### 存储的用户数据表

```rust
const USER_DATA_TABLES: &[&str] = &[
    "connections",         // 连接配置
    "connection_secrets",  // 连接密钥（加密）
    "history",             // 查询历史
    "ai_conversations",    // AI 对话
    "mq_token_records",    // 消息队列令牌
    "saved_sql_folders",   // SQL 片段文件夹
    "saved_sql_files",     // SQL 片段文件
];
```

#### 数据迁移

```rust
pub enum DataDbImportResult {
    Imported,
    SkippedNoSource,
    SkippedInvalidSource,
    SkippedEmpty,
    SkippedTargetHasData,
}

// 从旧版 JSON 格式迁移到 SQLite
pub async fn migrate_from_json(&self, data_dir: &Path) -> Result<(), String>
```

#### 桌面设置

```rust
pub struct DesktopSettings {
    pub debug_logging_enabled: bool,
    pub show_tray_icon: bool,
    pub icon_theme: DesktopIconTheme,
    pub duckdb_worker_process_isolation: bool,
    pub duckdb_worker_max_processes: usize,
    // ...
}
```

---

### 十、生产安全 (`production_safety.rs` — 689 行)

SQL 安全分析模块，通过正则表达式识别 SQL 中的目标对象和操作类型。

#### 正则规则（部分）

```rust
// DML 目标匹配（FROM/JOIN/UPDATE/INTO/REFERENCES）
static DML_TARGET_RE: LazyLock<Regex> = ...;

// DDL 对象匹配（CREATE/ALTER/DROP TABLE/VIEW/INDEX...）
static DDL_OBJECT_TARGET_RE: LazyLock<Regex> = ...;

// TRUNCATE 目标
static TRUNCATE_TARGET_RE: LazyLock<Regex> = ...;

// 全局 DDL（CREATE USER/ROLE/DATABASE...）
static GLOBAL_DDL_TARGET_RE: LazyLock<Regex> = ...;

// 多目标变更（DROP TABLE a, b）
static MULTI_TARGET_MUTATION_RE: LazyLock<Regex> = ...;
```

#### 安全功能

- 识别 SQL 中涉及的所有表/视图/索引
- 标记危险操作（DROP、TRUNCATE、DELETE 无 WHERE）
- 生产环境连接的特殊保护
- SQL 风险评估和确认对话框

---

### 十一、云同步 (`cloud_sync.rs` — 1479 行)

支持通过 WebDAV 和代码托管平台同步配置。

#### 支持的同步方式

```rust
pub struct WebDavConfig {
    pub endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub remote_path: Option<String>,
}

pub enum SnippetProvider {
    GitHub,  // GitHub Gist
    Gitee,   // Gitee
}
```

#### 安全特性

- AES-256-GCM 加密同步数据
- Argon2 密码哈希
- 敏感字段自动过滤（密码、密钥等不会上传）

```rust
const SECRET_KEYS: &[&str] = &[
    "password", "ssh_password", "ssh_key_passphrase",
    "proxy_password", "redis_sentinel_password", "connection_string",
    // ...
];
```

---

### 十二、Schema 对比 (`schema_diff.rs` — 2141 行)

比较两个数据库连接的结构差异。

#### 差异类型

```rust
pub struct ColumnDiff {
    pub diff_type: String,     // "added" | "removed" | "modified"
    pub name: String,
    pub source: Option<ColumnInfo>,
    pub target: Option<ColumnInfo>,
    pub changes: Vec<String>,
}

// 类似结构：IndexDiff, ForeignKeyDiff, TriggerDiff, TableDiff...
```

---

### 十三、SQL 工具 (`sql.rs` — 3550 行)

SQL 解析、拆分、模糊搜索等通用工具。

#### 核心功能

```rust
// SQL 语句拆分
pub fn split_sql_statements(sql: &str) -> Vec<String>
pub fn split_sql_batches(sql: &str) -> Vec<String>

// 模糊搜索
pub fn fuzzy_subsequence_match(text: &str, filter: &str) -> bool
pub fn contains_or_fuzzy_match(text: &str, filter: &str) -> bool

// LIKE 模式生成
pub fn fuzzy_like_pattern_with_escape(value: &str, escape: impl FnMut(&str) -> String) -> String

// SQL 关键字检测
pub fn starts_with_executable_sql_keyword(sql: &str) -> bool
```

---

### 十四、导出模块群

| 模块 | 行数 | 功能 |
|------|------|------|
| `csv_export.rs` | 240 | CSV 导出 |
| `xlsx_export.rs` | 762 | Excel 导出 |
| `text_export.rs` | 143 | JSON/Markdown 导出 |
| `query_result_export.rs` | 1491 | 查询结果通用导出 |
| `table_export.rs` | 1724 | 表数据导出 |
| `database_export.rs` | 2060 | 整库导出（DDL + 数据） |

---

### 十五、其他重要模块

| 模块 | 行数 | 功能 |
|------|------|------|
| `table_import.rs` | 3151 | CSV/Excel 导入 |
| `data_compare.rs` | 1541 | 数据对比 |
| `query_execution_sql.rs` | 1194 | SQL 执行逻辑（写判断等） |
| `query_result_sql.rs` | 2582 | 查询结果 SQL 构建 |
| `object_source_sql.rs` | 1451 | 对象源码 SQL 生成 |
| `sql_editability.rs` | 1072 | 数据可编辑性分析 |
| `sql_analysis.rs` | 488 | SQL 分析（引用分析等） |
| `sql_risk.rs` | 331 | SQL 风险评估 |
| `sql_file_import.rs` | 1458 | SQL 文件导入执行 |
| `connection_secrets.rs` | 1145 | 连接密钥加密存储 |
| `redis_ops.rs` | 901 | Redis 专用操作 |
| `mongo_ops.rs` | 428 | MongoDB 专用操作 |
| `document_ops.rs` | 592 | 文档数据库操作 |
| `jdbc.rs` | 1083 | JDBC 桥接逻辑 |
| `plugins.rs` | 612 | 插件系统 |
| `ssh_config.rs` | 289 | SSH 配置管理 |
| `update.rs` | 450 | 自动更新检查 |
| `history.rs` | 68 | 查询历史 |
| `saved_sql.rs` | 46 | SQL 片段管理 |
| `types.rs` | 312 | 公共类型定义 |
| `models/` | - | 数据模型 |
| `mq/` | 153+ | 消息队列管理（Kafka/Pulsar/RocketMQ） |
| `nacos.rs` | 89+ | Nacos 配置中心 |

---

## 依赖关系分析

### 数据库驱动依赖

| Crate | 用途 |
|-------|------|
| `mysql_async` | MySQL 异步驱动 |
| `tokio-postgres` + `deadpool-postgres` | PostgreSQL 连接池 |
| `rusqlite` | SQLite（bundled 编译） |
| `tiberius` | SQL Server (TDS 协议) |
| `redis` | Redis（含集群/哨兵） |
| `mongodb` | MongoDB |
| `duckdb` | DuckDB（可选，bundled 编译） |
| `reqwest` | HTTP 客户端（ClickHouse/ES 等） |

### 安全/加密依赖

| Crate | 用途 |
|-------|------|
| `rustls` + `rustls-pemfile` | TLS/SSL |
| `aes-gcm` | AES-256-GCM 加密 |
| `argon2` | 密码哈希 |
| `sha2` | SHA-256 |
| `jsonwebtoken` | JWT |
| `russh` + `pageant` | SSH 连接 |

### 异步/工具依赖

| Crate | 用途 |
|-------|------|
| `tokio` | 异步运行时 |
| `tokio-util` | 异步工具 |
| `futures` | Future 工具 |
| `async-trait` | 异步 trait |
| `rayon` | 并行计算 |
| `sqlparser` | SQL 解析 |

### 序列化/数据依赖

| Crate | 用途 |
|-------|------|
| `serde` + `serde_json` | JSON 序列化 |
| `csv` | CSV 处理 |
| `calamine` | Excel 解析 |
| `quick-xml` | XML 解析 |
| `chrono` + `rust_decimal` | 日期/数值类型 |
| `uuid` | UUID 生成 |

---

## 关键设计模式

### 1. AppState 全局状态

所有连接共享一个 `Arc<AppState>`，通过 Tauri managed state 传递给命令处理器：

```rust
let state = Arc::new(AppState::new_with_plugin_dir_and_app_version(...));
app.manage(state.clone());
```

### 2. 连接池类型枚举

使用 `PoolKind` 枚举统一管理不同类型的连接池：

```rust
pub enum PoolKind {
    Postgres(...),
    Mysql(...),
    Sqlite(...),
    // ...
}
```

### 3. 条件编译 (Feature Flags)

大量使用 `#[cfg(feature = "...")]` 控制可选功能：

```rust
#[cfg(feature = "duckdb-bundled")]
pub mod duckdb_worker_process;

#[cfg(feature = "mq-admin")]
pub mod mq;
```

### 4. 取消令牌模式

长时间运行的操作（查询、传输、导出）都支持取消：

```rust
// 查询取消
use tokio_util::sync::CancellationToken;

// 传输取消
static CANCELLED: LazyLock<RwLock<HashSet<String>>> = ...;

// AI 流取消
static AI_STREAMS: LazyLock<RwLock<HashMap<String, Arc<Notify>>>> = ...;
```

### 5. 宏简化数据库分发

Schema 模块中大量使用宏减少重复代码：

```rust
// 从连接池提取特定类型
extract_pool!($connections, $key, SqlServer)

// MySQL/Oracle 模式分发
dispatch_mysql!($p, $mode, $mysql_fn, $ob_fn)

// SQL Server 快捷路径
try_sqlserver!($connections, $pool_key, method_name)
```

---

## 数据流图

### 查询执行数据流

```
前端 invoke("execute_query", { connection_id, sql, database })
    │
    ▼
connection.rs: AppState 查找连接池
    │
    ▼
query.rs: SQL 解析 + 风险检查
    │
    ├── 写操作? → 安全检查 → 确认对话框
    │
    ▼
query.rs: 从连接池获取连接
    │
    ├── MySQL → db/mysql.rs → mysql_async
    ├── PostgreSQL → db/postgres.rs → tokio-postgres
    ├── SQLite → db/sqlite.rs → rusqlite
    ├── SQL Server → db/sqlserver.rs → tiberius
    ├── Redis → db/redis_driver.rs → redis-rs
    ├── MongoDB → db/mongo_driver.rs → mongodb
    ├── DuckDB → db/duckdb_driver.rs → duckdb
    ├── Agent → db/agent_driver.rs → Java 进程
    └── HTTP → reqwest → ClickHouse/ES/InfluxDB...
    │
    ▼
结果转换为 QueryResult
    │
    ▼
json_value_for_js() 数值安全转换
    │
    ▼
返回前端展示
```

---

## 测试策略

### 单元测试

大部分模块底部都有 `#[cfg(test)] mod tests` 块，覆盖：
- SQL 解析和生成
- 数据转换
- 配置解析
- 安全规则匹配

### DuckDB Worker 测试

由于 DuckDB 使用独立进程，需要专门的测试宿主二进制：

```toml
[[bin]]
name = "duckdb-worker-test-host"
path = "tests/support/duckdb_worker_test_host.rs"
required-features = ["duckdb-bundled"]
```

---

## 总结

`dbx-core` 是一个设计精良的数据库管理核心库，具有以下特点：

1. **广泛的数据库支持** — 通过原生驱动 + JDBC 代理覆盖 60+ 数据库
2. **清晰的分层架构** — db 驱动层 → 业务逻辑层 → 对外接口层
3. **安全的默认行为** — 生产安全检查、SQL 风险评估、密钥加密
4. **灵活的扩展机制** — Feature flags、插件系统、代理驱动
5. **完善的取消机制** — 长时间操作均支持取消
6. **跨平台兼容** — 条件编译处理平台差异

整个 crate 约 90,000+ 行代码，是 DBX 项目中最核心、最复杂的部分。
