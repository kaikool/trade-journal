import { The5ersConnection } from "@/components/the5ers";
export default function The5ersPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">The5ers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your connected accounts, source performance and program records.
        </p>
      </div>
      <The5ersConnection />
    </div>
  );
}
