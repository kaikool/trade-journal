import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://fixture.invalid/object" },
          error: null,
        }),
      }),
    },
  }),
}));
const { inspectAttachmentObject } = await import("../src/server/storage");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bounded Storage object inspection", () => {
  it("reads only a valid small partial response", async () => {
    vi.stubEnv("SUPABASE_URL", "https://fixture.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
    const prefix = new TextEncoder().encode("%PDF-1.4");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            headers: { "content-length": "8", "content-type": "application/pdf" },
          }),
        )
        .mockResolvedValueOnce(new Response(prefix, { status: 206 })),
    );
    expect(await inspectAttachmentObject("fixture.pdf")).toMatchObject({
      size: 8,
      mime: "application/pdf",
      headBytes: prefix,
    });
  });

  it("rejects a partial response exceeding the fixed inspection budget", async () => {
    vi.stubEnv("SUPABASE_URL", "https://fixture.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            headers: { "content-length": "8192", "content-type": "image/png" },
          }),
        )
        .mockResolvedValueOnce(new Response(new Uint8Array(8192), { status: 206 })),
    );
    await expect(inspectAttachmentObject("fixture.png")).rejects.toThrow("exceeded");
  });
  it("rejects and cancels a server that ignores the requested byte range", async () => {
    vi.stubEnv("SUPABASE_URL", "https://fixture.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { headers: { "content-length": "8192", "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8192));
            },
            cancel,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const outcome = await Promise.race([
      inspectAttachmentObject("fixture.png").then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(outcome).toBe("rejected");
    expect(cancel).toHaveBeenCalled();
  });
});
