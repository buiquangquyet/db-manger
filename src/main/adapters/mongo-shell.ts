import vm from 'node:vm';
import { ObjectId, BSON, type Db } from 'mongodb';

// Các kiểu số/binary lấy qua namespace BSON cho chắc chắn (mongodb 6.x — xem mongo.ts:2).
const { Long, Int32, Decimal128, Binary, Timestamp, UUID } = BSON;

/**
 * Đánh giá một biểu thức Mongo Shell (cú pháp mongosh) trên `db` đã kết nối và trả về
 * giá trị thô mà driver trả (cursor cho find/aggregate, Promise<document> cho findOne,
 * Promise<result> cho lệnh ghi, ...). KHÔNG materialize cursor — việc đó do executeRaw lo.
 *
 * BẢO MẬT: `vm` chỉ là *cô lập*, KHÔNG phải sandbox cứng — về lý thuyết vẫn có cách thoát.
 * Threat model chấp nhận được: đây là công cụ desktop chạy cục bộ do chính chủ DB vận hành;
 * người dùng vốn đã có toàn quyền truy cập DB và tự gõ query của mình. Context chỉ phơi bày
 * `db` + vài helper kiểu BSON; KHÔNG có require/process/global/module.
 */
export function evalMongoShell(db: Db, expr: string): Promise<unknown> {
  // Bỏ dấu ; ở cuối để bọc trong ngoặc không lỗi cú pháp.
  const clean = expr.trim().replace(/;+\s*$/, '');
  if (!clean) {
    return Promise.reject(
      new Error('Mongo Shell: hãy nhập một biểu thức, ví dụ db.users.find({}).limit(10)'),
    );
  }

  // Bọc db bằng Proxy để cú pháp mongosh `db.<collection>` trả về collection tương ứng;
  // các method sẵn có của Db (command, aggregate, admin, listCollections...) vẫn dùng bình
  // thường. Lưu ý: collection trùng tên method của Db (vd "command") sẽ bị method che.
  const dbProxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target)) return target.collection(prop);
      return Reflect.get(target, prop, receiver);
    },
  });

  const sandbox: Record<string, unknown> = {
    db: dbProxy,
    // Dùng Date/RegExp của realm chính để instanceof phía driver hoạt động đúng.
    Date,
    RegExp,
    ObjectId: (v?: string) => (v === undefined ? new ObjectId() : new ObjectId(v)),
    ISODate: (v?: string) => (v === undefined ? new Date() : new Date(v)),
    NumberLong: (v: string | number) => Long.fromValue(v as never),
    NumberInt: (v: string | number) => new Int32(Number(v)),
    NumberDecimal: (v: string | number) => Decimal128.fromString(String(v)),
    UUID: (v?: string) => (v === undefined ? new UUID() : new UUID(v)),
    BinData: (subtype: number, base64: string) =>
      new Binary(Buffer.from(base64, 'base64'), subtype),
    Timestamp: (t: number, i: number) => new Timestamp({ t, i } as never),
  };

  const context = vm.createContext(sandbox);
  // Bọc trong async IIFE để await được kết quả bên trong biểu thức nếu cần.
  // Lỗi cú pháp (biểu thức rỗng còn sót, comment ở cuối, nhiều câu lệnh...) được gói lại
  // thành thông điệp tiếng Việt gọn thay vì SyntaxError JS thô.
  let script: vm.Script;
  try {
    script = new vm.Script(`(async () => (${clean}))()`, { filename: 'mongo-shell.js' });
  } catch (err) {
    return Promise.reject(
      new Error(`Mongo Shell: biểu thức không hợp lệ (chỉ hỗ trợ một biểu thức). ${(err as Error).message}`),
    );
  }
  // timeout chỉ chặn phần đồng bộ (parse/tạo cursor); I/O DB có timeout riêng của driver.
  return script.runInContext(context, { timeout: 15000 }) as Promise<unknown>;
}
