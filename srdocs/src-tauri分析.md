# src-tauri 源码分析

## 1. 模块概述

`src-tauri` 是 DBX 的 **Tauri 桌面应用壳**，负责将 `dbx-core` 核心业务逻辑通过 Tauri IPC（`invoke`）暴露给 Vue 3 前端。它是整个桌面版 DBX 的入口与胶水层。

| 属性 | 值 |
|------|-----|
| **包名** | `dbx`（lib: `dbx_lib`） |
| **版本** | 0.5.56 |
| **框架** | Tauri 2.10.3 |
| **入口** | `src/main.rs` → `lib.rs::run()` |
| **源码文件** | 主文件 6 个 + commands 49 个 + db 1 个 + models 2 个 |
| **总代码量** | ~12,000+ 行（不含 commands 内部细节） |
| **核心依赖** | `dbx-core`、`tauri`、`tokio`、`rustls`、`redis`、`mongodb`、`axum`、`tiberius` 等 |
| **crate-type** | `staticlib` + `cdylib` + `rlib`（支持桌面 + 移动端） |

---

## 2. 目录结构

```
src-tauri/
├── capabilities/
│   └── default.json              # Tauri 权限声明
├── icons/                        # 19 个图标资源
│   ├── icon.ico / icon.icns      #   应用图标（Windows/macOS）
│   ├── icon-black.png            #   黑色主题图标
│   ├── icon-macos-dark.icns      #   macOS 暗色 Dock 图标
│   └── tray-macos-template.png   #   macOS 系统托盘模板图标
├── src/
│   ├── main.rs          (17行)   # 程序入口
│   ├── lib.rs         (1365行)   # Tauri Builder 构建与核心逻辑
│   ├── data_dir.rs     (204行)   # 数据目录解析
│   ├── macos_app_delegate.rs (70行) # macOS Dock 退出拦截
│   ├── window_state_guard.rs (128行) # 窗口边界校正
│   ├── db/mod.rs         (4行)   # DB 模块（空壳）
│   ├── models/          (2文件)  # 模型定义（空壳，re-export 自 dbx-core）
│   └── commands/        (49文件) # IPC 命令模块
│       ├── mod.rs               #   模块注册
│       ├── connection.rs (1271) #   连接管理（最大模块）
│       ├── query.rs      (629)  #   SQL 查询执行
│       ├── mcp_bridge.rs (889)  #   MCP 桥接服务
│       ├── app_settings.rs (526)#   应用设置
│       ├── mq_cmd.rs     (468)  #   消息队列管理
│       ├── mcp.rs        (463)  #   MCP 服务器管理
│       ├── schema.rs     (431)  #   Schema 浏览
│       ├── redis_cmd.rs  (371)  #   Redis 操作
│       ├── mongo_cmd.rs  (333)  #   MongoDB 操作
│       ├── transfer.rs   (331)  #   数据传输
│       ├── support_info.rs (300)#   支持信息收集
│       ├── update.rs     (282)  #   自动更新
│       ├── ... (其余 30+ 模块)
├── windows/nsis/
│   └── installer.nsi            # Windows NSIS 安装器脚本
├── Cargo.toml                   # Rust 依赖配置
├── tauri.conf.json              # Tauri 应用配置
├── Entitlements.plist           # macOS 权限声明
├── Info.plist                   # macOS 应用元数据
└── build.rs                     # 构建脚本
```

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                  Vue 3 前端 (WebView)                     │
│           通过 window.__TAURI__.invoke() 调用             │
└─────────────────────────┬───────────────────────────────┘
                          │ Tauri IPC
