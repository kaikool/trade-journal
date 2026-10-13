import { requireValue } from "./api";
import { isCurrencyCode } from "@/lib/currencies";

export function validateAccountBody(value: unknown, create = false): void {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Enter valid account details.",
  );
  const body = value as Record<string, unknown>;
  if (create || body.name !== undefined)
    requireValue(
      typeof body.name === "string" && body.name.trim().length > 0 && body.name.length <= 200,
      "Enter an account name up to 200 characters.",
    );
  if (create || body.kind !== undefined)
    requireValue(
      ["sync", "manual", "import"].includes(body.kind as string),
      "Choose a supported account kind.",
    );
  if (body.currency !== undefined)
    requireValue(isCurrencyCode(body.currency), "Choose a valid currency code.");
  if (body.initialBalance !== undefined)
    requireValue(
      typeof body.initialBalance === "number" &&
        Number.isFinite(body.initialBalance) &&
        body.initialBalance >= 0,
      "Initial balance must be a finite non-negative number.",
    );
  if (body.profitCalcMethod !== undefined)
    requireValue(
      ["fifo", "lifo", "wavg"].includes(body.profitCalcMethod as string),
      "Choose FIFO, LIFO or weighted average.",
    );
  if (body.autoSync !== undefined)
    requireValue(typeof body.autoSync === "boolean", "Choose whether automatic sync is enabled.");
  if (body.broker !== undefined)
    requireValue(
      typeof body.broker === "string" && body.broker.length <= 100,
      "Choose a valid broker.",
    );
  if (body.brokerAccountId !== undefined)
    requireValue(
      typeof body.brokerAccountId === "string" &&
        body.brokerAccountId.trim().length > 0 &&
        body.brokerAccountId.length <= 200,
      "Enter a valid broker account ID.",
    );
  if (body.credentials !== undefined)
    requireValue(
      body.credentials &&
        typeof body.credentials === "object" &&
        !Array.isArray(body.credentials) &&
        Object.keys(body.credentials).length <= 30 &&
        Object.values(body.credentials).every((v) => typeof v === "string" && v.length <= 4096),
      "Enter valid broker credentials.",
    );
}
