import { cookies } from "next/headers";
import { handler, ok, requireValue } from "@/server/api";
import { boundedJson } from "@/server/the5ers/http";
import { checkOAuth } from "@/server/the5ers/registration";
import { AUTH_COOKIE } from "@/server/auth";
import { startAuthorization, disconnectThe5ers } from "@/server/the5ers/oauth";
import {
  listSourceInventory,
  sourceOverview,
  selectSourceAccounts,
  syncSourceAccount,
  readSourceSection,
} from "@/server/the5ers/data";

export const maxDuration = 120;
export const GET = handler(async () => ok(await sourceOverview()));
export const POST = handler(async (request: Request) => {
  const origin = request.headers.get("origin");
  requireValue(
    !origin || origin === new URL(request.url).origin,
    "Cross-origin The5ers changes are not allowed.",
  );
  requireValue(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "Provide a JSON The5ers request.",
  );
  const body = (await boundedJson(new Response(request.body), 16_384)) as Record<string, unknown>;
  requireValue(
    body && typeof body === "object" && !Array.isArray(body),
    "Provide a valid The5ers request.",
  );
  requireValue(
    Object.keys(body).every((key) =>
      [
        "action",
        "ids",
        "autoSync",
        "id",
        "resource",
        "positionKey",
        "linkJournalAccounts",
        "journalLinks",
      ].includes(key),
    ),
    "Unknown The5ers request field.",
  );
  switch (body.action) {
    case "check":
      return ok(await checkOAuth(new URL(request.url).origin));
    case "connect":
      return ok({
        url: await startAuthorization(
          (await cookies()).get(AUTH_COOKIE)!.value,
          new URL(request.url).origin,
        ),
      });
    case "disconnect":
      await disconnectThe5ers();
      return ok({ disconnected: true });
    case "accounts":
      return ok(await listSourceInventory());
    case "select":
      requireValue(
        body.linkJournalAccounts === undefined || typeof body.linkJournalAccounts === "boolean",
        "Choose a valid journal linking option.",
      );
      requireValue(
        body.journalLinks === undefined ||
          (body.journalLinks &&
            typeof body.journalLinks === "object" &&
            !Array.isArray(body.journalLinks)),
        "Choose valid journal links.",
      );
      return ok({
        selection: await selectSourceAccounts(
          body.ids,
          body.autoSync,
          body.linkJournalAccounts === true,
          body.journalLinks as Record<string, string> | undefined,
        ),
      });
    case "sync":
      requireValue(
        typeof body.id === "string" && /^[a-f0-9]{64}$/.test(body.id),
        "Choose a The5ers account.",
      );
      return ok({ snapshot: await syncSourceAccount(body.id) });
    case "read":
      requireValue(
        typeof body.resource === "string" &&
          body.resource.length <= 30 &&
          (body.id === undefined ||
            (typeof body.id === "string" && /^[a-f0-9]{64}$/.test(body.id))) &&
          (body.positionKey === undefined ||
            (typeof body.positionKey === "string" && /^[a-f0-9-]{36}$/.test(body.positionKey))),
        "Choose valid The5ers source data.",
      );
      return ok({
        data: await readSourceSection(
          body.resource,
          body.id as string | undefined,
          body.positionKey as string | undefined,
        ),
      });
    default:
      requireValue(false, "Choose a supported The5ers action.");
  }
});
