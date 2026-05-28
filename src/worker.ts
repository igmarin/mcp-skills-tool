import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A custom MCP Transport implementation designed for Cloudflare Workers / Pages Functions
 * using standard web streams (ReadableStream) and SSE (Server-Sent Events).
 */
export class CloudflareWorkerSseTransport implements Transport {
  private controller?: ReadableStreamDefaultController;
  private isClosed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    public readonly sessionId: string,
    private readonly postEndpoint: string
  ) {}

  async start(): Promise<void> {
    // Start is handled by the connection flow
  }

  /**
   * Binds the standard web ReadableStreamDefaultController to this transport
   */
  setController(controller: ReadableStreamDefaultController) {
    this.controller = controller;
    // Send the initial endpoint message directing the client to our POST endpoint
    this.sendEvent("endpoint", `${this.postEndpoint}?sessionId=${this.sessionId}`);
  }

  /**
   * Sends a message to the client over the SSE stream
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error("Transport is closed");
    }
    this.sendEvent("message", JSON.stringify(message));
  }

  private sendEvent(event: string, data: string) {
    if (this.controller) {
      try {
        const payload = `event: ${event}\ndata: ${data}\n\n`;
        this.controller.enqueue(new TextEncoder().encode(payload));
      } catch (err: any) {
        this.close();
      }
    }
  }

  /**
   * Receives incoming messages from the client (typically via HTTP POST)
   * and routes them to the MCP Server handlers
   */
  async handleMessage(message: unknown): Promise<void> {
    try {
      const parsed = JSONRPCMessageSchema.parse(message);
      if (this.onmessage) {
        this.onmessage(parsed);
      }
    } catch (err: any) {
      if (this.onerror) {
        this.onerror(err);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.controller) {
      try {
        this.controller.close();
      } catch {
        // Stream may already be closed
      }
    }
    if (this.onclose) {
      this.onclose();
    }
  }
}

/**
 * Map to store active CloudflareWorkerSseTransport sessions.
 * Keep in mind that Cloudflare Workers are ephemeral;
 * this map works fine for short-lived connections, but for production
 * scaling, consider routing requests to Durable Objects or checking connection state.
 */
export const activeTransports = new Map<string, CloudflareWorkerSseTransport>();

/**
 * Route request handler for Hono/Cloudflare Workers
 */
export async function handleMcpRequest(
  request: Request,
  mcpServerCreator: () => Promise<any>
): Promise<Response> {
  const url = new URL(request.url);

  // 1. Establish SSE Connection (GET)
  if (request.method === "GET") {
    const sessionId = crypto.randomUUID();
    // Resolve relative path to message endpoint
    const postEndpoint = `${url.pathname}/post`;
    const transport = new CloudflareWorkerSseTransport(sessionId, postEndpoint);
    
    activeTransports.set(sessionId, transport);

    const mcpServer = await mcpServerCreator();

    const stream = new ReadableStream({
      start(controller) {
        transport.setController(controller);
        mcpServer.connect(transport).catch((err: any) => {
          console.error("Failed to connect MCP server to transport:", err);
          transport.close();
        });
      },
      cancel() {
        transport.close();
        activeTransports.delete(sessionId);
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      }
    });
  }

  // 2. Handle Message Post (POST)
  if (request.method === "POST" && url.pathname.endsWith("/post")) {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId parameter", { status: 400 });
    }

    const transport = activeTransports.get(sessionId);
    if (!transport) {
      return new Response("Session not found or expired", { status: 404 });
    }

    try {
      const body = await request.json();
      await transport.handleMessage(body);
      return new Response("Accepted", { status: 202 });
    } catch (err: any) {
      return new Response(`Error handling message: ${err?.message || err}`, { status: 400 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
