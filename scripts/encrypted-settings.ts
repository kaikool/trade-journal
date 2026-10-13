/** Credential envelopes only; public provider enablement markers are plaintext. */
export function isEncryptedSetting(key: string): boolean {
  if (["marketData:binance:keyEnc", "marketData:coinbase:keyEnc"].includes(key)) return false;
  return (
    key === "anthropicKeyEnc" ||
    key === "openaiKeyEnc" ||
    /^marketData:[^:]+:keyEnc$/.test(key) ||
    key === "the5ers:oauth:connectionEnc" ||
    key.startsWith("the5ers:oauth:pending:") ||
    key.startsWith("the5ers:refs:")
  );
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
/** An unreadable envelope aborts migration; copying it would hide lost key material. */
export function reencryptEnvelope(envelope: string, oldKey: Buffer, newKey: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new Error("Invalid credential envelope.");
  const [iv, encrypted, tag] = parts;
  const decipher = createDecipheriv("aes-256-gcm", oldKey, Buffer.from(iv!, "base64"));
  decipher.setAuthTag(Buffer.from(tag!, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted!, "base64")),
    decipher.final(),
  ]);
  const nextIv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", newKey, nextIv);
  const bytes = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    nextIv.toString("base64"),
    bytes.toString("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
}
