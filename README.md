# DataView

uTools 插件 — 通过超级面板快速预览数据文件，基于 DuckDB。

支持后缀：`csv` · `tsv` · `parquet` · `xlsx` · `xls` · `dta` · `sav` · `por` · `sas7bdat` · `xpt` · `duckdb` · `db`。

## 功能

- **超级面板触发**：在文件管理器选中数据文件 → 唤起超级面板 → 选择 "DataView 预览"
- **分页表格**：粘性表头 + 列类型 badge，每页 200 行（可配），上一页/下一页 + 跳页输入框
- **SQL 查询栏**：折叠/展开（Ctrl+/），当前数据源叫 `dv`，例如 `SELECT * FROM dv WHERE x > 0`，Ctrl+Enter 运行
- **`duckdb` / `db` 文件**：自动列出库内所有表，点击切换
- **设置**：浅 / 深 / 跟随系统主题，每页行数，表格字号，自动持久化
- **扩展自动安装**：`xlsx` 用 `excel`，`dta`/`sav`/`por`/`sas7bdat`/`xpt` 用 community 扩展 `read_stat`，首次使用时由 DuckDB 自动安装并加载

## 安装

从 uTools 插件市场搜索 "DataView" 安装，或本地开发：

```bash
git clone https://github.com/codefoxs/utools-dataview.git
cd utools-dataview
npm install
```

uTools 开发者工具 → 创建本地插件 → 选 `plugin.json`。

## 使用建议

在 uTools 插件设置里勾选：
- **跟随主程序同时启动运行** — 启动期完成 preload 预热
- **退出到后台立即结束运行** 取消勾选 — 保留 in-memory DuckDB 与已加载扩展，下次秒开

## 技术说明

- DuckDB Node 绑定（`duckdb` v1.4.4），运行时只依赖 `lib/binding/duckdb.node`
- 数据源封装为 `TEMP VIEW dv`；用户 SQL 替换渲染层 `TEMP VIEW dv_view`，分页统一对 `dv_view` 取 `LIMIT/OFFSET`
- `BIGINT` 自动转字符串以避免 IPC 序列化问题
- 设置走 `utools.dbStorage`，不写插件目录

## 兼容性

- 当前仅在 Windows / x64 / uTools 7.8.0 (Electron 22) 测试通过
- macOS / Linux 未验证，DuckDB prebuilt 可能需要换版本或 `electron-rebuild`

## License

MIT
