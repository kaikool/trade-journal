import { cookies } from "next/headers";
import { AUTH_COOKIE, sessionToken, verifyPassword } from "@/server/auth";
import { bad, handler, ok } from "@/server/api";
import { SESSION_MAX_AGE } from "@/lib/session";

export const POST = handler(
  async (request: Request) => {
    const { takeLoginAttempt } = await import("@/server/login-throttle");
    const retryAfter = await takeLoginAttempt();
    if (retryAfter)
      return Response.json(
        { error: "Too many login attempts. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
        },
      );
    const { password } = (await request.json()) as { password?: string };
    if (typeof password !== "string" || !password || !verifyPassword(password))
      return bad("Wrong password", 401);
    const jar = await cookies();
    jar.set(AUTH_COOKIE, sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return ok({ authenticated: true });
  },
  { public: true },
);