┌─────────────────────────▼───────────────────────────────┐
│                     src-tauri                            │
│  ┌────────────────────────────────────────────────────┐ │
│  │  main.rs — 程序入口（DuckDB Worker 分支）            │ │
│  ├────────────────────────────────────────────────────┤ │
│  │  lib.rs — Tauri Builder 构建、插件注册、              │ │
│  │         setup 流程、invoke_handler 命令注册、          │ │
│  │         窗口事件、系统托盘、macOS 菜单                  │ │
│  ├────────────────────────────────────────────────────┤ │
│  │  data_dir.rs — 数据目录解析（Default/Env/Portable）   │ │
│  ├────────────────────────────────────────────────────┤ │
│  │  macos_app_delegate.rs — macOS Dock 退出拦截         │ │
│  ├────────────────────────────────────────────────────┤ │
│  │  window_state_guard.rs — 窗口边界校正                │ │
│  ├────────────────────────────────────────────────────┤ │
│  │  commands/ — 49 个命令模块                            │ │
│  │    connection, query, schema, ai, redis_cmd,         │ │
│  │    mongo_cmd, transfer, mcp_bridge, agents ...       │ │
│  └────────────────────┬───────────────────────────────┘ │
│                       │ 调用                              │
│  ┌────────────────────▼───────────────────────────────┐ │
│  │              dbx-core (核心业务逻辑)                  │ │
│  │   AppState / Storage / 各业务模块                     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  内嵌 Axum HTTP 服务（Redis PubSub WebSocket）       │ │
│  │  MCP Bridge TCP 服务（AI 编码助手桥接）               │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 程序入口（main.rs）

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DuckDB Worker 进程分支
    #[cfg(feature = "duckdb-bundled")]
    if std::env::args().any(|arg| arg == "--duckdb-worker") {
        let runtime = tokio::runtime::Runtime::new().expect("...");
        runtime.block_on(dbx_core::db::duckdb_worker_runtime::run_stdio_worker())?;
        return;
    }

    // 正常启动 → 进入 lib.rs::run()
    dbx_lib::run();
}
```

**关键设计**：
- Release 模式下隐藏 Windows 控制台窗口（`windows_subsystem = "windows"`）
- DuckDB 以**独立进程**方式运行（通过 `--duckdb-worker` 参数自调用），使用 stdio 通信，实现进程隔离避免主进程崩溃
- 正常启动路径调用 `dbx_lib::run()`

---

## 5. Tauri 应用构建（lib.rs）

### 5.1 插件注册

```rust
let builder = tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())          // 深度链接（dbx:// 协议）
    .plugin(tauri_plugin_clipboard_manager::init())   // 剪贴板管理
    .plugin(tauri_plugin_dialog::init())              // 系统对话框
    .plugin(tauri_plugin_fs::init())                  // 文件系统访问
    .plugin(tauri_plugin_single_instance::init(...))  // 单实例锁定
    .plugin(tauri_plugin_shell::init())               // Shell 命令
    .plugin(tauri_plugin_updater::Builder::new().build())  // 自动更新
    .plugin(tauri_plugin_process::init())             // 进程管理
    .plugin(tauri_plugin_window_state::Builder::default().build());  // 窗口状态持久化
```

### 5.2 Setup 流程

`setup()` 闭包完成以下初始化（带启动耗时日志）：

```
[STARTUP] plugins registered in XXms
    │
    ├── 1. 数据目录解析
    │   ├── resolve_data_dir_with_mode() → Default / EnvOverride / Portable
    │   ├── create_dir_all()
    │   └── maybe_import_user_data_db() → 跨模式数据迁移
    │
    ├── 2. 存储层初始化
    │   ├── Storage::open("dbx.db")
    │   ├── migrate_from_json() → JSON → SQLite 迁移
    │   └── load_desktop_settings()
    │
    ├── 3. 日志系统
    │   └── tauri_plugin_log（本地时区 + 自定义格式）
    │
    ├── 4. AppState 创建
    │   ├── 解析插件目录 / 代理目录
    │   ├── AppState::new_with_plugin_and_agent_dir_and_app_version()
    │   ├── set_duckdb_worker_process_isolation_enabled()
    │   └── set_duckdb_worker_max_processes()
    │
    ├── 5. 状态管理
    │   ├── app.manage(state) → Arc<AppState>
    │   ├── app.manage(SavedSqlStorageState)
    │   ├── app.manage(ExternalSqlOpenState)
    │   ├── app.manage(ExternalDbOpenState)
    │   ├── app.manage(DeepLinkOpenState)
    │   └── app.manage(CloseBehaviorState)
    │
    ├── 6. 后台服务启动
    │   ├── redis_pubsub_server::start_pubsub_server()  → 内嵌 Axum WebSocket 服务
    │   └── mcp_bridge::start()                         → MCP TCP 桥接服务
    │
    ├── 7. UI 配置
    │   ├── 禁用原生窗口装饰（Windows/Linux）
    │   ├── 系统托盘图标
    │   ├── 应用图标主题
    │   └── 窗口边界校正
    │
    └── 8. 显示主窗口 + 注册深度链接
