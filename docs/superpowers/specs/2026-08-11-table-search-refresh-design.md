# Tìm tên bảng + Làm mới dữ liệu

Ngày: 2026-08-11
Branch: `feat/table-search-refresh`

## Mục tiêu

Hai cải thiện nhỏ cho thao tác hằng ngày, đều nằm trọn trong renderer:

1. **Lọc theo tên bảng** ở hai nơi liệt kê bảng: cây Sidebar và bảng DatabaseOverview.
2. **Nút làm mới dữ liệu** trong DataGridView, giữ nguyên ngữ cảnh đang xem.

Không thêm IPC, không đổi adapter, không đổi `shared/types.ts`.

## Phạm vi

Trong phạm vi:

- Ô lọc client-side ở Sidebar, khớp mọi loại node (kết nối, database/schema, bảng/view/collection).
- Ô tìm tên bảng ở DatabaseOverview.
- Nút "Tải lại" ở thanh công cụ DataGridView.
- Tách các tiện ích cây khỏi `Sidebar.tsx` sang module riêng.

Ngoài phạm vi:

- Tìm bảng phía server (quét database chưa expand).
- Tự động làm mới theo chu kỳ.
- Đổi cách tìm nội dung trong bảng (ô "Tìm trên toàn bảng" hiện có giữ nguyên).

## Hiện trạng

| Nơi | Hiện có | Thiếu |
|---|---|---|
| `Sidebar.tsx` (403 dòng) | cây lazy-load, menu chuột phải, 3 hàm tiện ích cây ở cuối file | ô lọc |
| `DatabaseOverview.tsx` | bảng antd, sort/filter cột, nút "Tải lại" | ô tìm tên |
| `DataGridView.tsx` | ô tìm nội dung server-side, phân trang, sort, filter cột | nút làm mới |

## Thiết kế

### 1. `lib/tree-utils.ts` (mới)

Module thuần, không phụ thuộc React hay antd. Generic trên node hình dạng `{ key: string; title: string; searchTitle?: string; children?: T[] }` để không kéo type `UiNode` ra khỏi Sidebar.

Chuyển từ `Sidebar.tsx` sang, giữ nguyên hành vi:

- `findNode(nodes, key)`
- `findParentKey(nodes, childKey)`
- `insertChildren(nodes, key, children)`

Thêm mới:

```ts
filterTree<T>(nodes: T[], query: string): { nodes: T[]; expandKeys: string[] }
```

Luật lọc:

- So khớp: `searchTitle ?? title` chứa `query`, không phân biệt hoa/thường (cả hai vế `toLowerCase()`). Không xử lý dấu tiếng Việt.
- `searchTitle?: string` là trường tùy chọn của `TreeLike`, dành cho node có nhãn được trang trí thêm: node kết nối hiển thị `Tên (kind)` nhưng chỉ so khớp trên `Tên`. Nếu so cả hậu tố thì query rất đời thường như `post` (tìm bảng `posts`) sẽ tự khớp `(postgres)` và giữ nguyên cả nhánh kết nối — bộ lọc trông như không chạy. Nhờ vậy sidebar và DatabaseOverview cùng so trên tên trần của đối tượng.
- `query` rỗng (sau `trim`) → trả về `nodes` nguyên vẹn và `expandKeys` rỗng.
- Giữ một node khi: chính nó khớp, **hoặc** có con cháu khớp.
- Node tự khớp → giữ **toàn bộ** con đã tải của nó, không lọc tiếp xuống dưới. Gõ tên database vẫn xem được đầy đủ bảng bên trong.
- Node không tự khớp nhưng có con cháu khớp → chỉ giữ nhánh con dẫn tới kết quả, và `key` của nó được đưa vào `expandKeys`.
- `expandKeys` chỉ chứa key của node tổ tiên chứa kết quả — đều là node đã tải con, nên auto-expand không kích hoạt `loadData`.

Hàm trả về mảng mới, không sửa đầu vào.

### 2. Sidebar

**Ô lọc.** `Input` (`allowClear`, `prefix={<SearchOutlined />}`, `size="small"`) đặt trên một hàng riêng ngay dưới hàng nút "Kết nối mới / Reload". Placeholder: `Lọc trong cây đang mở…` — nói rõ giới hạn client-side. State cục bộ `query`.

