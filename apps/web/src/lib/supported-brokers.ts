import type { BrokerId } from "@luxalgo/broker-sdk";

/** Broker adapters enabled in this journal's sync UI and server paths. */
export const ENABLED_SYNC_BROKER_IDS = [
  "binance",
  "bybit",
  "okx",
  "topstep",
] as const satisfies readonly BrokerId[];

const enabledIds: ReadonlySet<string> = new Set(ENABLED_SYNC_BROKER_IDS);

export const isEnabledSyncBroker = (id: string): id is BrokerId => enabledIds.has(id);

export const filterEnabledSyncBrokers = <T extends { id: string }>(brokers: readonly T[]): T[] =>
  brokers.filter((broker) => isEnabledSyncBroker(broker.id));