[STARTUP] setup complete in XXms (total XXms)
```

### 5.3 命令注册

通过 `tauri::generate_handler![]` 宏注册 **~400 个** `#[tauri::command]` 函数。命令按模块分组：

| 模块 | 命令数 | 代码行数 | 功能 |
|------|--------|---------|------|
| **query** | 50+ | 629 | SQL 执行/取消/各种 SQL 构建辅助 |
| **connection** | 12 | 1271 | 连接测试/建立/断开/保存/加载/健康检查 |
| **schema** | 20+ | 431 | 数据库/表/列/索引/触发器等元数据浏览 |
| **mq_cmd** | ~40 | 468 | Pulsar 消息队列管理（feature-gated） |
| **redis_cmd** | 25+ | 371 | Redis 键扫描/数据类型操作/Pub/Sub/慢查询/集群 |
| **mongo_cmd** | 20+ | 333 | MongoDB 文档 CRUD/索引/聚合/统计 |
| **transfer** | 3 | 331 | 跨库数据传输 |
| **agents** | 18 | 225 | JDBC 代理安装/升级/运行时管理 |
| **ai** | 13 | 183 | AI 补全/流式/Agent/配置/对话管理 |
| **app_settings** | 17 | 526 | 桌面设置/编辑器设置/驱动存储/固定节点 |
| **cloud_sync** | 12 | 204 | WebDAV/片段同步上传下载 |
| **document_cmd** | 12 | 241 | 通用文档存储 + GridFS 文件管理 |
| **nacos_cmd** | 14 | 138 | Nacos 命名空间/配置/服务管理 |
| **plugins** | 12 | 137 | JDBC 驱动/插件管理 |
| **mcp** | 3 | 463 | MCP 服务器状态检查/安装 |
| **导出群** | 8 | — | CSV/XLSX/JSON/Markdown/SQL 导出 |
| **其他** | ~20 | — | history, saved_sql, sql_file, update, keychain 等 |

---

## 6. 数据目录管理（data_dir.rs）

### 6.1 三种模式

```rust
pub enum DataDirMode {
    Default,                    // 系统默认路径（AppData / Application Support）
    EnvOverride,                // DBX_DATA_DIR 环境变量覆盖
    Portable { exe_dir },       // Windows 便携版（exe 同级目录存在 portable.dbx）
}
```

### 6.2 解析优先级

```
1. DBX_DATA_DIR 环境变量 → EnvOverride（最高优先级）
2. exe 同级目录存在 portable.dbx 且不存在 uninstall.exe → Portable
3. 其他 → Default（系统应用数据目录）
```

### 6.3 跨模式数据迁移

```rust
pub fn alternative_data_dir(resolution) -> Option<PathBuf> {
    match mode {
        Portable => Some(default_data_dir),      // 便携版可从默认目录导入
        Default  => Some(portable_data_dir),      // 默认模式可从残留便携目录导入
        EnvOverride => None,                      // 环境变量模式不做隐式导入
    }
}
```

启动时调用 `maybe_import_user_data_db()` 尝试从备用路径导入数据。

