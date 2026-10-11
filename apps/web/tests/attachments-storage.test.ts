import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const storage = vi.hoisted(() => ({
  createAttachmentUpload: vi.fn(),
  inspectAttachmentObject: vi.fn(),
  createAttachmentDownload: vi.fn(),
  removeAttachmentObject: vi.fn(),
}));

vi.mock("../src/server/storage", () => storage);

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();

const { db, attachments } = await import("../src/db");
const attachmentsRoute = await import("../src/app/api/attachments/route");
const attachmentRoute = await import("../src/app/api/attachments/[id]/route");

const post = (body: unknown) =>
  new Request("http://test.local/api/attachments", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await db.delete(attachments);
  storage.createAttachmentUpload.mockReset();
  storage.inspectAttachmentObject.mockReset();
  storage.createAttachmentDownload.mockReset();
  storage.removeAttachmentObject.mockReset();
  storage.createAttachmentUpload.mockResolvedValue({ signedUrl: "https://storage.test/upload" });
  storage.createAttachmentDownload.mockResolvedValue("https://storage.test/download");
  storage.removeAttachmentObject.mockResolvedValue(undefined);
});

describe("Supabase Storage attachment routes", () => {
  it("prepares a private direct upload and finalizes only after Storage metadata and magic bytes match", async () => {
    const prepare = await attachmentsRoute.POST(
      post({
        action: "prepare",
        type: "day",
        id: "2026-10-11",
        name: "chart.png",
        size: 8 * 1024 * 1024,
        mime: "image/png",
      }),
    );
    expect(prepare.status).toBe(200);
    const prepared = (await prepare.json()) as { id: string; uploadUrl: string; path: string };
    expect(prepared.uploadUrl).toBe("https://storage.test/upload");
    expect(prepared.path).toMatch(/^attachments\/day\/2026-10-11\/[A-Za-z0-9_-]+\/chart\.png$/);
    expect(storage.createAttachmentUpload).toHaveBeenCalledWith({
      path: prepared.path,
      mime: "image/png",
    });

    let [row] = await db.select().from(attachments).where(eq(attachments.id, prepared.id)).limit(1);
    expect(row).toMatchObject({
      ownerType: "day",
      ownerId: "2026-10-11",
      name: "chart.png",
      mime: "image/png",
      size: 8 * 1024 * 1024,
      storagePath: prepared.path,
      status: "pending",
    });

    storage.inspectAttachmentObject.mockResolvedValueOnce({
      path: prepared.path,
      size: 8 * 1024 * 1024,
      mime: "image/png",
      headBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    const wrongMagic = await attachmentsRoute.POST(post({ action: "finalize", id: prepared.id }));
    expect(wrongMagic.status).toBe(400);
    expect(await wrongMagic.json()).toMatchObject({ error: "Uploaded file type changed." });

    storage.inspectAttachmentObject.mockResolvedValueOnce({
      path: prepared.path,
      size: 8 * 1024 * 1024,
      mime: "image/png",
      headBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const finalize = await attachmentsRoute.POST(post({ action: "finalize", id: prepared.id }));
    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toMatchObject({ id: prepared.id, mime: "image/png" });

    [row] = await db.select().from(attachments).where(eq(attachments.id, prepared.id)).limit(1);
    expect(row?.status).toBe("ready");
  });

  it("rejects finalize when Storage reports a different path or size", async () => {
    const prepare = await attachmentsRoute.POST(
      post({
        action: "prepare",
        type: "day",
        id: "2026-10-11",
        name: "receipt.pdf",
        size: 1200,
        mime: "application/pdf",
      }),
    );
    const prepared = (await prepare.json()) as { id: string; path: string };

    storage.inspectAttachmentObject.mockResolvedValueOnce({
      path: "attachments/day/2026-10-11/other/receipt.pdf",
      size: 1200,
      mime: "application/pdf",
      headBytes: new TextEncoder().encode("%PDF-1.7"),
    });
    const wrongPath = await attachmentsRoute.POST(post({ action: "finalize", id: prepared.id }));
    expect(wrongPath.status).toBe(400);
    expect(await wrongPath.json()).toMatchObject({ error: "Uploaded object path mismatch." });

    storage.inspectAttachmentObject.mockResolvedValueOnce({
      path: prepared.path,
      size: 1201,
      mime: "application/pdf",
      headBytes: new TextEncoder().encode("%PDF-1.7"),
    });
    const wrongSize = await attachmentsRoute.POST(post({ action: "finalize", id: prepared.id }));
    expect(wrongSize.status).toBe(400);
    expect(await wrongSize.json()).toMatchObject({ error: "Uploaded file size changed." });
  });

  it("returns signed private downloads and deletes metadata idempotently after Storage removal", async () => {
    await db.insert(attachments).values({
      id: "att-ready",
      ownerType: "day",
      ownerId: "2026-10-11",
      name: "receipt.pdf",
      mime: "application/pdf",
      size: 42,
      storagePath: "attachments/day/2026-10-11/att-ready/receipt.pdf",
      status: "ready",
      createdAt: "2026-10-11T00:00:00.000Z",
    });

    const download = await attachmentRoute.GET(
      new Request("http://test.local/api/attachments/att-ready"),
      { params: Promise.resolve({ id: "att-ready" }) },
    );
    expect(download.status).toBe(302);
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(download.headers.get("Location")).toBe("https://storage.test/download");
    expect(storage.createAttachmentDownload).toHaveBeenCalledWith(
      "attachments/day/2026-10-11/att-ready/receipt.pdf",
    );

    const remove = await attachmentRoute.DELETE(
      new Request("http://test.local/api/attachments/att-ready", { method: "DELETE" }),
      { params: Promise.resolve({ id: "att-ready" }) },
    );
    expect(remove.status).toBe(200);
    expect(storage.removeAttachmentObject).toHaveBeenCalledWith(
      "attachments/day/2026-10-11/att-ready/receipt.pdf",
    );
    expect(await db.select().from(attachments)).toHaveLength(0);

    const removeAgain = await attachmentRoute.DELETE(
      new Request("http://test.local/api/attachments/att-ready", { method: "DELETE" }),
      { params: Promise.resolve({ id: "att-ready" }) },
    );
    expect(removeAgain.status).toBe(200);
    expect(await removeAgain.json()).toEqual({ deleted: true });
  });

  it("cleans abandoned pending metadata only after removing the Storage object", async () => {
    await db.insert(attachments).values({
      id: "stale-pending",
      ownerType: "day",
      ownerId: "2026-10-11",
      name: "old.png",
      mime: "image/png",
      size: 8,
      storagePath: "attachments/day/2026-10-11/stale-pending/old.png",
      status: "pending",
      createdAt: "2026-10-09T00:00:00.000Z",
    });

    const prepare = await attachmentsRoute.POST(
      post({
        action: "prepare",
        type: "day",
        id: "2026-10-11",
        name: "chart.png",
        size: 8,
        mime: "image/png",
      }),
    );
    expect(prepare.status).toBe(200);
    expect(storage.removeAttachmentObject).toHaveBeenCalledWith(
      "attachments/day/2026-10-11/stale-pending/old.png",
    );
    expect(await db.select().from(attachments).where(eq(attachments.id, "stale-pending"))).toEqual(
      [],
    );
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
