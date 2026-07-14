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
| **核心依赖** | `dbx-core`、`tauri`、`tokio`、`rustls`、`redis`、`mongodb` 等 |

---

## 2. 架构总览

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
└─────────────────────────────────────────────────────────┘
```

---

## 3. 程序入口（main.rs）

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
- Release 模式下隐藏 Windows 控制台窗口
- DuckDB 以**独立进程**方式运行（通过 `--duckdb-worker` 参数自调用），使用 stdio 通信，实现进程隔离
- 正常启动路径调用 `dbx_lib::run()`

---

## 4. Tauri 应用构建（lib.rs）

### 4.1 插件注册

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

### 4.2 Setup 流程

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
    │   ├── app.manage(state) → AppState
    │   ├── app.manage(SavedSqlStorageState)
    │   ├── app.manage(ExternalSqlOpenState)
    │   ├── app.manage(ExternalDbOpenState)
    │   ├── app.manage(DeepLinkOpenState)
    │   └── app.manage(CloseBehaviorState)
    │
    ├── 6. 后台服务启动
    │   ├── redis_pubsub_server::start_pubsub_server()
    │   └── mcp_bridge::start()
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

### 4.3 命令注册

通过 `tauri::generate_handler![]` 宏注册 **~400 个** `#[tauri::command]` 函数，覆盖所有前端可调用的功能。命令按模块分组：

| 模块 | 命令数 | 功能 |
|------|--------|------|
| **ai** | 13 | AI 补全/流式/Agent/配置/对话管理 |
| **app_settings** | 17 | 桌面设置/编辑器设置/驱动存储/固定节点/标签页状态 |
| **cloud_sync** | 12 | WebDAV/片段同步上传下载 |
| **connection** | 12 | 连接测试/建立/断开/保存/加载/健康检查 |
| **query** | 50+ | SQL 执行/取消/各种 SQL 构建辅助 |
| **schema** | 20+ | 数据库/表/列/索引/触发器等元数据浏览 |
| **schema_diff** | 2 | Schema 对比与同步 SQL 生成 |
| **redis_cmd** | 25+ | Redis 键扫描/数据类型操作/Pub/Sub/慢查询/集群 |
| **mongo_cmd** | 20+ | MongoDB 文档 CRUD/索引/聚合/统计 |
| **document_cmd** | 12 | 通用文档存储 + GridFS 文件管理 |
| **mq_cmd** | ~40 | Pulsar 消息队列管理（feature-gated） |
| **nacos_cmd** | 14 | Nacos 命名空间/配置/服务管理 |
| **etcd_cmd** | 4 | etcd KV 操作 |
| **zookeeper_cmd** | 4 | ZooKeeper KV 操作 |
| **transfer** | 3 | 跨库数据传输 |
| **agents** | 18 | JDBC 代理安装/升级/运行时管理 |
| **plugins** | 12 | JDBC 驱动/插件管理 |
| **mcp** | 3 | MCP 服务器状态检查/安装 |
| **mcp_bridge** | — | MCP 桥接服务（后台运行，非命令） |
| **导出群** | 8 | CSV/XLSX/JSON/Markdown/SQL 导出 |
| **其他** | ~20 | history, saved_sql, sql_file, update, keychain 等 |

---

## 5. 数据目录管理（data_dir.rs）

### 5.1 三种模式

```rust
pub enum DataDirMode {
    Default,                    // 系统默认路径（AppData / Application Support）
    EnvOverride,                // DBX_DATA_DIR 环境变量覆盖
    Portable { exe_dir },       // Windows 便携版（exe 同级目录存在 portable.dbx）
}
```

### 5.2 解析优先级

```
1. DBX_DATA_DIR 环境变量 → EnvOverride（最高优先级）
2. exe 同级目录存在 portable.dbx 且不存在 uninstall.exe → Portable
3. 其他 → Default（系统应用数据目录）
```

### 5.3 跨模式数据迁移

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

---

## 6. 窗口与退出行为管理

### 6.1 关闭行为（CloseBehaviorState）

```rust
pub struct CloseBehaviorState {
    confirmed_exit: AtomicBool,  // 原子布尔，线程安全
}
```

**退出确认流程**：

```
用户点击关闭按钮 / Cmd+Q / Dock 退出
    │
    ├── macOS: applicationShouldTerminate: 拦截
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

### 6.2 窗口边界校正（window_state_guard.rs）

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

### 6.3 macOS Dock 退出拦截（macos_app_delegate.rs）

通过 Objective-C Runtime 向 Tauri 的 `TaoAppDelegateParent` 类动态添加 `applicationShouldTerminate:` 方法：

```rust
pub(crate) fn install_dock_quit_handler(app) {
    // 找到 TaoAppDelegateParent 类
    // 添加 applicationShouldTerminate: 方法
    // 该方法检查 CloseBehaviorState → 未确认则 Cancel + 发送前端事件
}
```

**为什么需要**：Tao（Tauri 底层窗口库）未实现 `applicationShouldTerminate:`，Dock 右键退出会绕过 Tauri 的 `ExitRequested` 事件。

---

## 7. 系统托盘

### 7.1 托盘创建

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
        .show_menu_on_left_click(false)  // 左键不弹菜单
        // macOS: 模板图标（自动适配明暗主题）
        // Windows: 根据 icon_theme 选择默认/黑色图标
        .build()
}
```