**Windows 标记文件**：
| 标记 | 文件名 | 作用 |
|------|--------|------|
| 便携版标记 | `portable.dbx` | 与 exe 同目录表示便携模式 |
| 安装版标记 | `uninstall.exe` | 存在时表示已安装，即使有 portable.dbx 也使用默认模式 |

---

## 7. 窗口与退出行为管理

### 7.1 关闭行为（CloseBehaviorState）

```rust
pub struct CloseBehaviorState {
    confirmed_exit: AtomicBool,  // 原子布尔，线程安全
}
```

**退出确认流程**：

```
用户点击关闭按钮 / Cmd+Q / Dock 退出 / 菜单 Quit
    │
    ├── macOS: applicationShouldTerminate: 拦截（macos_app_delegate.rs）
    │         或 WindowEvent::CloseRequested 拦截
    ├── Windows/Linux: WindowEvent::CloseRequested 拦截
    │
    ├── confirmed_exit == false → prevent_close/exit
    │   → 发送 "dbx-app-close-requested" 事件给前端
    │   → 前端弹出确认对话框
    │   → 用户确认 → allow_next_exit() → 再次触发关闭
    │
    └── confirmed_exit == true → 正常退出
```

**平台差异**：
- **macOS/Windows**：关闭窗口时隐藏窗口（不退出），通过托盘或菜单退出
- **Linux**：关闭窗口直接退出
- **重启退出码**（`RESTART_EXIT_CODE`）：跳过确认直接退出

### 7.2 全屏隐藏处理（macOS）

```rust
pub(crate) fn hide_main_window_for_close(app, window) {
    clear_main_webview_focus(app);  // JS: 将焦点转移到 body

    #[cfg(target_os = "macos")]
    if window.is_fullscreen() {
        // 先退出全屏 → 等待动画完成（最多 2 秒） → 再隐藏窗口
        window.set_fullscreen(false);
        // 轮询 40 次 × 50ms = 2s 等待退出全屏
        // 退出后再等 600ms 让动画完成
        // 最后在主线程执行 hide
    }
}
```

### 7.3 窗口边界校正（window_state_guard.rs）

```rust
pub(crate) fn enforce_main_window_bounds(app) {
    // 获取当前显示器尺寸
    // 如果窗口位置/大小超出显示器范围：
    //   - 缩小到显示器尺寸
    //   - 居中到显示器内
    //   - 保存校正后的窗口状态
}
```

解决的问题：外接显示器拔除后窗口跑到屏幕外、多显示器切换后窗口不可见。

### 7.4 macOS Dock 退出拦截（macos_app_delegate.rs）

通过 Objective-C Runtime 向 Tauri 底层的 `TaoAppDelegateParent` 类动态添加 `applicationShouldTerminate:` 方法：

```rust
pub(crate) fn install_dock_quit_handler(app) {
    // 找到 TaoAppDelegateParent 类（Tauri 底层窗口库 Tao 注册的）
    // 动态添加 applicationShouldTerminate: 方法
    // 该方法检查 CloseBehaviorState → 未确认则 Cancel + 发送前端事件
}
```

**为什么需要**：Tao 未实现 `applicationShouldTerminate:`，Dock 右键退出会绕过 Tauri 的 `ExitRequested` 事件。

---

## 8. 系统托盘

### 8.1 托盘创建

```rust
fn setup_desktop_tray(manager, icon_theme) {
    let menu = MenuBuilder::new()
        .text("show", "Show DBX")
        .separator()
        .text("quit", "Quit DBX")
        .build();

    TrayIconBuilder::with_id("main-tray")
        .tooltip("DBX")
        .menu(&menu)
        .show_menu_on_left_click(false)  // 左键不弹菜单（弹主窗口）
        // macOS: 模板图标（自动适配明暗主题）
        // Windows: 根据 icon_theme 选择默认/黑色图标
        .build()
}
```

### 8.2 托盘事件

