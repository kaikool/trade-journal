import Image from "next/image";

/** Share the colored journal artwork with the installed app icon. */
export function TradeJournalMark({ className }: { className?: string }) {
  return (
    <Image
      src="/icon-192.png?v=4"
      alt="Trade Journal"
      width={24}
      height={24}
      className={className}
      unoptimized
    />
  );
}
