export interface ModuleSyncProgress {
  complete: boolean;
  saved: number;
  total: number;
  remaining: number;
  failed: number;
  processed: number;
  pending?: number;
  busy?: boolean;
  unsupported?: string[];
}

/** A busy lease or one failed batch must not abandon other pending source reads. */
export async function continueModuleSync(
  read: () => Promise<ModuleSyncProgress>,
  progress: (value: ModuleSyncProgress) => void,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
) {
  let busyAttempts = 0;
  for (;;) {
    const result = await read();
    progress(result);
    if (result.busy) {
      if (++busyAttempts >= 130)
        throw new Error(
          "Another sync is still running. Saved progress is retained; resume shortly.",
        );
      await wait();
      continue;
    }
    busyAttempts = 0;
    if (result.complete || !result.remaining || (!result.processed && !(result.pending ?? 0)))
      return result;
  }
}
