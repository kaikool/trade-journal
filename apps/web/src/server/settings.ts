import { eq } from "drizzle-orm";
import { db, settings } from "@/db";
import type { JournalExecutor } from "@/db/postgres";
import { decryptJson, encryptJson } from "./crypto";
import { EMPTY_DEFAULTS, type JournalDefaults } from "@/lib/journal-defaults";
import { DEFAULT_CONVERSION, parseCurrencyConversion } from "@/lib/currencies";
import {
  AI_DEFAULT_MODELS,
  isAiProvider,
  type AiProvider,
  type AiSettingsPayload,
} from "@/lib/ai-settings";

export const getJournalDefaults = async (
  executor: JournalExecutor = db,
): Promise<JournalDefaults> => {
  try {
    return {
      ...EMPTY_DEFAULTS,
      ...JSON.parse((await getSetting("journalDefaults", executor)) ?? "{}"),
    };
  } catch {
    return EMPTY_DEFAULTS;
  }
};

const settingsCache = new Map<string, { value: string | null; expires: number }>();
const SETTINGS_CACHE_TTL = 10_000;

export const getSetting = async (
  key: string,
  executor: JournalExecutor = db,
): Promise<string | null> => {
  if (executor === db) {
    const cached = settingsCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }
  }
  const [row] = await executor.select().from(settings).where(eq(settings.key, key)).limit(1);
  const val = row?.value ?? null;
  if (executor === db) {
    settingsCache.set(key, { value: val, expires: Date.now() + SETTINGS_CACHE_TTL });
  }
  return val;
};

export const setSetting = async (
  key: string,
  value: string,
  executor: JournalExecutor = db,
): Promise<void> => {
  settingsCache.delete(key);
  await executor
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
};

export const deleteSetting = async (key: string, executor: JournalExecutor = db): Promise<void> => {
  settingsCache.delete(key);
  await executor.delete(settings).where(eq(settings.key, key));
};

export const getCurrencyConversion = async () => {
  const saved = await getSetting("currencyConversion");
  if (!saved) return DEFAULT_CONVERSION;
  // Invalid saved settings must not silently fall back to a different valuation.
  return parseCurrencyConversion(JSON.parse(saved));
};

/** Journal display timezone (IANA), default UTC. */
export const getTimeZone = async (executor: JournalExecutor = db): Promise<string> =>
  (await getSetting("timeZone", executor)) ?? "UTC";

/** Preserve the legacy parsing default until a separate import zone is saved. */
export const getImportTimeZone = async (executor: JournalExecutor = db): Promise<string> =>
  (await getSetting("importTimeZone", executor)) ?? (await getTimeZone(executor));

/** Per-symbol contract multipliers for futures/options P&L. */
export const getMultipliers = async (
  executor: JournalExecutor = db,
): Promise<Record<string, number>> => {
  const raw = await getSetting("multipliers", executor);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
};

export const aiKeyEnvironment = (provider: AiProvider): string | null =>
  (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim() ||
  null;

/** Provider keys are stored separately and encrypted like broker credentials. */
export const getAiKey = async (provider: AiProvider): Promise<string | null> => {
  const environment = aiKeyEnvironment(provider);
  if (environment) return environment;
  const envelope = await getSetting(`${provider}KeyEnc`);
  if (!envelope) return null;
  try {
    const key = decryptJson<unknown>(envelope);
    return typeof key === "string" ? key.trim() || null : null;
  } catch {
    return null;
  }
};

export const setAiKey = async (
  provider: AiProvider,
  key: string | null,
  executor: JournalExecutor = db,
): Promise<void> => {
  if (key === null) await deleteSetting(`${provider}KeyEnc`, executor);
  else await setSetting(`${provider}KeyEnc`, encryptJson(key.trim()), executor);
};

export const getAnthropicKey = (): Promise<string | null> => getAiKey("anthropic");
export const setAnthropicKey = (key: string | null): Promise<void> => setAiKey("anthropic", key);

export const getAiProvider = async (): Promise<AiProvider> => {
  const selected = await getSetting("aiProvider");
  if (isAiProvider(selected)) return selected;
  // Preserve existing Anthropic setups; an OpenAI-only setup works without a UI visit.
  const [anthropic, openai] = await Promise.all([getAiKey("anthropic"), getAiKey("openai")]);
  return !anthropic && openai ? "openai" : "anthropic";
};

export const aiModelSetting = (provider: AiProvider): string =>
  provider === "anthropic" ? "aiModel" : "openaiModel";

export const getAiModel = async (provider: AiProvider): Promise<string> =>
  (await getSetting(aiModelSetting(provider)))?.trim() || AI_DEFAULT_MODELS[provider];

export const getAiSettings = async (): Promise<AiSettingsPayload> => {
  const aiProvider = await getAiProvider();
  const connection = async (provider: AiProvider) => {
    const [key, model] = await Promise.all([getAiKey(provider), getAiModel(provider)]);
    return {
      configured: Boolean(key),
      source: aiKeyEnvironment(provider)
        ? ("environment" as const)
        : key
          ? ("saved" as const)
          : null,
      model,
    };
  };
  const [anthropic, openai] = await Promise.all([connection("anthropic"), connection("openai")]);
  const aiConnections = { anthropic, openai };
  return {
    aiProvider,
    aiConfigured: aiConnections[aiProvider].configured,
    aiModel: aiConnections[aiProvider].model,
    aiConnections,
  };
};