### 7.2 托盘事件

| 事件 | 行为 |
|------|------|
| 左键单击 / 双击 | 显示主窗口 |
| 菜单 "Show DBX" | 显示主窗口 |
| 菜单 "Quit DBX" | 触发退出确认流程 |

### 7.3 平台条件

```rust
fn should_setup_desktop_tray(target_os, show_tray_icon, linux_appindicator_available) -> bool {
    show_tray_icon && (macOS || Windows || (Linux && appindicator 库可用))
}
```

Linux 需要 `libayatana-appindicator3.so.1` 或 `libappindicator3.so.1`。

---

## 8. macOS 原生菜单

```rust
fn build_app_menu(app_handle) -> Menu {
    Menu::with_items(&[
        Submenu(app_name, &[
            About(自定义 metadata),
            "Copy Support Info",    // 复制系统信息到剪贴板
            Separator,
            Services,
            Separator,
            Hide / Hide Others,
            Separator,
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

---

## 9. Linux 兼容性处理

### 9.1 NVIDIA GPU WebKit 渲染修复

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

### 9.2 AppImage Wayland 后端

```rust
fn linux_appimage_wayland_backend_override(appimage, wayland, gdk_backend) -> Option<&str> {
    // AppImage + Wayland + 未手动设置 GDK_BACKEND
    // → 优先使用 X11（XWayland），避免 EGL 兼容问题
    Some("x11,wayland,*")
}
```

### 9.3 AppImage GTK 输入法模块

```rust
fn linux_appimage_system_gtk_immodules_cache(...) -> Option<&str> {
    // AppImage 打包的 immodules.cache 会隐藏宿主系统的 fcitx5/ibus
    // → 替换为系统级 immodules.cache 路径
}
```

---

## 10. 深度链接（Deep Link）

### 10.1 协议注册

```json
// tauri.conf.json
"deep-link": { "desktop": { "schemes": ["dbx"] } }
```

支持 `dbx://` 协议打开数据库连接。

### 10.2 单实例处理

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

### 10.3 文件关联

```json
"fileAssociations": [
    { "ext": ["sql"], "role": "Editor" },
    { "ext": ["db", "sqlite", "sqlite3", "duckdb"], "role": "Editor" }
]
```

macOS 通过 `RunEvent::Opened { urls }` 处理文件打开。

---

## 11. 桌面设置应用

```rust
pub(crate) fn apply_desktop_settings(app, desktop_settings) {
    // 1. 日志级别
    apply_debug_log_level(desktop_settings.debug_logging_enabled);

    // 2. 图标主题（macOS: NSApplication 图标 / Windows: 窗口图标）
    apply_desktop_icon_theme(app, desktop_settings.icon_theme);

    // 3. 系统托盘
    if should_setup_desktop_tray(...) {
        tray.set_visible(desktop_settings.show_tray_icon);
        apply_desktop_tray_icon_theme(app, desktop_settings.icon_theme);
    }
}
```

---

## 12. 运行事件处理

