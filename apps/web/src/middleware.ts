import { NextResponse, type NextRequest } from "next/server";

/** Fail closed before navigation or API access, using Edge-compatible Web Crypto. */
export const middleware = async (request: NextRequest) => {
  const password = process.env.JOURNAL_PASSWORD;
  if (!password?.trim()) {
    return NextResponse.json({ error: "JOURNAL_PASSWORD is required" }, { status: 503 });
  }
  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth") return NextResponse.next();
  const token = request.cookies.get("journal_session")?.value;
  let valid = false;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = Uint8Array.from(token.match(/../g)!, (byte) => parseInt(byte, 16));
    valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode("session-v1"));
  }
  if (!valid) {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