| 事件 | 行为 |
|------|------|
| 左键单击 / 双击 | 显示主窗口 |
| 菜单 "Show DBX" | 显示主窗口 |
| 菜单 "Quit DBX" | 触发退出确认流程 |

### 8.3 平台条件

```rust
fn should_setup_desktop_tray(target_os, show_tray_icon, linux_appindicator_available) -> bool {
    show_tray_icon && (macOS || Windows || (Linux && appindicator 库可用))
}
```

Linux 需要 `libayatana-appindicator3.so.1` 或 `libappindicator3.so.1`（通过 `libloading` 动态探测）。

---

## 9. macOS 原生菜单

```rust
fn build_app_menu(app_handle) -> Menu {
    Menu::with_items(&[
        Submenu(app_name, &[
            About(自定义 metadata + 支持信息),
            "Copy Support Info",    // 复制系统信息到剪贴板
            Separator, Services, Separator,
            Hide / Hide Others, Separator,
            "Quit DBX" (Cmd+Q),
        ]),
        Submenu("File", &[CloseWindow]),
        Submenu("Edit", &[Undo, Redo, Cut, Copy, Paste, SelectAll]),
        Submenu("View", &[Fullscreen]),
        Submenu("Window", &[Minimize, Maximize, CloseWindow]),
        Submenu("Help", &[]),
    ])
}
```

仅在 macOS 上安装原生菜单，Linux/Windows 不安装（避免空菜单栏）。

---

## 10. macOS 交通灯控制（window_controls.rs）

通过 Objective-C Runtime 直接操作 NSWindow 的交通灯按钮位置：

```rust
#[tauri::command]
pub async fn set_macos_traffic_light_position(window, x, y, scale) -> MacosTrafficLightLayout {
    // 获取 NSWindow 引用
    // 找到 close/miniaturize/zoom 三个按钮
    // 计算标题栏容器视图的新尺寸
    // 重新定位三个按钮的 frame
    // 返回布局信息（x, y, center_y, reserved_inset）
}
```

**用途**：实现自定义标题栏时精确控制交通灯按钮位置，使其与前端 UI 对齐。

---

## 11. 内嵌服务

### 11.1 Redis PubSub WebSocket 服务（redis_pubsub_server.rs）

桌面版内嵌一个 Axum HTTP 服务，为前端提供 Redis PubSub 的 WebSocket 实时推送：

```rust
pub fn start_pubsub_server(state: Arc<AppState>) {
    let router = Router::new()
        .route("/api/redis/pubsub/ws", get(ws_handler))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let port = pubsub_server_port();  // DBX_PORT 环境变量或默认 4224
        let listener = TcpListener::bind(addr).await?;
        axum::serve(listener, router).await?;
    });
}
```

**WebSocket 协议**：
- 前端通过 `ws://localhost:4224/api/redis/pubsub/ws?connectionId=xxx` 连接
- 发送 JSON 命令：`{"type":"subscribe","channels":["ch1"]}` / `{"type":"psubscribe","patterns":["pat*"]}`
- 接收 Redis 消息：`{"channel":"ch1","pattern":null,"payload":"data"}`

### 11.2 MCP Bridge 服务（mcp_bridge.rs）

后台运行的 MCP（Model Context Protocol）桥接服务，为 AI 编码助手提供数据库上下文：

```rust
pub fn start(app_handle: AppHandle, state: Arc<AppState>, data_dir: PathBuf) {
    // 1. 启动 TCP 服务，绑定到 127.0.0.1:随机端口
    // 2. 将端口写入 {data_dir}/mcp-bridge-port 文件
    // 3. 接受 JSON-RPC 请求
}
```

**支持的 MCP 操作**：
| 请求 | 功能 |
|------|------|
| `open_table` | 在 DBX 中打开表 |
| `execute_query` | 执行 SQL 查询（支持只读/写入控制） |
| `list_tables` | 列出表 |
| `describe_table` | 描述表结构 |
| `find_documents` | MongoDB 文档查询 |

