// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadChartScreenshot } from "../src/lib/chart-screenshot-upload";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chart screenshot upload", () => {
  it("uploads a Vela PNG as a trade attachment and notifies the attachment list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "att-1", uploadUrl: "/signed" }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "att-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    window.addEventListener("journal:attachments-changed", changed);

    await uploadChartScreenshot("trade-1", "ES", "data:image/png;base64,iVBORw0KGgo=");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/attachments");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "prepare",
      type: "trade",
      id: "trade-1",
      name: "chart-ES.png",
      mime: "image/png",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/signed");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeInstanceOf(Blob);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toContain('"action":"finalize"');
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener("journal:attachments-changed", changed);
  });

  it("rejects non-PNG or malformed chart screenshot data before uploading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadChartScreenshot("trade-1", "ES", "data:image/jpeg;base64,abc"),
    ).rejects.toThrow("Chart screenshot is not a PNG image.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
