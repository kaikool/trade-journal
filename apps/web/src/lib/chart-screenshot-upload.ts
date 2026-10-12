import { postJson } from "./use-api";

export const ATTACHMENTS_CHANGED_EVENT = "journal:attachments-changed";

type AttachmentOwner = "trade" | "day" | "note" | "missed" | "prop-account" | "prop-entry";

type PreparedAttachment = {
  id: string;
  uploadUrl: string;
};

export const uploadAttachmentBlob = async (
  type: AttachmentOwner,
  id: string,
  name: string,
  file: Blob,
): Promise<void> => {
  const prepared = await postJson<PreparedAttachment>("/api/attachments", {
    action: "prepare",
    type,
    id,
    name,
    size: file.size,
    mime: file.type,
  });
  const upload = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!upload.ok) throw new Error("Storage upload failed.");
  await postJson("/api/attachments", { action: "finalize", id: prepared.id });
  window.dispatchEvent(new CustomEvent(ATTACHMENTS_CHANGED_EVENT, { detail: { type, id } }));
};

export const uploadChartScreenshot = async (
  tradeKey: string,
  symbol: string,
  dataUrl: string,
): Promise<void> => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Chart screenshot is not a PNG image.");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Chart screenshot data is invalid.");
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value))
    throw new Error("Chart screenshot data is invalid.");
  const safeSymbol = symbol.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "trade";
  await uploadAttachmentBlob(
    "trade",
    tradeKey,
    `chart-${safeSymbol}.png`,
    new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }),
  );
};
