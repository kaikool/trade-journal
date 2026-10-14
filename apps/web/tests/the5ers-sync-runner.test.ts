import { expect, it, vi } from "vitest";
import { continueModuleSync, type ModuleSyncProgress } from "../src/lib/the5ers-sync-runner";
const status: ModuleSyncProgress = {
  complete: false,
  saved: 63,
  total: 1769,
  remaining: 1706,
  failed: 1,
  processed: 0,
  pending: 1705,
};
it("waits for an occupied sync and advances past a failed batch when pending work exists", async () => {
  const done = { ...status, complete: true, remaining: 0, pending: 0, processed: 6 };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ...status, busy: true })
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(done);
  const wait = vi.fn(async () => {});
  const progress = vi.fn();
  expect(await continueModuleSync(read, progress, wait)).toEqual(done);
  expect(read).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(1);
});
it("stops with visible incomplete progress when only failing reads remain", async () => {
  const failed = { ...status, remaining: 1, pending: 0 };
  const read = vi.fn(async () => failed);
  expect(await continueModuleSync(read, vi.fn())).toEqual(failed);
  expect(read).toHaveBeenCalledTimes(1);
});
it("bounds waiting for a lease and retains the resumable failure message", async () => {
  const read = vi.fn(async () => ({ ...status, busy: true }));
  await expect(continueModuleSync(read, vi.fn(), async () => {})).rejects.toThrow(
    "Saved progress is retained",
  );
  expect(read).toHaveBeenCalledTimes(130);
});
