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

## Đóng gói (electron-builder)

Sản phẩm xuất ra `release/<version>/` (đã được `.gitignore`).

```bash
npm run dist:mac      # macOS: dmg + zip (stamp version, không upload)
npm run dist:win      # Windows: installer nsis
npm run dist:linux    # Linux: AppImage + deb
npm run release:mac   # build + upload lên S3/CDN
npm run publish       # chỉ upload bản build mới nhất trong release/
```

- **Version tự động**: mỗi lần `dist:*`/`release:*` chạy `scripts/release.mjs` sẽ đặt version =
  `YYYY.MMDD.HHMMSS` (thời điểm build) trong 1 tiến trình duy nhất → mỗi bản build 1 version khác nhau.
  Sản phẩm ra `release/<version>/` (đã `.gitignore`).
- **Publish lên S3/CDN**: `scripts/publish.mjs` upload thư mục build mới nhất lên bucket S3
  (VNG vStorage) và in link CDN. Cấu hình để trong `.env` (xem `.env.example`); `.env` KHÔNG commit.
- Cấu hình đóng gói ở `electron-builder.yml`; icon nguồn `build/icon.png` (1024×1024) → tự sinh `.icns`/`.ico`.
- **Code signing macOS** bị bỏ qua nếu chưa có "Developer ID Application"; app vẫn chạy local nhưng
  cần Developer ID + notarize để phân phối rộng.
- Build `--win`/`--linux` từ máy Mac cần thêm công cụ (Wine/Mono, hoặc dùng CI/Docker).
- Nếu gặp lỗi TLS self-signed cert (mạng công ty), chạy kèm `NODE_OPTIONS=--use-system-ca`.

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
    └── components/        # Sidebar, ConnectionModal, DataGridView, DatabaseOverview,
                           # StructureView, QueryPanel, các modal thêm/sửa cột & index
```

Chọn một **database/schema** ở sidebar sẽ mở `DatabaseOverview` — bảng liệt kê table/collection
kèm số dòng, dung lượng, engine; click một dòng để mở dữ liệu của bảng đó.

**Nguyên tắc bảo mật:** driver DB chỉ chạy ở main process; renderer không có quyền Node,
chỉ gọi qua `window.api` (preload) → IPC. Mật khẩu và bí mật SSH được mã hóa bằng keychain OS
(`safeStorage`). Hỗ trợ SSL/TLS và SSH tunnel (qua bastion) cho kết nối production.

**Điểm mở rộng:** thêm loại DB mới = thêm 1 adapter hiện thực `DatabaseAdapter` và đăng ký trong
`adapters/index.ts`. UI tự thích ứng theo `capabilities` (SQL editor, mô hình dữ liệu, `manageObjects`…).

## Trạng thái / lộ trình

- [x] Scaffold Electron + IPC có type
- [x] Quản lý kết nối (CRUD, test, lưu mã hóa) — kèm SSL/TLS & SSH tunnel
- [x] Cây database lazy-load + duyệt dữ liệu (grid có phân trang)
- [x] Tổng quan database: danh sách bảng kèm số dòng/dung lượng/engine
- [x] Sắp xếp & tìm kiếm phía server trong grid dữ liệu
- [x] Tạo/xóa/truncate/đổi tên bảng & xóa database (context menu sidebar)
- [x] Query editor (Monaco) cho cả 4 loại DB
- [x] Sửa dữ liệu inline trong grid (thêm/sửa/xóa dòng)
- [x] Xem/sửa cấu trúc bảng (structure tab): cột, index, ALTER TABLE
- [x] Import/Export CSV/JSON/SQL (bảng & kết quả query)
- [x] Đóng gói app (electron-builder) + icon ứng dụng
- [ ] Sửa document MongoDB inline (hiện chỉ đọc)
- [ ] Code signing + notarize để phân phối
