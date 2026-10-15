import { handler, ok } from "@/server/api";
import { runGlobalSync } from "@/server/sync-service";

export const maxDuration = 120;

export const POST = handler(async (request: Request) => {
  let force = false;
  let all = false;

  try {
    const contentType = request.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const body = (await request.json()) as { force?: boolean; all?: boolean };
      if (body) {
        force = Boolean(body.force);
        all = Boolean(body.all);
      }
    }
  } catch {
    // Body is optional
  }

  const result = await runGlobalSync({ force, all, deadlineMs: 110_000 });
  return ok(result);
});

export const GET = handler(async () => {
  // Read current sync status or run a lightweight check
  return ok({ available: true });
});
