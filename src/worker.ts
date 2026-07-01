import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * In-memory registry of active Streamable HTTP sessions, keyed by session id.
 *
 * NOTE: This Map lives inside a single Worker isolate / Node process, so it is
 * per-isolate and non-durable. It is sufficient for short-lived connections
 * served by one instance, but a request routed to a different isolate will not
 * find a session created elsewhere. For production scaling, route each session
 * to a Cloudflare Durable Object (or an equivalent stateful backend) so session
 * state survives across isolates and requests.
 */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

/**
 * CORS headers applied to every response so browser-based MCP clients can talk
 * to the edge endpoint. `mcp-session-id` is exposed so clients can read the
 * session id assigned during initialization.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

/**
 * Returns a new {@link Response} that preserves the status, body, and existing
 * headers of `response` while merging in the shared {@link CORS_HEADERS}. A new
 * Response is built (rather than mutating in place) because the streaming
 * responses produced by the transport can carry immutable headers.
 */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handles incoming HTTP requests for an MCP server running over the modern
 * web-standard Streamable HTTP transport on Cloudflare Workers / Pages Functions
 * (or any Web Standard runtime).
 *
 * A single endpoint multiplexes the whole session lifecycle:
 * - `POST` without a `mcp-session-id` header carrying an `initialize` request
 *   bootstraps a new stateful session: a fresh transport is created, a new MCP
 *   {@link Server} is connected, the transport is stored in the session Map, and
 *   the request is delegated to the transport.
 * - `POST`/`GET` with a known `mcp-session-id` header are delegated to the
 *   matching transport. An unknown/expired session id yields 404; a
 *   non-initialize `POST` without a session id yields 400.
 * - `DELETE` with a `mcp-session-id` header is delegated to the transport, which
 *   tears the session down; the Map entry is removed via the transport callbacks.
 * - `OPTIONS` returns a 204 CORS preflight response.
 * - Anything else yields 404.
 *
 * @param request - The incoming web {@link Request} object
 * @param mcpServerCreator - Async factory that builds an MCP {@link Server} instance per session
 * @returns An HTTP {@link Response} (SSE/JSON stream, status ack, or error), always with CORS headers
 */
export async function handleMcpRequest(
  request: Request,
  mcpServerCreator: () => Promise<Server>,
): Promise<Response> {
  // CORS preflight.
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const sessionId = request.headers.get("mcp-session-id") ?? undefined;

  // Existing session: delegate GET/POST/DELETE to the matching transport.
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      return withCors(new Response("Session not found or expired", { status: 404 }));
    }
    return withCors(await transport.handleRequest(request));
  }

  // No session id header: only a POST carrying an `initialize` request may open
  // a new session.
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return withCors(new Response("Bad Request: invalid JSON body", { status: 400 }));
    }

    if (!isInitializeRequest(body)) {
      // A non-initialize request must carry a session id.
      return withCors(new Response("Bad Request: missing mcp-session-id header", { status: 400 }));
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      // Store the transport once the SDK assigns the session id.
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      // Remove the session on an explicit DELETE teardown.
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    // Also clean up on the stream-close path (transport.close), so a dead
    // session never lingers in the Map regardless of how it ended.
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const mcpServer = await mcpServerCreator();
    await mcpServer.connect(transport);

    // The body is already consumed above for init detection, so hand the parsed
    // value to the transport instead of letting it re-read the request stream.
    return withCors(await transport.handleRequest(request, { parsedBody: body }));
  }

  // Unknown route/method.
  return withCors(new Response("Not Found", { status: 404 }));
}
