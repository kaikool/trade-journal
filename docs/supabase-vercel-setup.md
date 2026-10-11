# Hướng dẫn cấu hình Supabase và Vercel cho Trade Journal

Tài liệu này hướng dẫn chi tiết cách thiết lập Supabase (PostgreSQL + Storage) và triển khai Trade Journal lên Vercel Serverless, kèm hướng dẫn chạy script chuyển đổi dữ liệu từ SQLite.

---

## 1. Thiết lập Supabase

### Bước 1: Tạo Supabase Project

1. Truy cập [https://database.new](https://database.new) và đăng nhập vào Supabase.
2. Tạo một project mới (chọn khu vực/region gần bạn nhất, ví dụ `Southeast Asia (Singapore)`).
3. Đặt Database Password mạnh và lưu lại.

### Bước 2: Lấy thông tin kết nối Database

1. Vào **Project Settings** \u2192 **Database**.
2. Cuộn xuống phần **Connection string**:
   - **Transaction Pooler (dành cho Vercel Serverless - port 6543):**
     ```text
     postgres://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x
     ```
     -> Dùng làm biến môi trường **`DATABASE_URL`**.
   - **Session Pooler hoặc Direct Connection (port 5432):**
     ```text
     postgres://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require
     ```
     -> Dùng làm biến môi trường **`DIRECT_DATABASE_URL`** (dùng cho công cụ chạy migration `drizzle-kit`).

### Bước 3: Tạo Storage Bucket

1. Vào **Storage** trên menu trái của Supabase Dashboard \u2192 Click **New bucket**.
2. Đặt tên bucket: **`journal-attachments`**.
3. **Quan trọng:** Để bucket ở chế độ **Private** (tắt công tắc Public bucket). Trade Journal sử dụng signed URLs ngắn hạn được bảo vệ quyền truy cập để tải file.
4. Nhấn **Save**.

### Bước 4: Lấy API Credentials

1. Vào **Project Settings** \u2192 **API**.
2. Sao chép:
   - **Project URL:** Dùng làm **`SUPABASE_URL`**.
   - **`service_role` (Secret key):** Cuộn xuống phần Project API keys, copy key `service_role`. Dùng làm **`SUPABASE_SERVICE_ROLE_KEY`** (không dùng key `anon`).

### Bước 5: Khởi tạo bảng dữ liệu (Migrations)

Từ máy của bạn (hoặc SQL Editor của Supabase):

```bash
# Thiết lập biến môi trường tạm thời
export DIRECT_DATABASE_URL="postgres://postgres.[REF]:[PASS]@...:5432/postgres?sslmode=require"

# Chạy migration tạo 23 bảng
pnpm --filter web db:migrate
```

_(Hoặc bạn có thể mở file `apps/web/drizzle/0000_ancient_starjammers.sql`, copy toàn bộ nội dung và dán vào Supabase Dashboard \u2192 **SQL Editor** \u2192 Nhấn **Run**)._

---

## 2. Di chuyển dữ liệu từ SQLite (Migration CLI)

Nếu bạn đã có dữ liệu trong file SQLite cũ (`data/journal.db`), sử dụng script chuyển đổi:

### Bước 1: Chạy kiểm tra thử (Dry-run)

```bash
pnpm migrate:supabase --sqlite ./data/journal.db --dry-run
```

Script sẽ đọc cơ sở dữ liệu SQLite, kiểm tra schema, đếm tổng số dòng từng bảng và in bảng đối soát mà không ghi đè bất kỳ dữ liệu nào.

### Bước 2: Chạy di chuyển thực tế (Live Migration)

```bash
pnpm migrate:supabase \
  --sqlite ./data/journal.db \
  --database-url "postgres://postgres.[REF]:[PASS]@...:5432/postgres?sslmode=require" \
  --supabase-url "https://[REF].supabase.co" \
  --supabase-key "[YOUR-SERVICE-ROLE-KEY]" \
  --secret "[YOUR-JOURNAL-SECRET]"
```

_Ghi chú:_

- Nếu SQLite cũ của bạn từng dùng file `.secret` trên ổ đĩa thay vì `JOURNAL_SECRET`, script sẽ tự động tìm thấy `./data/.secret` để giải mã các thông tin đăng nhập broker đã lưu và mã hóa lại an toàn bằng `JOURNAL_SECRET` mới.
- Các file đính kèm (`attachments`) và market candle datasets (`market_csv_datasets`) sẽ được tải trực tiếp lên Supabase Storage bucket `journal-attachments`.

---

## 3. Cấu hình biến môi trường trên Vercel

### Bước 1: Import dự án vào Vercel

1. Truy cập [vercel.com](https://vercel.com) \u2192 **Add New Project**.
2. Chọn kho mã nguồn (GitHub repository) của bạn.
3. Trong phần **Framework Preset**: Chọn **Next.js**.
4. **Root Directory**: Để trống (mặc định là thư mục gốc `.`) để Vercel build toàn bộ monorepo và các package liên quan.
5. **Build Command**: `pnpm --filter web build` (hoặc để mặc định).

### Bước 2: Thiết lập Environment Variables

Tại phần **Environment Variables** trên Vercel, thêm 5 biến môi trường bắt buộc sau:

| Tên biến                    | Giá trị mẫu                                                                                                | Mô tả                                                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | `postgres://postgres.[REF]:[PASS]@...pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x` | Chuỗi kết nối Transaction Pooler (port 6543) của Supabase                                                        |
| `SUPABASE_URL`              | `https://[REF].supabase.co`                                                                                | Project URL của Supabase                                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...`                                                                                            | Secret `service_role` key của Supabase                                                                           |
| `JOURNAL_SECRET`            | `64_hex_chars_or_strong_passphrase`                                                                        | Khóa mã hóa AES-256-GCM dùng bảo vệ thông tin đăng nhập broker và AI keys (tạo bằng lệnh `openssl rand -hex 32`) |
| `JOURNAL_PASSWORD`          | `your_secure_password`                                                                                     | Mật khẩu đăng nhập vào Journal của bạn                                                                           |

#### Các biến tùy chọn bổ sung:

- `DIRECT_DATABASE_URL`: Chuỗi kết nối trực tiếp port 5432 (dùng khi chạy CLI migration hoặc lệnh bảo trì).
- `OPENAI_API_KEY`: Key OpenAI (nếu muốn cấu hình sẵn qua biến môi trường).
- `ANTHROPIC_API_KEY`: Key Anthropic (nếu muốn cấu hình sẵn qua biến môi trường).

### Bước 3: Deploy

Nhấn **Deploy**. Vercel sẽ tự động build ứng dụng Next.js và triển khai lên hạ tầng Edge / Serverless.
Sau khi deploy thành công:

1. Mở URL của trang web.
2. Đăng nhập bằng `JOURNAL_PASSWORD`.
3. Kiểm tra các trang: Dashboard, Trades, Calendar, Notebook, Analytics, Settings.
