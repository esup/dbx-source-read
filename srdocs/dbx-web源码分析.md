# dbx-web 源码分析

## 1. 模块概述

`dbx-web` 是 DBX 项目的 **Web 后端服务**，基于 Axum 框架构建，为 DBX 的 Docker 自托管 / Web 版部署提供 RESTful API。它是 `src-tauri`（桌面版）的 Web 等价物——将 `dbx-core` 的核心能力通过 HTTP 接口暴露给前端。

| 属性 | 值 |
|------|-----|
| **包名** | `dbx-web` |
| **版本** | 0.5.56 |
| **类型** | 可执行二进制（`[[bin]]`） |
| **入口** | `src/main.rs` |
| **框架** | Axum 0.8 + Tokio |
| **源码文件** | 40 个 `.rs` 文件 |
| **总代码量** | ~8,500 行 |
| **核心依赖** | `dbx-core`、`axum`、`tower-http`、`tokio`、`rustls` |

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────┐
│                   前端 (Vue 3 SPA)                    │
│              通过 /api/* 调用后端                       │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP / WebSocket / SSE
┌──────────────────────▼───────────────────────────────┐
│                    dbx-web 服务                        │
│  ┌─────────────────────────────────────────────────┐ │
│  │  main.rs — 启动、路由注册、中间件配置               │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  auth.rs — 认证（Argon2 密码哈希 + Cookie 会话）   │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  state.rs — WebState 全局状态                     │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  error.rs — 统一错误类型 AppError                  │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  sse.rs — SSE 推送工具                            │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  routes/ — 35 个路由模块                           │ │
│  │    connection, query, schema, ai, redis,          │ │
│  │    mongo, transfer, cloud_sync, mq, nacos ...     │ │
│  └────────────────────┬────────────────────────────┘ │
│                       │ 调用                          │
│  ┌────────────────────▼────────────────────────────┐ │
│  │              dbx-core (核心业务逻辑)               │ │
│  │   AppState / Storage / 各业务模块                  │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## 3. 启动流程

`main()` 函数的启动分为以下阶段：

### 3.1 初始化（第 152-161 行）

```rust
#[tokio::main]
async fn main() {
    // 1. 日志初始化（tracing + env_filter）
    tracing_subscriber::fmt()
        .with_env_filter("dbx_web=info,tower_http=info")
        .init();

    // 2. TLS 加密提供者（rustls + aws-lc-rs）
    rustls::crypto::aws_lc_rs::default_provider().install_default();
```

### 3.2 数据目录与存储

```rust
// 3. 数据目录：DBX_DATA_DIR 环境变量 或 ~/.dbx-web
let data_dir = std::env::var("DBX_DATA_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(home).join(".dbx-web"));

// 4. 打开 SQLite 存储 + JSON 数据迁移
let storage = Storage::open(&db_path).await?;
storage.migrate_from_json(&data_dir).await?;

// 5. 创建 AppState（共享连接池、插件、代理管理）
let app_state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
    storage, plugins_dir, agent_dir, version
));
```

### 3.3 密码与认证初始化

```rust
// 密码来源优先级：DBX_DISABLE_PASSWORD > DBX_PASSWORD 环境变量 > 数据库已存储的哈希
let password_disabled = env("DBX_DISABLE_PASSWORD") == "true";
let password_hash = if password_disabled { None }
    else if let Ok(pw) = env("DBX_PASSWORD") { Some(argon2_hash(pw)) }
    else { storage.load_password_hash().await? };
```

### 3.4 WebState 构建

```rust
let web_state = Arc::new(WebState {
    app: app_state,           // Arc<AppState> 核心业务状态
    data_dir,                 // 数据目录路径
    public_base_path,         // 子路径部署支持（DBX_PUBLIC_BASE_PATH）
    password_disabled,        // 是否禁用密码
    password_hash,            // RwLock<Option<String>> 密码哈希
    sessions,                 // RwLock<HashSet<String>> 活跃会话 Token
    sse_channels,             // RwLock<HashMap<String, broadcast::Sender>> SSE 推送通道
    sql_file_executions,      // RwLock<HashMap<String, CancellationToken>> SQL 文件执行取消
    login_rate_limit,         // Mutex<LoginRateLimit> 登录限流
    export_files,             // RwLock<HashMap<String, (path, format)>> 导出临时文件
});
```

### 3.5 路由组装与服务启动

```rust
// API 路由 → 认证中间件 → 嵌套到 /api 前缀
let api = Router::new()
    .route("/auth/login", post(auth::login))
    .route("/connection/connect", post(routes::connection::connect_db))
    // ... 200+ 路由
    .layer(middleware::from_fn(auth::auth_middleware));  // 认证中间件

let app = Router::new()
    .nest("/api", api)                                  // API 路由
    .layer(DefaultBodyLimit::max(web_body_limit_bytes()))  // 请求体限制
    .layer(TraceLayer::new_for_http());                 // HTTP 追踪

// 静态文件服务（DBX_STATIC_DIR 环境变量）
if let Ok(static_dir) = env("DBX_STATIC_DIR") {
    app = app.fallback_service(ServeDir::new(&static_dir));
}

// 子路径部署支持
if public_base_path != "/" {
    app = Router::new().nest(&public_base_path, app);
}

// 绑定端口（默认 4224）
let addr = SocketAddr::from(([0, 0, 0, 0], port));
axum::serve(listener, app).await?;
```

---

## 4. 认证系统（auth.rs）

### 4.1 认证方案

| 组件 | 实现 |
|------|------|
| **密码哈希** | Argon2（默认参数 + 随机盐） |
| **会话管理** | UUID v4 Token，存储在内存 `HashSet<String>` |
| **传输方式** | HttpOnly Cookie（`dbx_session=...`） |
| **限流保护** | 5 次失败后锁定 60 秒 |

### 4.2 认证端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/auth/login` | POST | 密码验证 → 创建会话 → 设置 Cookie |
| `/auth/check` | GET | 检查认证状态（返回 `authenticated`、`required`、`setup_required`） |
| `/auth/setup` | POST | 首次设置密码（仅在未配置密码时可用） |
| `/auth/change-password` | POST | 修改密码（需验证旧密码） |
| `/auth/logout` | POST | 销毁会话 → 清除 Cookie |

### 4.3 认证中间件

```rust
pub async fn auth_middleware(state, req, next) -> Response {
    // 1. auth/* 端点始终放行（不需要认证）
    if api_suffix.starts_with("auth/") { return next.run(req).await; }

    // 2. 非 API 请求（静态文件）始终放行
    if api_suffix.is_none() { return next.run(req).await; }

    // 3. 密码禁用模式直接放行
    if state.password_disabled { return next.run(req).await; }

    // 4. 未设置密码 → 返回 401
    if password_hash.is_none() { return StatusCode::UNAUTHORIZED.into_response(); }

    // 5. 检查 Cookie 中的 Session Token
    if let Some(token) = extract_session_token(&req) {
        if sessions.contains(&token) { return next.run(req).await; }
    }

    StatusCode::UNAUTHORIZED.into_response()
}
```

### 4.4 子路径感知

认证系统完整支持 `DBX_PUBLIC_BASE_PATH` 子路径部署：
- Cookie 的 `Path` 属性动态设置为 `public_base_path`
- `api_path_suffix()` 函数同时处理 `/api/*` 和 `/{base}/api/*` 两种路径格式

---

## 5. 全局状态（state.rs）

```rust
pub struct WebState {
    pub app: Arc<AppState>,                    // dbx-core 核心状态
    pub data_dir: PathBuf,                     // 数据目录
    pub public_base_path: String,              // 子路径前缀
    pub password_disabled: bool,               // 密码开关
    pub password_hash: RwLock<Option<String>>, // 密码哈希（可运行时更新）
    pub sessions: RwLock<HashSet<String>>,     // 活跃会话集合
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,  // SSE 推送
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,   // 取消控制
    pub login_rate_limit: Mutex<LoginRateLimit>,  // 登录限流
    pub export_files: RwLock<HashMap<String, (String, String)>>,           // 导出文件映射
}
```

**设计特点**：
- `Arc<WebState>` 作为 Axum 的 `State` 提取器，所有路由共享
- 使用 `RwLock` 实现读多写少的并发控制
- SSE 通道使用 `broadcast::Sender` 实现一对多推送

---

## 6. 路由模块详解

### 6.1 路由分类总览

| 分类 | 路由模块 | 端点数量 | 说明 |
|------|---------|---------|------|
| **连接管理** | connection | ~9 | 测试/建立/断开连接、保存/加载配置 |
| **查询执行** | query | ~50+ | SQL 执行、取消、各种 SQL 构建辅助 |
| **Schema 浏览** | schema, schema_cache, schema_diff | ~25 | 数据库/表/列/索引/触发器等元数据 |
| **Redis** | redis, redis_pubsub_ws | ~25 | 键扫描、数据类型操作、Pub/Sub WebSocket |
| **MongoDB** | mongo, document_store | ~25 | 文档 CRUD、集合管理、GridFS 文件操作 |
| **消息队列** | mq（feature-gated） | ~40 | Pulsar 管理：租户/命名空间/主题/订阅/策略 |
| **Nacos** | nacos | ~12 | 命名空间/配置/服务/实例管理 |
| **etcd/ZooKeeper** | etcd, zookeeper | ~8 | KV 操作（list/get/put/delete） |
| **数据传输** | transfer | ~5 | 跨库数据传输、进度追踪、FK 排序 |
| **导入/导出** | table_import, table_export, database_export, query_result_export, text_export | ~20 | 多格式数据导入导出 |
| **AI 助手** | ai | ~10 | 配置管理、对话、流式补全、Agent 模式 |
| **JDBC 代理** | jdbc, agents | ~25 | 驱动管理、Maven/本地安装、运行时控制 |
| **云同步** | cloud_sync | ~14 | WebDAV/片段同步、密码管理 |
| **SQL 文件** | sql_file | ~4 | SQL 文件预览/执行 |
| **其他** | history, saved_sql, layout, app_settings, update, tunnel_profiles, ssh_config, plugins | ~20 | 历史记录、收藏 SQL、UI 布局、版本检查等 |

### 6.2 连接管理（connection.rs，680 行）

核心职责：管理数据库连接的完整生命周期。

```
前端请求 → ConnectRequest { config, client_attempt }
    │
    ├── test_connection    → 临时创建连接 → 测试 → 清理
    ├── connect_db         → begin_connection_attempt → get_or_create_pool
    ├── disconnect_db      → remove_connection_pools
    ├── save_connections   → 持久化配置到 Storage
    └── load_connections   → 从 Storage 读取配置列表
```

**关键设计**：
- `client_attempt` 字段用于防止重复连接（乐观锁机制）
- 测试连接使用 `__test_{uuid}` 临时 ID，完成后立即清理

### 6.3 查询执行（query.rs，813 行）

最庞大的路由模块，提供 SQL 执行和各类 SQL 构建辅助。

**查询执行端点**：
| 端点 | 功能 |
|------|------|
| `/query/execute` | 执行单条 SQL |
| `/query/execute-multi` | 执行多条 SQL |
| `/query/execute-batch` | 批量执行 |
| `/query/execute-script` | 执行 SQL 脚本 |
| `/query/execute-in-transaction` | 事务内执行 |
| `/query/cancel` | 取消正在执行的查询 |
| `/query/close-session` | 关闭查询会话 |

**SQL 构建端点**（~40 个）：
- DDL：`build-create-table-sql`、`build-drop-table-sql`、`build-truncate-table-sql` 等
- DML：`build-table-select-sql`、`build-export-insert-statements` 等
- 数据网格：`prepare-data-grid-save`、`build-data-grid-count-sql`、`build-data-grid-copy-update-statements` 等
- 特殊：`build-explain-sql`、`build-dropped-file-preview-sql`、`analyze-editability` 等

### 6.4 Redis 模块（redis.rs，582 行 + redis_pubsub_ws.rs，127 行）

提供完整的 Redis 数据操作能力：

- **键扫描**：`scan-keys`、`scan-keys-batch`、`scan-values`
- **数据操作**：按类型分发（String/Hash/List/Set/ZSet/Stream/JSON）
- **管理操作**：`delete-key`、`delete-keys`、`flush-db`、`execute-command`
- **Pub/Sub**：通过 WebSocket 实现实时消息订阅（`redis/pubsub/ws`）
- **慢查询**：`slowlog-get`
- **集群**：`cluster-master-nodes`

**只读保护**：
```rust
async fn ensure_writable(app, connection_id, action) -> Result<(), AppError> {
    if connection_readonly_name(app, connection_id).await.is_some() {
        return Err(AppError("Read-only mode: ... blocked."));
    }
    Ok(())
}
```

### 6.5 MongoDB 模块（mongo.rs，515 行 + document_store.rs，383 行）

两个模块共同提供 MongoDB 支持：

**mongo.rs** — 原生 MongoDB 操作：
- 数据库/集合管理（list/create/drop）
- 文档 CRUD（insert/update/delete/find/count/aggregate）
- 索引管理（create-index/drop-indexes）
- 服务器信息（server-version/collection-stats）
- 批量操作（insert-documents/update-documents/delete-documents）

**document_store.rs** — 通用文档存储 + GridFS：
- 文档操作（find/insert/update/delete）
- GridFS 文件管理（list-buckets/create-bucket/download/upload/delete）

**取消机制**：
```rust
async fn run_cancellable<T, F>(state, execution_id, future) -> Result<T, AppError> {
    let registered = execution_id.map(|id| state.app.running_queries.register(id));
    if let Some(query) = registered {
        tokio::select! {
            biased;
            _ = query.token().cancelled() => Err(canceled_error()),
            result = future => result.map_err(AppError),
        }
    } else { future.await.map_err(AppError) }
}
```

### 6.6 消息队列管理（mq.rs，752 行，feature-gated）

通过 `mq-admin` feature flag 控制，提供 **Pulsar** 消息队列的完整管理能力：

| 子域 | 端点 | 功能 |
|------|------|------|
| **租户** | tenants/list, create, update, delete | 多租户管理 |
| **命名空间** | namespaces/list, create, delete, policies | 命名空间管理 |
| **主题** | topics/list, create, delete, stats, unload | 主题管理与监控 |
| **订阅** | subscriptions/list, create, delete, skip, reset, peek, clear | 订阅管理 |
| **生产者/消费者** | producers/list, consumers/list | 运行时监控 |
| **策略** | policies/publish-rate, dispatch-rate, subscribe-rate, backlog, retention | 限流与配额 |
| **权限** | permissions/grant, revoke, list | ACL 管理 |
| **令牌** | tokens/issue, list | JWT 令牌管理 |
| **监控** | monitoring/backlog, cluster-info | 集群状态 |
| **消息** | send-message, raw | 直接操作 |

### 6.7 Nacos 管理（nacos.rs，245 行）

提供 Nacos 服务发现与配置管理：

- **命名空间**：list / create / update
- **配置管理**：list / get / publish / delete + 历史版本 / 回滚
- **服务管理**：list services / list instances / update instance
- **原始请求**：`/nacos/raw` 透传任意 Nacos API 调用

### 6.8 数据传输（transfer.rs，420 行）

跨数据库数据传输的 Web 层实现：

```
start_transfer
    ├── 验证目标表名合法性
    ├── 检查目标连接只读保护
    ├── 创建 SSE broadcast 通道（进度推送）
    └── tokio::spawn 异步执行
        ├── 获取源/目标数据库类型
        ├── 获取连接池
        └── 调用 dbx_core::transfer::transfer_data_core()
            → 通过 SSE 实时推送进度
            → 完成后清理通道

transfer_progress  → SSE 订阅进度流
cancel_transfer    → 通过 CancellationToken 取消
```

### 6.9 AI 助手（ai.rs，328 行）

AI 功能的 Web API 层：

- **配置管理**：保存/加载 AI 配置、Provider 配置
- **对话管理**：保存/加载/删除对话
- **补全**：`/ai/complete`（一次性）、`/ai/stream`（SSE 流式）
- **Agent 模式**：`/ai/agent-stream`（结合数据库上下文的 Agent 循环）
- **工具**：`/ai/test-connection`、`/ai/models`（列出可用模型）、`/ai/cancel-stream`

### 6.10 导入/导出模块群

| 模块 | 行数 | 功能 |
|------|------|------|
| **table_import.rs** | 404 | 文件上传（Multipart）→ 预览 → 导入，支持 CSV/JSON 等格式 |
| **table_export.rs** | 158 | 表数据导出 → SSE 进度 → 文件下载 |
| **database_export.rs** | 166 | 整库导出 → SSE 进度 → 文件下载 |
| **query_result_export.rs** | 168 | 查询结果导出 → SSE 进度 → 文件下载 |
| **text_export.rs** | 38 | 查询结果导出为 JSON/Markdown 文本 |

### 6.11 JDBC 代理与驱动管理（jdbc.rs，210 行 + agents.rs，304 行）

**jdbc.rs** — JDBC 驱动管理：
- 驱动列表/安装/删除
- Maven 仓库浏览与安装
- 本地 JAR 上传
- JDBC 插件安装/卸载
- 系统字体列表

**agents.rs** — JDBC 代理运行时管理：
- 已安装代理列表/检查
- 存储空间使用量
- 下载缓存清理
- 运行时状态/停止/重启
- 代理安装/升级/卸载
- 离线导入（ZIP/JAR）
- Java 运行时配置
- JRE 重装/卸载
- 操作进度 SSE 推送

---

## 7. 关键设计模式

### 7.1 路由处理函数签名模式

所有路由处理函数遵循统一签名：

```rust
pub async fn handler(
    State(state): State<Arc<WebState>>,     // 全局状态
    Json(body): Json<SomeRequest>,          // JSON 请求体
) -> Result<Json<ResponseType>, AppError>   // 统一错误类型
```

或使用 `Query` 提取器（GET 请求）：
```rust
pub async fn handler(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SomeQuery>,
) -> Result<Json<Value>, AppError>
```

### 7.2 委托模式（Thin Wrapper）

路由层是 `dbx-core` 的**薄封装层**，几乎所有业务逻辑都委托给 `dbx_core::*`：

```rust
// 典型模式：路由层只做 请求解析 → 调用 core → 序列化响应
pub async fn list_databases(State(state), Query(q)) -> Result<Json<Value>, AppError> {
    let result = dbx_core::schema::list_databases_core(&state.app, &q.connection_id)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}
```

### 7.3 SSE 进度推送模式

长时间操作（传输/导出/导入）使用 SSE 实时推送进度：

```rust
// 1. 创建 broadcast 通道
let (tx, _) = broadcast::channel::<String>(256);
state.sse_channels.write().await.insert(id.clone(), tx.clone());

// 2. 异步任务中发送进度
tokio::spawn(async move {
    let _ = tx.send(serde_json::json!({"progress": 0.5}).to_string());
    // ... 处理完成后
    let _ = tx.send(serde_json::json!({"done": true}).to_string());
});

// 3. 客户端通过 SSE 端点订阅
fn progress_handler(State(state), Path(id)) -> Sse<...> {
    let rx = state.sse_channels.read().await.get(&id).unwrap().subscribe();
    sse_from_channel(rx)
}
```

### 7.4 取消令牌模式

可取消操作（查询、MongoDB 操作、文档存储）使用 `CancellationToken`：

```rust
async fn run_cancellable(state, execution_id, future) -> Result<T, AppError> {
    let registered = execution_id.map(|id| state.app.running_queries.register(id));
    if let Some(query) = registered {
        tokio::select! {
            biased;
            _ = query.token().cancelled() => Err(canceled_error()),
            result = future => result.map_err(AppError),
        }
    } else {
        future.await.map_err(AppError)
    }
}
```

### 7.5 只读保护模式

写操作前统一检查连接只读状态：

```rust
async fn ensure_writable(app, connection_id, action) -> Result<(), AppError> {
    if let Some(name) = connection_readonly_name(app, connection_id).await {
        Err(AppError(format!("Read-only mode: '{}' ... {} blocked.", name, action)))
    } else { Ok(()) }
}
```

### 7.6 Multipart 文件上传模式

表导入使用 Multipart 处理文件上传：

```rust
pub async fn preview_import(State(state), mut multipart: Multipart) -> Result<...> {
    let tmp_dir = import_upload_dir(&state.data_dir);
    create_dir_all(&tmp_dir);
    cleanup_expired_import_uploads(&tmp_dir, Duration::from_hours(24));

    loop {
        let field = multipart.next_field().await?;
        // 解析字段：source_format, parse_options, file data
        // 写入临时文件 → 调用 core 预览
    }
}
```

---

## 8. 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DBX_DATA_DIR` | `~/.dbx-web` | 数据存储目录 |
| `DBX_PORT` | `4224` | HTTP 监听端口 |
| `DBX_PASSWORD` | — | 初始密码（优先于数据库存储） |
| `DBX_DISABLE_PASSWORD` | `false` | 禁用密码认证 |
| `DBX_PUBLIC_BASE_PATH` | `/` | 子路径部署前缀 |
| `DBX_STATIC_DIR` | — | 前端静态文件目录 |
| `DBX_AGENT_DIR` | `{data_dir}/agents` | JDBC 代理目录 |
| `DBX_MAX_UPLOAD_MB` | `1024` | 请求体大小限制（MB） |
| `RUST_LOG` | `dbx_web=info,tower_http=info` | 日志级别 |

---

## 9. Feature Flags

| Feature | 默认 | 说明 |
|---------|------|------|
| `mq-admin` | 启用 | 启用 Pulsar 消息队列管理路由（~40 个端点） |

当 `mq-admin` 被禁用时，`add_mq_routes()` 返回空路由器，所有 MQ 端点不会注册。

---

## 10. 与 src-tauri 的对比

| 维度 | src-tauri（桌面版） | dbx-web（Web 版） |
|------|---------------------|-------------------|
| **框架** | Tauri 2（原生窗口） | Axum 0.8（HTTP 服务） |
| **命令注册** | `#[tauri::command]` 宏 | Axum `Router::route()` |
| **前端通信** | Tauri IPC（invoke） | HTTP REST + SSE + WebSocket |
| **认证** | 无（本地应用） | Argon2 + Cookie Session |
| **文件服务** | 原生文件系统访问 | `tower-http::ServeDir` |
| **部署方式** | 桌面安装包 | Docker / 二进制 |
| **命令数量** | ~400 个 | ~200+ 个 HTTP 端点 |
| **核心依赖** | 共享 `dbx-core` | 共享 `dbx-core` |
| **状态管理** | `AppState` + Tauri State | `WebState` 包裹 `AppState` |
| **实时推送** | Tauri 事件系统 | SSE broadcast channels |

---

## 11. 安全特性

### 11.1 密码安全
- **Argon2** 哈希（抗 GPU/ASIC 暴力破解）
- 随机盐值（每次生成独立盐）
- 登录限流（5 次失败 → 60 秒锁定）
- 密码持久化到 SQLite（`save_password_hash`）

### 11.2 会话安全
- UUID v4 随机 Token
- HttpOnly Cookie（防 XSS 窃取）
- SameSite=Lax（防 CSRF）
- 登出时 `Max-Age=0` 立即失效

### 11.3 传输安全
- `rustls` + `aws-lc-rs`（TLS 1.3 支持）
- 密码字段可通过 AES-GCM + PBKDF2 加密存储（`decrypt_config` 端点）

### 11.4 操作安全
- 只读连接保护（写操作前检查）
- 请求体大小限制（默认 1GB，可配置）
- 子路径隔离（支持反向代理部署）

---

## 12. SSE 推送工具（sse.rs）

```rust
pub fn sse_from_channel(
    mut rx: broadcast::Receiver<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        while let Ok(data) = rx.recv().await {
            yield Ok(Event::default().data(data));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}
```

简洁的桥接函数：将 `broadcast::Receiver` 转换为 Axum SSE 流，自动处理 Keep-Alive。

---

## 13. 错误处理（error.rs）

```rust
pub struct AppError(pub String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0).into_response()
    }
}
```

统一错误类型，所有路由通过 `.map_err(AppError)?` 将 `String` 类型错误转换为 HTTP 500 响应。

---

## 14. 数据流图：一次完整的查询执行

```
浏览器
  │
  │ POST /api/query/execute
  │ { connectionId, database, sql, maxRows, ... }
  │
  ▼
auth_middleware
  │ 验证 Cookie 中的 session token
  ▼
routes::query::execute_query
  │ 反序列化 ExecuteQueryRequest
  ▼
dbx_core::query::execute_query_core
  │ 获取连接池 → 执行 SQL → 收集结果
  │ (可能涉及 MySQL/PostgreSQL/SQLite/... 不同驱动)
  ▼
Json(serde_json::to_value(result))
  │ 序列化为 JSON
  ▼
HTTP Response → 浏览器渲染
```

---

## 15. 总结

`dbx-web` 是一个设计清晰的 **Web API 适配层**，其核心价值在于：

1. **薄封装**：路由层几乎不包含业务逻辑，全部委托给 `dbx-core`，保持代码精简
2. **统一模式**：所有路由遵循相同的函数签名、错误处理、请求/响应模式
3. **完整覆盖**：200+ 端点覆盖连接管理、查询执行、Schema 浏览、Redis/MongoDB/消息队列/Nacos 等所有功能
4. **安全加固**：Argon2 密码 + Cookie 会话 + 登录限流 + 只读保护 + TLS
5. **灵活部署**：支持环境变量全面配置（端口/数据目录/密码/子路径/静态文件）
6. **实时推送**：SSE broadcast 通道实现传输/导出/导入进度实时推送
7. **Feature Flag**：通过 `mq-admin` 控制消息队列管理功能的编译/裁剪
