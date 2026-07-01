# DB Manager

Trình quản lý database đa nền tảng (giống Navicat) cho **MongoDB, Redis, MariaDB/MySQL, PostgreSQL**.
Xây bằng Electron + React + TypeScript + Ant Design.

## Chạy dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build      # đóng gói main/preload/renderer vào out/
npm run typecheck  # kiểm tra kiểu (node + web)
```

## Kiến trúc

```
src/
├── shared/types.ts        # Kiểu dùng chung + interface DatabaseAdapter + giao thức IPC
├── main/                  # Node process: driver DB chạy ở đây
│   ├── index.ts           # tạo cửa sổ, bật contextIsolation
│   ├── ipc.ts             # đăng ký handler IPC
│   ├── secure-store.ts    # lưu kết nối, mã hóa mật khẩu bằng safeStorage
│   ├── session-manager.ts # giữ adapter đang mở theo connectionId
│   └── adapters/          # 1 file / loại DB, cùng hiện thực DatabaseAdapter
│       ├── mariadb.ts     (mysql2)
│       ├── postgres.ts    (pg)
│       ├── mongo.ts       (mongodb)
│       └── redis.ts       (ioredis)
├── preload/index.ts       # contextBridge -> window.api (typed)
└── renderer/src/          # React UI
    ├── App.tsx            # layout sidebar + tabs
    └── components/        # Sidebar, ConnectionModal, DataGridView, QueryPanel
```

**Nguyên tắc bảo mật:** driver DB chỉ chạy ở main process; renderer không có quyền Node,
chỉ gọi qua `window.api` (preload) → IPC. Mật khẩu được mã hóa bằng keychain OS (`safeStorage`).

**Điểm mở rộng:** thêm loại DB mới = thêm 1 adapter hiện thực `DatabaseAdapter` và đăng ký trong
`adapters/index.ts`. UI tự thích ứng theo `capabilities` (SQL editor, mô hình dữ liệu…).

## Trạng thái / lộ trình

- [x] Scaffold Electron + IPC có type
- [x] Quản lý kết nối (CRUD, test, lưu mã hóa)
- [x] Cây database lazy-load + duyệt dữ liệu (grid có phân trang)
- [x] Query editor (Monaco) cho cả 4 loại DB
- [ ] Sửa dữ liệu inline trong grid
- [ ] Import/Export CSV/JSON/SQL
- [ ] Xem cấu trúc bảng (structure tab), tạo/sửa schema
