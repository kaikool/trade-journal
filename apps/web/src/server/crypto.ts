import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Broker credentials at rest are AES-256-GCM encrypted. The key comes from
 * JOURNAL_SECRET. Serverless filesystems are ephemeral, so production cannot
 * safely generate key material on disk.
 */
const keyMaterial = (): Buffer => {
  const secret = process.env.JOURNAL_SECRET;
  if (!secret) throw new Error("JOURNAL_SECRET is required to encrypt saved credentials");
  return scryptSync(secret, "luxalgo-trade-journal", 32);
};

export const encryptJson = (value: unknown): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    iv.toString("base64"),
    encrypted.toString("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
};

export const decryptJson = <T>(envelope: string): T => {
  const [iv, encrypted, tag] = envelope.split(".");
  if (!iv || !encrypted || !tag) throw new Error("Malformed credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
};
