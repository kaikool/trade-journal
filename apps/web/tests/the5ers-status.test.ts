import { expect, it } from "vitest";
import { defaultSourceVisible, isActiveSource, sourceStatus } from "../src/lib/the5ers-status";
it("shows active and available by default without inferring the meaning of inactive statuses", () => {
  expect(defaultSourceVisible("active")).toBe(true);
  expect(defaultSourceVisible("available")).toBe(true);
  expect(defaultSourceVisible("disabled")).toBe(false);
  expect(isActiveSource("available")).toBe(false);
  expect(isActiveSource(" ACTIVE ")).toBe(true);
  expect(sourceStatus("disabled")).toBe("disabled");
  expect(sourceStatus(undefined)).toBe("unknown");
});
