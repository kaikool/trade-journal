import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/server/auth";
import { handler } from "@/server/api";
import { finishAuthorization } from "@/server/the5ers/oauth";
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  await finishAuthorization(url, (await cookies()).get(AUTH_COOKIE)!.value);
  return NextResponse.redirect(new URL("/the5ers?connected=1", url.origin));
});
