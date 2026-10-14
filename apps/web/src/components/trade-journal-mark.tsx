/** Flat journal silhouette with a chart cutout; follows the interface text color. */
export function TradeJournalMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" className={className}>
      <title>Trade Journal</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 1h14a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Zm1 2v18h1.5V3H6Zm3.5 11.3 3.5-3.5 2 1.5 3-5 1.7 1-4 6.7-2.6-2-2.3 2.3-1.3-1.3Z"
      />
    </svg>
  );
}