```rust
.run(|app_handle, event| {
    // ExitRequested — 退出确认拦截
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

## 13. Feature Flags

| Feature | 默认 | 说明 |
|---------|------|------|
| `duckdb-bundled` | 启用 | 内嵌 DuckDB 引擎 + Worker 进程隔离 |
| `mq-admin` | 启用 | Pulsar 消息队列管理（~40 个命令） |
| `sqlite-sqlcipher` | 启用 | SQLite 加密支持 |

---

## 14. Tauri 配置（tauri.conf.json）

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

---

## 15. Commands 模块详解

### 15.1 连接管理（connection.rs，1271 行）

最庞大的命令模块，管理数据库连接完整生命周期：

- `test_connection` — 临时创建连接测试后清理
- `connect_db` — 建立连接（含 `client_attempt` 乐观锁）
- `disconnect_db` — 断开连接
- `save_connections` / `load_connections` — 持久化配置
- `check_connection_health` — 健康检查
- `refresh_connections` — 系统恢复时刷新所有连接

### 15.2 查询执行（query.rs，629 行）

50+ 命令，涵盖：
- SQL 执行（execute/execute-multi/execute-batch/execute-script/execute-in-transaction）
- 手动事务（begin/commit/rollback）
- 查询取消
- 各类 SQL 构建辅助（DDL/DML/数据网格/导出）

### 15.3 MCP 桥接（mcp_bridge.rs，889 行）

后台运行的 MCP（Model Context Protocol）服务：
- 为 AI 编码助手（Claude Code/Cursor）提供数据库上下文
- 独立于命令注册，在 setup 阶段通过 `mcp_bridge::start()` 启动

### 15.4 MCP 服务器管理（mcp.rs，463 行）

- `check_mcp_server_status` — 检查 MCP 服务器状态
- `install_mcp_server` — 安装/配置 MCP 服务器

### 15.5 应用设置（app_settings.rs，526 行）

- 桌面设置加载/保存（`DesktopSettings`）
- 编辑器设置加载/保存
- 驱动/插件/代理存储目录配置
- 固定树节点、标签页状态、SQL 编辑器位置
- 应用关闭完成确认（`complete_app_close`）

### 15.6 数据传输（transfer.rs，331 行）

- `start_transfer` — 启动跨库传输
- `preview_transfer_ownership` — 预览传输归属
- `cancel_transfer` — 取消传输
- 通过 Tauri 事件系统推送进度

### 15.7 更新管理（update.rs，282 行）

- `check_for_updates` — 检查更新
- `download_and_install_update` — 下载安装
- `get_system_proxy_url` — 获取系统代理

### 15.8 支持信息（support_info.rs，300 行）

- `get_app_support_info` — 收集系统信息（OS/版本/驱动/GPU 等）
- `format_support_info_for_clipboard` — 格式化到剪贴板
- `format_support_info_for_native_about` — macOS About 对话框

---

## 16. 关键设计模式

### 16.1 命令函数签名模式

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

### 16.2 薄封装层

与 `dbx-web` 类似，commands 层是 `dbx-core` 的薄封装：
- 参数反序列化由 Tauri 自动处理
- 业务逻辑全部在 `dbx-core`
- commands 层仅做参数转发和错误转换

### 16.3 启动耗时追踪

```rust
let startup_begin = Instant::now();
// ... 各阶段
eprintln!("[STARTUP] plugins registered in {:?}", startup_begin.elapsed());
eprintln!("[STARTUP]   Storage::open in {:?}", t.elapsed());
eprintln!("[STARTUP] setup complete in {:?}", setup_start.elapsed());
```

### 16.4 条件编译

大量使用 `#[cfg(...)]` 处理平台差异：
- `#[cfg(target_os = "macos")]` — macOS 菜单、Dock 处理、图标主题
- `#[cfg(target_os = "linux")]` — WebKit 渲染修复、AppImage 兼容
- `#[cfg(feature = "duckdb-bundled")]` — DuckDB Worker
- `#[cfg(feature = "mq-admin")]` — MQ 命令注册

### 16.5 状态管理模式

```rust
// AppState — 核心业务状态（Arc 包裹）
app.manage(Arc::new(AppState { ... }));

// 辅助状态 — 独立管理
app.manage(SavedSqlStorageState { data_dir });
app.manage(ExternalSqlOpenState::default());
app.manage(ExternalDbOpenState::default());
app.manage(DeepLinkOpenState::default());
app.manage(CloseBehaviorState::new());
```

---

## 17. 与 dbx-web 的对比

| 维度 | src-tauri（桌面版） | dbx-web（Web 版） |
|------|---------------------|-------------------|
| **框架** | Tauri 2（原生窗口 + WebView） | Axum 0.8（HTTP 服务） |
| **前端通信** | Tauri IPC（invoke） | HTTP REST + SSE + WebSocket |
| **认证** | 无（本地应用） | Argon2 + Cookie Session |
| **命令数量** | ~400 个 | ~200+ 个 HTTP 端点 |
| **状态管理** | `AppState` + Tauri State | `WebState` 包裹 `AppState` |
| **实时推送** | Tauri 事件系统 | SSE broadcast channels |
| **窗口管理** | 原生窗口（隐藏/显示/聚焦） | 无 |
| **系统托盘** | 有 | 无 |
| **自动更新** | tauri-plugin-updater | 无（Docker 镜像更新） |
| **深度链接** | `dbx://` 协议 | 无 |
| **文件关联** | .sql / .db / .sqlite / .duckdb | 无 |
| **单实例** | tauri-plugin-single-instance | 无 |
| **桌面设置** | 图标主题/托盘/调试日志 | 无 |
| **平台特殊代码** | macOS/Linux/Windows 大量条件编译 | 无（纯 HTTP 服务） |
| **核心依赖** | 共享 `dbx-core` | 共享 `dbx-core` |

---

## 18. 总结

`src-tauri` 是一个功能丰富的 **Tauri 桌面应用壳**，其核心价值在于：

1. **完整的桌面集成**：系统托盘、原生菜单、深度链接、文件关联、单实例、自动更新
2. **跨平台兼容**：macOS/Windows/Linux 三平台窗口行为、图标主题、渲染修复
3. **~400 个 IPC 命令**：覆盖连接/查询/Schema/Redis/MongoDB/MQ/Nacos/传输/导入导出/AI 等全功能
4. **进程隔离**：DuckDB 以独立 Worker 进程运行，通过 stdio 通信
5. **优雅退出**：AtomicBool 确认机制，防止误关，支持前端确认对话框
6. **启动性能追踪**：每个阶段打印耗时日志
7. **MCP 桥接**：后台运行 MCP 服务，为 AI 编码助手提供数据库上下文
8. **薄封装设计**：与 dbx-web 共享 dbx-core，保持代码精简和逻辑一致
