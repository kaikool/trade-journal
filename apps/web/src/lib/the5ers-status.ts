export const sourceStatus = (value?: string) => value?.trim().toLowerCase() || "unknown";
export const isActiveSource = (value?: string) => sourceStatus(value) === "active";
export const defaultSourceVisible = (value?: string) =>
  ["active", "available"].includes(sourceStatus(value));