**安全控制**：
- `allow_writes` 参数控制是否允许写操作
- `allow_dangerous` 参数控制是否允许危险操作（DROP 等）
- 通过 `ensure_connection_writable()` 检查连接只读保护

---

## 12. 深度链接与文件关联

### 12.1 深度链接协议

```json
// tauri.conf.json
"deep-link": { "desktop": { "schemes": ["dbx"] } }
```

支持 `dbx://connection/new?type=mysql&host=127.0.0.1` 格式。

### 12.2 文件关联

```json
"fileAssociations": [
    { "ext": ["sql"], "role": "Editor" },
    { "ext": ["db", "sqlite", "sqlite3", "duckdb"], "role": "Editor" }
]
```

### 12.3 单实例处理

```rust
.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
    // 第二个实例启动时 → 解析参数 → 发送给第一个实例
    let links = connection_deep_links_from_args(args);
    open_connection_deep_links(app, links);

    let paths = sql_file_paths_from_args(args, cwd);
    emit("dbx-open-sql-files", paths);

    let db_paths = db_file_paths_from_args(args, cwd);
    emit("dbx-open-db-files", db_paths);

    show_main_window(app);
}))
```

### 12.4 外部文件处理

| 模块 | 支持扩展名 | 功能 |
|------|-----------|------|
| **external_sql.rs** | `.sql` | 读取/写入外部 SQL 文件（支持 GBK 编码自动检测） |
| **external_db.rs** | `.db` `.db3` `.sqlite` `.sqlite3` `.duckdb` | 打开外部数据库文件 |

两者都使用 `Mutex<Vec<String>>` 管理待打开文件队列，支持去重。

---

## 13. Linux 兼容性处理

### 13.1 NVIDIA GPU WebKit 渲染修复

```rust
fn linux_has_nvidia_gpu() -> bool {
    Path::new("/dev/nvidiactl").exists()
        || Path::new("/proc/driver/nvidia/version").exists()
}

fn linux_webkit_rendering_workarounds(has_nvidia) -> &[(&str, &str)] {
    if has_nvidia {
        &[("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
          ("__NV_DISABLE_EXPLICIT_SYNC", "1")]  // 禁用 DMABuf 避免白屏
    } else {
        &[]  // AMD/Intel 使用 Mesa DMABuf 正常
    }
}
```

### 13.2 AppImage Wayland 后端

```rust
fn linux_appimage_wayland_backend_override(...) -> Option<&str> {
    // AppImage + Wayland + 未手动设置 GDK_BACKEND
    // → 优先使用 X11（XWayland），避免 EGL 兼容问题
    Some("x11,wayland,*")
}
```

### 13.3 AppImage GTK 输入法模块

```rust
fn linux_appimage_system_gtk_immodules_cache(...) -> Option<&str> {
    // AppImage 打包的 immodules.cache 会隐藏宿主系统的 fcitx5/ibus
    // → 替换为系统级 immodules.cache 路径
}
```

---

## 14. 运行事件处理

```rust
.run(|app_handle, event| {
    // ExitRequested — 退出确认拦截（macOS/Windows）
    if ExitRequested { prevent_exit + request_app_close }

    // macOS: Opened — 文件/URL 打开
    if RunEvent::Opened { urls } {
        解析 dbx:// 链接 → emit("dbx-open-connection-links")
        解析 .sql 文件 → emit("dbx-open-sql-files")
        解析 .db/.sqlite 文件 → emit("dbx-open-db-files")
    }

    // macOS: Reopen — Dock 点击重新打开窗口
    if RunEvent::Reopen { has_visible_windows: false } {
        show_main_window()
        refresh_connections()  // 恢复时刷新连接
    }

    // Resumed — 系统恢复（所有平台）
    if RunEvent::Resumed {
        refresh_connections()
    }
})
```

---

## 15. 桌面设置应用

