import { RequestError } from "@/server/api";
import { MCP_URL, READ_TOOLS, record, type ReadTool } from "./contracts";
import { providerResponse } from "./http";

/** Bounded Streamable HTTP client; consumes JSON or SSE and cancels after the matching RPC reply. */
async function rpcBody(response: Response, id: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError("The5ers returned an empty response.");
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  let buffer = "",
    bytes = 0;
  const decoder = new TextDecoder();
  const parse = (text: string) => {
    try {
      const value = record(JSON.parse(text));
      return value.id === id ? value : null;
    } catch {
      throw new RequestError("The5ers returned invalid protocol data.");
    }
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024)
        throw new RequestError("The5ers response exceeded its size limit.");
      buffer += decoder.decode(part.value, { stream: true });
      if (sse) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const value = parse(data);
            if (value) return value;
          }
        }
      }
    }
    if (!sse) {
      const value = parse(buffer + decoder.decode());
      if (value) return value;
    }
    throw new RequestError("The5ers did not return the requested response.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class The5ersMcp {
  private id = 0;
  private session: string | undefined;
  private initializing: Promise<void> | undefined;
  constructor(
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {
    if (!token || /\s/.test(token) || token.length > 16_000)
      throw new RequestError("Reconnect The5ers to continue.");
  }
  private async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.id;
    const response = await providerResponse(
      MCP_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          "MCP-Protocol-Version": "2025-03-26",
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      this.signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(
        response.status === 401
          ? "The5ers authorization expired. Reconnect your account."
          : response.status === 403
            ? "The5ers did not grant permission for this data."
            : response.status === 429
              ? "The5ers rate limit reached. Try again later."
              : "The5ers data request failed. Try again shortly.",
      );
    }
    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.session = session;
    const envelope = await rpcBody(response, id);
    if (envelope.jsonrpc !== "2.0" || envelope.error)
      throw new RequestError("The5ers could not complete this read-only request.");
    return record(envelope.result);
  }
  private async initialize() {
    const initialized = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "trade-journal", version: "1.0" },
    });
    if (initialized.protocolVersion !== "2025-03-26")
      throw new RequestError("The5ers protocol version is not supported.");
    const response = await providerResponse(
      MCP_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          "MCP-Protocol-Version": "2025-03-26",
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      },
      this.signal,
    );
    await response.body?.cancel();
    if (!response.ok) throw new RequestError("The5ers connection initialization failed.");
  }
  /** Discover the provider's actual payout/withdrawal read contract, without executing tools. */
  async payoutContract() {
    await (this.initializing ??= this.initialize());
    const tools: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools) || result.tools.length > 200)
        throw new RequestError("The5ers returned an unsupported tool catalog.");
      for (const item of result.tools) {
        const tool = record(item);
        if (typeof tool.name !== "string")
          throw new RequestError("The5ers returned an invalid tool name.");
        if (
          tool.name.startsWith("the5ers_") &&
          /payout|withdraw|payment|wallet/i.test(
            `${tool.name} ${typeof tool.description === "string" ? tool.description : ""}`,
          )
        ) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
          });
        }
      }
      if (tools.length > 40 || JSON.stringify(tools).length > 2 * 1024 * 1024)
        throw new RequestError("The5ers payout contract exceeded its size limit.");
      if (result.nextCursor === undefined) return { tools, complete: true };
      if (
        typeof result.nextCursor !== "string" ||
        !result.nextCursor ||
        result.nextCursor.length > 4096 ||
        cursors.has(result.nextCursor)
      )
        throw new RequestError("The5ers repeated or returned an invalid catalog cursor.");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new RequestError("The5ers tool catalog exceeded its page limit.");
  }
  async read(
    tool: ReadTool,
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!Object.hasOwn(READ_TOOLS, tool))
      throw new RequestError("Unsupported The5ers read-only operation.");
    const definition = READ_TOOLS[tool];
    if (!definition || !(definition.operations as readonly string[]).includes(operation))
      throw new RequestError("Unsupported The5ers read-only operation.");
    await (this.initializing ??= this.initialize());
    const result = await this.rpc("tools/call", {
      name: definition.name,
      arguments: {
        ...args,
        request_context: { timezone: "UTC", locale: "en" },
        operation,
        contract_version: "1.0",
      },
    });
    if (result.isError)
      throw new RequestError(
        "The5ers could not provide this section. Check access and data availability.",
      );
    if (result.structuredContent !== undefined) return result.structuredContent;
    const blocks = Array.isArray(result.content)
      ? result.content.filter(
          (item) =>
            item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
        )
      : [];
    if (blocks.length !== 1 || typeof record(blocks[0]).text !== "string")
      throw new RequestError("The5ers returned an unsupported data format.");
    try {
      return JSON.parse(record(blocks[0]).text as string);
    } catch {
      throw new RequestError("The5ers returned an unsupported data format.");
    }
  }
}