**Áp dụng lọc.** `useMemo` chạy `filterTree(rootNodes, query)`; kết quả `nodes` đưa vào `treeData` của `Tree`.

**Expand có kiểm soát.** `Tree` hiện để antd tự quản trạng thái mở; chuyển sang controlled:

- State `userExpandedKeys` — cập nhật qua `onExpand`, là nguồn sự thật khi không lọc.
- `expandedKeys` truyền cho `Tree` = `query` rỗng ? `userExpandedKeys` : hợp của `userExpandedKeys` và `expandKeys`.
- Xóa query → tự động quay về `userExpandedKeys`, không cần lưu/khôi phục thủ công.
- `autoExpandParent={false}` để tránh antd tự mở thêm ngoài ý muốn.

**Highlight.** Helper `highlight(title, query): React.ReactNode` bọc đoạn khớp trong `<mark>` nền vàng nhạt; `query` rỗng → trả về chuỗi nguyên. `titleRender` hiện render `{ui.title}` ở 4 nhánh (node kết nối, node database/schema, node bảng, nhánh mặc định) — cả 4 thay bằng `highlight(ui.title, query)`.

**Trạng thái rỗng.** Điều kiện hiện tại `connections.length === 0` → `Empty "Chưa có kết nối"`. Thêm nhánh: có kết nối nhưng cây sau lọc rỗng → `Empty "Không có node nào khớp"`.

**Giới hạn đã biết.** Bảng nằm trong database chưa expand sẽ không tìm ra. Đây là hệ quả có chủ ý của phương án client-side; placeholder đã nêu.

> **Sửa đổi sau khi thực thi (2026-08-11).** Phần "Expand có kiểm soát" ở trên đã bị thay thế
> trong lúc làm. Mô hình một state — `expandedKeys` = hợp của `userExpandedKeys` và `expandKeys`,
> `onExpand` ghi thẳng vào `userExpandedKeys` — làm rò trạng thái: đang lọc mà người dùng mở thêm
> một nhánh thì antd gọi `onExpand` với TOÀN BỘ danh sách key đang mở (gồm cả key do bộ lọc tự
> mở), các key đó chui vào `userExpandedKeys`, nên xóa ô lọc xong cây lại mở nhiều nhánh hơn lúc
> đầu. Người dùng đã phán quyết: finding thắng spec. Bản đã giao dùng **hai state tách biệt**:
>
> - `userExpandedKeys` — trạng thái mở ngoài lọc. Khi không lọc thì `onExpand` ghi thẳng. Khi
>   đang lọc thì chỉ **CỘNG THÊM** key mới người dùng chủ động mở, không bao giờ bị **RÚT**: thu
>   một nhánh trong lúc lọc chỉ là xem tạm, không phải huỷ trạng thái gốc.
> - `filterExpandedKeys` — khung nhìn trong lúc lọc, gieo từ `userExpandedKeys ∪ expandKeys` khi
>   bắt đầu một lượt lọc, sau đó mỗi lần `expandKeys` đổi chỉ merge thêm phần MỚI xuất hiện (giữ
>   nguyên nhánh người dùng đã tự thu). Xóa ô lọc thì thôi được đọc chứ không bị dọn — mảng cũ
>   nằm lại tới khi lượt lọc kế tiếp gieo lại.
>
> `expandedKeys` truyền cho `Tree` = `isFiltering ? filterExpandedKeys : userExpandedKeys`.
> Hợp đồng phải giữ: xóa ô lọc trả cây về đúng các nhánh người dùng đang mở, và mở/thu nhánh
> trong lúc lọc phải có hiệu lực nhìn thấy được. Xem `Sidebar.tsx:99-162`, commit `594f0a3`,
> `0023931`, `73ace25`, và ghi chú tương ứng trong plan.
>
> **Hệ quả kèm theo.** Vì `expandedKeys` giờ là prop có kiểm soát, rc-tree không còn tự thu node
> lại khi `loadData` reject (nhánh rollback của nó ghi state qua `setUncontrolledState` với cờ
> atomic, bị chặn khi `expandedKeys` nằm trong props) và nó cũng nuốt luôn rejection. Nên
> `onLoadData` phải tự bắt lỗi: báo `message.error("Tải cây thất bại: …")`, bỏ key khỏi cả hai
> state trên, rồi ném lại để rc-tree không đánh dấu node là đã tải. Mục "Xử lý lỗi" bên dưới nói
> "không phát sinh đường lỗi mới" là không còn đúng ở điểm này.