```rust
pub(crate) fn apply_desktop_settings(app, desktop_settings) {
    // 1. 日志级别（Debug / Off）
    apply_debug_log_level(desktop_settings.debug_logging_enabled);

    // 2. 图标主题
    apply_desktop_icon_theme(app, desktop_settings.icon_theme);
    //   macOS: 通过 NSApplication.setApplicationIconImage() 更新 Dock 图标
    //   Windows/Linux: 通过 window.set_icon() 更新窗口图标

    // 3. 系统托盘
    if should_setup_desktop_tray(...) {
        tray.set_visible(desktop_settings.show_tray_icon);
        apply_desktop_tray_icon_theme(app, desktop_settings.icon_theme);
    }
}
```

---

## 16. Feature Flags

| Feature | 默认 | 说明 |
|---------|------|------|
| `duckdb-bundled` | 启用 | 内嵌 DuckDB 引擎 + Worker 进程隔离 |
| `mq-admin` | 启用 | Pulsar 消息队列管理（~40 个命令） |
| `sqlite-sqlcipher` | 启用 | SQLite 加密支持 |

---

## 17. Tauri 配置（tauri.conf.json）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| **identifier** | `com.dbx.app` | 应用唯一标识 |
| **窗口** | 1280×800, min 900×600 | 初始尺寸，可缩放 |
| **titleBarStyle** | Overlay | macOS 交通灯按钮覆盖在内容上 |
| **trafficLightPosition** | (16, 18) | 交通灯按钮位置 |
| **visible** | false | 初始隐藏，setup 完成后手动显示 |
| **frontendDist** | `../dist` | 前端构建产物路径 |
| **devUrl** | `http://localhost:1420` | 开发模式 Vite 地址 |
| **CSP** | null | 不限制内容安全策略 |
| **updater** | 双端点 | `dl.dbxio.com` + GitHub Releases |
| **fileAssociations** | .sql / .db / .sqlite / .sqlite3 / .duckdb | 文件关联 |
| **deep-link schemes** | `dbx` | 深度链接协议 |
| **Windows 安装器** | NSIS, currentUser 模式 | 自定义安装脚本 |

---

## 18. 关键设计模式

### 18.1 命令函数签名模式

所有 `#[tauri::command]` 函数遵循统一签名：

```rust
#[tauri::command]
pub async fn some_command(
    state: State<'_, AppState>,        // 全局状态
    // ... 其他参数由前端传入
) -> Result<T, String> {
    // 委托给 dbx_core 实现
    dbx_core::some_module::some_core_function(&state, ...).await
}
```

### 18.2 薄封装层

commands 层是 `dbx-core` 的**薄封装**：
- 参数反序列化由 Tauri 自动处理
- 业务逻辑全部在 `dbx-core`
- commands 层仅做参数转发和错误转换（`Result<T, String>`）

### 18.3 启动耗时追踪

```rust
let startup_begin = Instant::now();
eprintln!("[STARTUP] plugins registered in {:?}", startup_begin.elapsed());
eprintln!("[STARTUP]   Storage::open in {:?}", t.elapsed());
eprintln!("[STARTUP]   migrate_from_json in {:?}", t2.elapsed());
eprintln!("[STARTUP] setup complete in {:?}", setup_start.elapsed());
```

### 18.4 条件编译

大量使用 `#[cfg(...)]` 处理平台差异：
- `#[cfg(target_os = "macos")]` — macOS 菜单、Dock 处理、图标主题、交通灯控制
- `#[cfg(target_os = "linux")]` — WebKit 渲染修复、AppImage 兼容、libloading 探测
- `#[cfg(target_os = "windows")]` — 便携版标记检测
- `#[cfg(feature = "duckdb-bundled")]` — DuckDB Worker
- `#[cfg(feature = "mq-admin")]` — MQ 命令注册

### 18.5 状态管理模式

