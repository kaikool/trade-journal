import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptJson, encryptJson } from "../src/server/crypto";
import { createCipheriv, scryptSync } from "node:crypto";

afterEach(() => vi.unstubAllEnvs());

describe("credential encryption in serverless deployments", () => {
  it("decrypts legacy envelopes without normalizing the configured secret", () => {
    const secret = "  synthetic legacy key  ";
    vi.stubEnv("JOURNAL_SECRET", secret);
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv(
      "aes-256-gcm",
      scryptSync(secret, "luxalgo-trade-journal", 32),
      iv,
    );
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify({ token: "legacy" })),
      cipher.final(),
    ]);
    const envelope = [
      iv.toString("base64"),
      bytes.toString("base64"),
      cipher.getAuthTag().toString("base64"),
    ].join(".");
    expect(decryptJson(envelope)).toEqual({ token: "legacy" });
  });
  it("requires stable JOURNAL_SECRET key material", () => {
    vi.stubEnv("JOURNAL_SECRET", "");
    expect(() => encryptJson({ token: "fixture" })).toThrow("JOURNAL_SECRET is required");
  });

  it("round-trips encrypted values with the configured secret", () => {
    vi.stubEnv("JOURNAL_SECRET", "fixture-stable-secret");
    const encrypted = encryptJson({ token: "fixture" });
    expect(encrypted).not.toContain("fixture");
    expect(decryptJson<{ token: string }>(encrypted)).toEqual({ token: "fixture" });
  });
});
