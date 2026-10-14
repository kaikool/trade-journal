/** Keep custom names; shorten only the legacy generated provider/platform label. */
export function the5ersAccountName(name: string): string {
  return name.replace(
    /^The5ers[ ·-]+(?:meta-trader-[\w-]+|c-trader|trader-evolution)[ ·-]+/i,
    "The5ers-",
  );
}
