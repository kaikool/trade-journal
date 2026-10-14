import { sourceFields } from "./the5ers-normalize";

/** Preserve user names; normalize only legacy generated labels. */
export function the5ersAccountName(name: string): string {
  return name.replace(
    /^The5ers[ ·-]+(?:meta-trader-[\w-]+|c-trader|trader-evolution)[ ·-]+/i,
    "The5ers-",
  );
}

export function the5ersDefaultName(
  account: { label: string; source: unknown },
  rules?: unknown,
): string {
  const source = sourceFields(account.source);
  const envelope = sourceFields(rules);
  const rule = sourceFields(envelope.data ?? rules);
  const packageName = [
    source.packagename,
    source.programname,
    source.productname,
    source.planname,
    rule.name,
  ].find((value) => typeof value === "string" && value.trim());
  const size = [
    source.accountsize,
    source.startingbalance,
    source.initialbalance,
    source.nominalbalance,
    source.size,
  ].find(
    (value) =>
      (typeof value === "number" && value > 0) ||
      (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0),
  );
  const accountNumber = [
    source.accountnumber,
    source.tradingaccountnumber,
    source.login,
    source.accountlogin,
  ].find(
    (value) =>
      (typeof value === "string" && /^\d+$/.test(value)) ||
      (typeof value === "number" && Number.isSafeInteger(value) && value > 0),
  );
  const suffix =
    accountNumber != null
      ? String(accountNumber)
      : account.label.match(/(?:…|\.{3})?\d+\s*$/)?.[0]?.trim();
  const parts = [typeof packageName === "string" ? packageName.trim() : "The5ers"];
  if (size != null && !parts[0]!.replaceAll(",", "").includes(String(size)))
    parts.push(Number(size).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  if (suffix) parts.push(suffix);
  return parts.join(" · ");
}
