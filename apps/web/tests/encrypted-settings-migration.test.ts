import { afterEach, expect, it, vi } from "vitest";
import { scryptSync } from "node:crypto";
import { isEncryptedSetting, reencryptEnvelope } from "../../../scripts/encrypted-settings";
import { encryptJson, decryptJson } from "../src/server/crypto";
afterEach(() => vi.unstubAllEnvs());
it("rotates broker/AI and lowercase market key envelopes without treating public enablement as ciphertext", () => {
  expect(isEncryptedSetting("marketData:oanda:keyEnc")).toBe(true);
  expect(isEncryptedSetting("anthropicKeyEnc")).toBe(true);
  expect(isEncryptedSetting("marketData:binance:keyEnc")).toBe(false);
  expect(isEncryptedSetting("marketData:coinbase:keyEnc")).toBe(false);
  expect(isEncryptedSetting("timeZone")).toBe(false);
  expect(isEncryptedSetting("the5ers:oauth:connectionEnc")).toBe(true);
  expect(isEncryptedSetting("the5ers:oauth:pending:session-hash")).toBe(true);
  expect(isEncryptedSetting("the5ers:refs:account-hash")).toBe(true);
  expect(isEncryptedSetting("the5ers:selection")).toBe(false);
  expect(isEncryptedSetting("the5ers:snapshot:account-hash")).toBe(false);
  vi.stubEnv("JOURNAL_SECRET", "old fixture secret");
  const old = encryptJson({ token: "synthetic" });
  const next = reencryptEnvelope(
    old,
    scryptSync("old fixture secret", "luxalgo-trade-journal", 32),
    scryptSync("new fixture secret", "luxalgo-trade-journal", 32),
  );
  vi.stubEnv("JOURNAL_SECRET", "new fixture secret");
  expect(decryptJson(next)).toEqual({ token: "synthetic" });
  expect(() => reencryptEnvelope(old, Buffer.alloc(32), Buffer.alloc(32, 1))).toThrow();
  expect(() => reencryptEnvelope("broken", Buffer.alloc(32), Buffer.alloc(32, 1))).toThrow();
});
