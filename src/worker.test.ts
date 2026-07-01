import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server.js";
import { handleMcpRequest } from "./worker.js";

/**
 * Tiny in-memory skill pack used to build a real MCP server for the edge
 * transport tests. A single skill is enough to assert that resources/tools
 * flow through the Streamable HTTP session round-trip.
 */
const config = {
  name: "edge-skills",
  version: "1.0.0",
  summary: "Edge transport test skill pack",
  skills: {
    "hello-world": { path: "skills/hello-world/SKILL.md" },
  },
};

/** Fixed URL for the single MCP endpoint the worker multiplexes. */
const ENDPOINT = "https://edge.example/mcp";

/**
 * Per-session server factory handed to {@link handleMcpRequest}. Each session
 * gets a fresh {@link Server} built from the in-memory config, matching how the
 * real Worker wires `createMcpServer`.
 */
const createServer = async (): Promise<Server> =>
  createMcpServer(config, async () => "# Hello World Skill");

/** A well-formed JSON-RPC 2.0 `initialize` request body. */
const INITIALIZE_MESSAGE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "edge-test-client", version: "1.0.0" },
  },
};

/**
 * Builds a POST request to the MCP endpoint with the JSON + SSE Accept header
 * the Streamable HTTP transport requires, merging in any extra headers (e.g. a
 * `mcp-session-id`).
 */
function postJsonRpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Drains a response body and returns the JSON-RPC payload. The transport may
 * answer with either a `text/event-stream` (SSE) body or plain JSON depending on
 * the negotiated Accept, so handle both: for SSE, parse the `data:` line(s) as
 * JSON; otherwise parse the whole body.
 */
async function readMessage(response: Response): Promise<any> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    return messages.length === 1 ? messages[0] : messages;
  }

  return text.length > 0 ? JSON.parse(text) : undefined;
}

/**
 * Completes the MCP handshake (initialize → initialized) and returns the
 * assigned session id plus the parsed initialize result, so other tests can
 * drive authenticated requests.
 */
async function openSession(): Promise<{ sessionId: string; initResult: unknown }> {
  const initResponse = await handleMcpRequest(postJsonRpc(INITIALIZE_MESSAGE), createServer);
  expect(initResponse.status).toBe(200);

  const sessionId = initResponse.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const initResult = await readMessage(initResponse);

  const initializedResponse = await handleMcpRequest(
    postJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-session-id": sessionId! },
    ),
    createServer,
  );
  // Notifications carry no id, so the transport acks with 202 and no body.
  expect(initializedResponse.status).toBe(202);

  return { sessionId: sessionId!, initResult };
}

describe("handleMcpRequest (edge Streamable HTTP transport)", () => {
  it("completes a full JSON-RPC round-trip: initialize, initialized, then tools/list", async () => {
    const initResponse = await handleMcpRequest(postJsonRpc(INITIALIZE_MESSAGE), createServer);

    expect(initResponse.status).toBe(200);
    expect(initResponse.headers.get("access-control-allow-origin")).toBe("*");

    const sessionId = initResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initResult = await readMessage(initResponse);
    expect(initResult.id).toBe(1);
    expect(initResult.result.serverInfo.name).toBe("edge-skills");

    // Complete the handshake before issuing further requests.
    const initializedResponse = await handleMcpRequest(
      postJsonRpc(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": sessionId! },
      ),
      createServer,
    );
    expect(initializedResponse.status).toBe(202);

    // Now the session accepts regular requests.
    const listResponse = await handleMcpRequest(
      postJsonRpc(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-session-id": sessionId! },
      ),
      createServer,
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("access-control-allow-origin")).toBe("*");

    const listResult = await readMessage(listResponse);
    const toolNames = listResult.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("list_skills");
    expect(toolNames).toContain("get_skill");
  });

  it("also serves resources/list over an established session", async () => {
    const { sessionId } = await openSession();

    const resourcesResponse = await handleMcpRequest(
      postJsonRpc(
        { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} },
        { "mcp-session-id": sessionId },
      ),
      createServer,
    );
    expect(resourcesResponse.status).toBe(200);

    const resourcesResult = await readMessage(resourcesResponse);
    const uris = resourcesResult.result.resources.map((resource: { uri: string }) => resource.uri);
    expect(uris).toContain("skill://hello-world");
  });

  it("tears the session down on DELETE and 404s a later request reusing the id", async () => {
    const { sessionId } = await openSession();

    const deleteResponse = await handleMcpRequest(
      new Request(ENDPOINT, { method: "DELETE", headers: { "mcp-session-id": sessionId } }),
      createServer,
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.headers.get("access-control-allow-origin")).toBe("*");

    // The session was removed from the map, so reusing the id is now unknown.
    const afterDelete = await handleMcpRequest(
      postJsonRpc(
        { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
        { "mcp-session-id": sessionId },
      ),
      createServer,
    );
    expect(afterDelete.status).toBe(404);
  });

  it("returns 400 for a non-initialize POST with no mcp-session-id header", async () => {
    const response = await handleMcpRequest(
      postJsonRpc({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
      createServer,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toContain("missing mcp-session-id header");
  });

  it("returns 400 for a POST with an invalid JSON body and no session", async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{ not valid json",
      }),
      createServer,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid JSON body");
  });

  it("returns 404 for a request with an unknown/expired mcp-session-id", async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": crypto.randomUUID(),
        },
      }),
      createServer,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 404 for an unsupported route/method", async () => {
    const response = await handleMcpRequest(new Request(ENDPOINT, { method: "PUT" }), createServer);

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers an OPTIONS preflight with 204 and CORS headers", async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, { method: "OPTIONS" }),
      createServer,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("mcp-session-id");
  });
});
