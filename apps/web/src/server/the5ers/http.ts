import { RequestError } from "@/server/api";

export async function providerResponse(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    });
  } catch {
    throw new RequestError("The5ers could not be reached. Try again shortly.");
  }
}
export async function boundedJson(response: Response, maxBytes = 128_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError("The5ers returned an empty response.");
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new RequestError("The5ers response exceeded its size limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new RequestError("The5ers returned an unsupported response.");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
