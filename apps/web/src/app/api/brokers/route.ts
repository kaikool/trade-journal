import { listBrokers } from "@/server/sync";
import { handler, ok } from "@/server/api";

/** Exposes only the broker adapters enabled for this journal. */
export const GET = handler(() => ok({ brokers: listBrokers() }));
