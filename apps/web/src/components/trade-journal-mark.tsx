/** A journal cover with a price chart, rendered in the current theme color. */
export function TradeJournalMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <title>Trade Journal</title>
      <rect x="4" y="2.5" width="16" height="19" rx="3" />
      <path d="M8 2.5v19M10.5 14l2.5-2.5 2 1.5 2.5-4.5" />
    </svg>
  );
}