```rust
// 核心状态 — Arc 包裹，通过 Tauri manage 注入
app.manage(Arc::new(AppState { ... }));

// 辅助状态 — 独立管理，使用 Mutex<Vec> 做待处理队列
app.manage(SavedSqlStorageState { data_dir });   // 存储路径
app.manage(ExternalSqlOpenState::default());      // 待打开 SQL 文件队列
app.manage(ExternalDbOpenState::default());       // 待打开数据库文件队列
app.manage(DeepLinkOpenState::default());         // 待处理深度链接队列
app.manage(CloseBehaviorState::new());            // 退出确认状态
```

### 18.6 Pending Queue 模式

`DeepLinkOpenState`、`ExternalSqlOpenState`、`ExternalDbOpenState` 都使用相同的模式：

```rust
pub struct SomeOpenState {
    pending: Mutex<Vec<String>>,  // 待处理队列
}

impl SomeOpenState {
    pub fn push(&self, items: Vec<String>) { ... }  // 入队
    fn drain(&self) -> Vec<String> { ... }           // 消费并清空
}

#[tauri::command]
pub fn pending_open_xxx(state: State<SomeOpenState>) -> Vec<String> {
    // 合并启动参数 + pending 队列 → 去重 → 返回
}
```

前端通过 `invoke("pending_open_xxx")` 获取待处理项，实现异步的文件/链接打开。

---

## 19. 与 dbx-web 的对比

| 维度 | src-tauri（桌面版） | dbx-web（Web 版） |
|------|---------------------|-------------------|
| **框架** | Tauri 2（原生窗口 + WebView） | Axum 0.8（HTTP 服务） |
| **前端通信** | Tauri IPC（invoke） | HTTP REST + SSE + WebSocket |
| **认证** | 无（本地应用） | Argon2 + Cookie Session |
| **命令数量** | ~400 个 | ~200+ 个 HTTP 端点 |
| **状态管理** | `AppState` + Tauri State | `WebState` 包裹 `AppState` |
| **实时推送** | Tauri 事件系统 + 内嵌 WebSocket | SSE broadcast channels |
| **窗口管理** | 原生窗口（隐藏/显示/聚焦/全屏） | 无 |
| **系统托盘** | 有（Show/Quit） | 无 |
| **自动更新** | tauri-plugin-updater（双端点） | 无（Docker 镜像更新） |
| **深度链接** | `dbx://` 协议 | 无 |
| **文件关联** | .sql / .db / .sqlite / .duckdb | 无 |
| **单实例** | tauri-plugin-single-instance | 无 |
| **桌面设置** | 图标主题/托盘/调试日志/DuckDB配置 | 无 |
| **MCP Bridge** | 内嵌 TCP 服务 | 无（通过 HTTP API 提供） |
| **Redis PubSub** | 内嵌 Axum WebSocket | 直接 HTTP 路由 |
| **平台特殊代码** | macOS/Linux/Windows 大量条件编译 | 无（纯 HTTP 服务） |
| **核心依赖** | 共享 `dbx-core` | 共享 `dbx-core` |

---

## 20. 总结

`src-tauri` 是一个功能丰富的 **Tauri 桌面应用壳**，其核心价值在于：

1. **完整的桌面集成**：系统托盘、原生菜单、深度链接、文件关联、单实例、自动更新
2. **跨平台兼容**：macOS/Windows/Linux 三平台窗口行为、图标主题、渲染修复、交通灯控制
3. **~400 个 IPC 命令**：覆盖连接/查询/Schema/Redis/MongoDB/MQ/Nacos/传输/导入导出/AI 等全功能
4. **进程隔离**：DuckDB 以独立 Worker 进程运行，通过 stdio 通信，避免主进程崩溃
5. **内嵌服务**：Redis PubSub WebSocket（Axum）+ MCP Bridge（TCP），扩展桌面端能力
6. **优雅退出**：AtomicBool 确认机制，防止误关，支持前端确认对话框
7. **启动性能追踪**：每个阶段打印 `[STARTUP]` 耗时日志
8. **Pending Queue 模式**：统一的异步文件/链接打开机制
9. **薄封装设计**：与 dbx-web 共享 dbx-core，保持代码精简和逻辑一致
