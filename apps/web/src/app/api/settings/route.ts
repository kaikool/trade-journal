import { db, accounts } from "@/db";
import { rebuildAccountInTransaction } from "@/server/rebuild";
import { handler, ok, requireValue } from "@/server/api";
import {
  getMultipliers,
  getCurrencyConversion,
  getTimeZone,
  getImportTimeZone,
  aiKeyEnvironment,
  aiModelSetting,
  getAiProvider,
  getAiSettings,
  setAiKey,
  setSetting,
} from "@/server/settings";
import { AI_PROVIDERS, AI_PROVIDER_NAMES, isAiProvider, type AiProvider } from "@/lib/ai-settings";
import { isTimeZone } from "@/lib/timezone";
import { parseCurrencyConversion, type CurrencyConversion } from "@/lib/currencies";

export const GET = handler(async () => {
  const [timeZone, importTimeZone, multipliers, currencyConversion, aiSettings] = await Promise.all(
    [
      getTimeZone(),
      getImportTimeZone(),
      getMultipliers(),
      getCurrencyConversion(),
      getAiSettings(),
    ],
  );
  return ok({
    timeZone,
    importTimeZone,
    multipliers,
    currencyConversion,
    ...aiSettings,
  });
});

interface SettingsBody {
  timeZone?: string;
  importTimeZone?: string;
  multipliers?: Record<string, number>;
  /** Set to a key string to store (encrypted), or null to clear. Absent = unchanged. */
  anthropicKey?: string | null;
  openaiKey?: string | null;
  aiProvider?: AiProvider;
  aiModel?: string;
  currencyConversion?: CurrencyConversion;
}

export const PATCH = handler(async (request: Request) => {
  const body = (await request.json()) as SettingsBody;
  requireValue(body && typeof body === "object" && !Array.isArray(body), "Enter valid settings.");
  let conversion: CurrencyConversion | undefined;
  if (body.currencyConversion !== undefined) {
    try {
      conversion = parseCurrencyConversion(body.currencyConversion);
    } catch (error) {
      requireValue(false, error instanceof Error ? error.message : "Enter valid conversion rates.");
    }
    if (conversion.enabled) {
      const accountsList = await db.select({ currency: accounts.currency }).from(accounts);
      const missing = [...new Set(accountsList.map((account) => account.currency))].filter(
        (currency) => currency !== conversion!.reportingCurrency && !conversion!.rates[currency],
      );
      requireValue(
        missing.length === 0,
        `Enter conversion rates for ${missing.join(", ")} before enabling conversion.`,
      );
    }
  }
  if (body.aiProvider !== undefined)
    requireValue(isAiProvider(body.aiProvider), "Choose Anthropic or OpenAI.");
  const provider = body.aiProvider ?? (await getAiProvider());
  if (body.aiModel !== undefined)
    requireValue(
      typeof body.aiModel === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(body.aiModel.trim()),
      "Enter a valid model ID.",
    );
  for (const id of AI_PROVIDERS) {
    const key = body[`${id}Key`];
    if (key === undefined) continue;
    requireValue(
      key === null ||
        (typeof key === "string" &&
          key.trim().length > 0 &&
          key.length <= 4096 &&
          !/\s/.test(key.trim())),
      `Enter a valid ${AI_PROVIDER_NAMES[id]} API key.`,
    );
    requireValue(
      !aiKeyEnvironment(id),
      `${AI_PROVIDER_NAMES[id]} uses an environment key. Update or remove it on the server.`,
    );
  }
  for (const key of ["timeZone", "importTimeZone"] as const)
    if (body[key] !== undefined)
      requireValue(
        isTimeZone(body[key]),
        `Enter a valid IANA ${key === "timeZone" ? "display" : "import"} timezone.`,
      );
  if (body.multipliers !== undefined)
    requireValue(
      body.multipliers &&
        !Array.isArray(body.multipliers) &&
        Object.keys(body.multipliers).length <= 1000 &&
        Object.keys(body.multipliers).every(
          (symbol) => symbol.trim().length > 0 && symbol.length <= 100,
        ) &&
        typeof body.multipliers === "object" &&
        Object.values(body.multipliers).every(
          (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
        ),
      "Contract multipliers must be positive numbers.",
    );

  await db.transaction(async (tx) => {
    // Lock accounts in the same order as transfers before changing valuation settings.
    const allAccounts =
      body.multipliers === undefined
        ? []
        : await tx.select({ id: accounts.id }).from(accounts).orderBy(accounts.id).for("update");
    if (conversion) await setSetting("currencyConversion", JSON.stringify(conversion), tx);
    if (body.timeZone !== undefined || body.importTimeZone !== undefined)
      await setSetting("importTimeZone", body.importTimeZone ?? (await getImportTimeZone(tx)), tx);
    if (body.timeZone !== undefined) await setSetting("timeZone", body.timeZone, tx);
    if (body.multipliers !== undefined) {
      await setSetting("multipliers", JSON.stringify(body.multipliers), tx);
      for (const account of allAccounts) await rebuildAccountInTransaction(account.id, tx);
    }
    for (const id of AI_PROVIDERS) {
      const key = body[`${id}Key`];
      if (key !== undefined) await setAiKey(id, key, tx);
    }
    if (body.aiProvider !== undefined) await setSetting("aiProvider", body.aiProvider, tx);
    if (body.aiModel !== undefined)
      await setSetting(aiModelSetting(provider), body.aiModel.trim(), tx);
  });

  return ok({ saved: true });
});
