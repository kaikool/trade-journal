/** A compact chart mark, rendered in the current theme color. */
export function TradeJournalMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" className={className}>
      <title>Trade Journal</title>
      <rect x="3" y="13" width="4" height="8" rx="2" />
      <rect x="10" y="8" width="4" height="13" rx="2" />
      <rect x="17" y="3" width="4" height="18" rx="2" />
    </svg>
  );
}
