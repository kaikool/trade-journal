import { handler, ok } from "@/server/api";
import { runGlobalSync } from "@/server/sync-service";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  let force = false;
  let all = false;
  let deadlineMs = 8_500;

  try {
    const contentType = request.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const body = (await request.json()) as {
        force?: boolean;
        all?: boolean;
        deadlineMs?: number;
      };
      if (body) {
        force = Boolean(body.force);
        all = Boolean(body.all);
        if (typeof body.deadlineMs === "number" && body.deadlineMs > 0) {
          deadlineMs = Math.min(body.deadlineMs, 55_000);
        }
      }
    }
  } catch {
    // Body is optional
  }

  const result = await runGlobalSync({ force, all, deadlineMs });
  return ok(result);
});

export const GET = handler(async () => {
  // Read current sync status or run a lightweight check
  return ok({ available: true });
});