### 3. DatabaseOverview

- State `query`, `Input` (`allowClear`, icon kính lúp, `width: 220`) đặt bên trái nút "Tải lại" trong thanh header.
- `useMemo` lọc `tables` theo `name` chứa `query`, không phân biệt hoa/thường; kết quả đưa vào `dataSource`.
- Nhãn đếm ở tiêu đề: không lọc → `· {n} bảng`; đang lọc → `· {khớp}/{tổng} bảng`.
- Đổi `connectionId`/`database`/`schema` → reset `query` về rỗng, gộp vào `useEffect` nạp danh sách sẵn có.
- Trạng thái rỗng tách hai ca: `tables.length === 0` → `Empty "Database rỗng — chưa có bảng nào"` (giữ nguyên); có bảng nhưng lọc ra 0 → `Empty "Không có bảng nào khớp"`.
- Sort/filter cột và menu chuột phải chạy trên tập đã lọc, không đổi logic.

### 4. DataGridView

- Thêm `Button size="small" icon={<ReloadOutlined />}` nhãn "Tải lại", đặt đầu tiên trong `Space` của thanh công cụ (trước "Thêm dòng").
- `onClick` gọi `load(page)`. `load` sẵn có đã đọc `orderBy`, `search` và `filtersRef.current`, nên trang hiện tại, sort, ô tìm nội dung và filter theo cột đều giữ nguyên. Không sửa `load`.
- `loading={loading}` dùng chung state với `Spin` đang có; nút tự vô hiệu khi đang tải nên không cần chống bấm liên tục.

## Xử lý lỗi

Không phát sinh đường lỗi mới:

- Lọc là thuần client, không thất bại.
- Refresh tái dùng `load`, vốn đã bắt lỗi và hiện `message.error("Đọc dữ liệu thất bại: …")` rồi tắt spinner ở `finally`.

## Kiểm thử

Repo chưa có test framework. Xác minh ba lớp:

1. `npm run typecheck` (node + web) sạch.
2. `filterTree` là hàm thuần → script kiểm tra nhỏ, bundle bằng esbuild rồi chạy bằng node (cùng cách đã dùng để verify adapter). Ca phủ: query rỗng trả nguyên cây; khớp node lá; khớp node cha (giữ đủ con); không khớp trả mảng rỗng; khác hoa/thường vẫn khớp; `expandKeys` đúng tổ tiên.
3. Kiểm tra tay trong `npm run dev`:
   - Sidebar: gõ tên bảng khi đã mở nhiều database → chỉ còn nhánh khớp, tự expand, phần khớp được highlight; xóa query → cây trở lại đúng trạng thái mở trước đó.
   - DatabaseOverview: gõ tên → danh sách và nhãn đếm đổi theo; đổi database → ô tìm tự xóa.
   - DataGridView: sang trang 3, thêm sort và filter cột, bấm "Tải lại" → vẫn ở trang 3 với đúng sort/filter.

## Các file chạm vào

| File | Việc |
|---|---|
| `src/renderer/src/lib/tree-utils.ts` | mới — 3 tiện ích chuyển từ Sidebar + `filterTree` |
| `src/renderer/src/components/Sidebar.tsx` | ô lọc, expand có kiểm soát, highlight, bỏ 3 tiện ích ở cuối file |
| `src/renderer/src/components/DatabaseOverview.tsx` | ô tìm + nhãn đếm + trạng thái rỗng |
| `src/renderer/src/components/DataGridView.tsx` | nút "Tải lại" |
| `src/renderer/src/styles.css` | hàng chứa ô lọc trong sidebar |

Không đụng `main/`, `preload/`, `shared/types.ts`.

## Quyết định đã chốt

| Câu hỏi | Chọn | Lý do |
|---|---|---|
| Đặt ô search ở đâu | Sidebar **và** DatabaseOverview | Hai nơi liệt kê bảng, cùng nhu cầu |
| Phạm vi lọc sidebar | Client-side, node đã tải | Không thêm IPC/adapter; phản hồi tức thì |
| Sidebar khớp node nào | Mọi node | Gõ tên database cũng lọc được khi có nhiều kết nối |
| Hành vi refresh | Giữ nguyên page/sort/search/filter | Giống F5 dữ liệu, không mất ngữ cảnh |
