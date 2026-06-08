#!/usr/bin/env node
/**
 * OriginChain MCP Server
 * ----------------------
 *
 * This is the Model Context Protocol (MCP) bridge between AI agents
 * (Claude Desktop, Cursor, Continue, Cline, Zed AI, etc.) and an
 * OriginChain tenant. The MCP host launches this binary as a stdio
 * subprocess; we speak JSON-RPC over stdin/stdout via the official
 * `@modelcontextprotocol/sdk`.
 *
 * Architecture
 * ============
 *  - Transport: stdio (StdioServerTransport). The MCP host writes
 *    JSON-RPC frames to our stdin and reads our responses from stdout.
 *    stderr is reserved for diagnostics — never write tool output there.
 *  - Tools: each MCP tool maps 1:1 to an OriginChain HTTP endpoint on
 *    the tenant's base URL. We construct an `Authorization: Bearer …`
 *    request, await the JSON response, and surface it as a single
 *    text-block tool result. Engine errors (`{error:{code,message}}`)
 *    are re-raised as MCP tool errors so the model sees the failure.
 *  - Resources: one teaser resource (`originchain://schemas`) returns
 *    the schema list as plain text so MCP clients that auto-attach
 *    resources to the context window get a free schema dump.
 *  - Config: three env vars, all required, no defaults. We fail fast
 *    on launch so misconfigured hosts surface the problem immediately
 *    rather than at first tool call.
 *
 * Required environment
 * ====================
 *   OC_HOST    Tenant base URL, e.g. https://abc123.api.originchain.ai
 *   OC_TENANT  Tenant ULID
 *   OC_TOKEN   Bearer token (oc_live_… / oc_test_…)
 *
 * The bearer token grants full tenant access; treat it like a database
 * password. Read-only tokens are recommended once available.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config (fail fast)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(
      `[originchain-mcp] FATAL: env var ${name} is required and missing\n`,
    );
    process.exit(1);
  }
  return v;
}

const OC_HOST = requireEnv("OC_HOST").replace(/\/$/, "");
const OC_TENANT = requireEnv("OC_TENANT");
const OC_TOKEN = requireEnv("OC_TOKEN");

const BASE = `${OC_HOST}/v1/tenants/${encodeURIComponent(OC_TENANT)}`;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function ocFetch(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OC_TOKEN}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    // Engine returns {error: {code, message}}; surface verbatim.
    const detail =
      typeof parsed === "object" && parsed !== null
        ? JSON.stringify(parsed)
        : String(parsed ?? res.statusText);
    throw new Error(`OriginChain ${method} ${path} → ${res.status}: ${detail}`);
  }
  return parsed;
}

function asTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asErrorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "oc_ask",
    description:
      "Natural-language query over the OriginChain tenant. Pass an English question; the engine plans and executes it. Set plan_only=true to retrieve the query plan without execution.",
    inputSchema: {
      type: "object",
      properties: {
        nl: { type: "string", description: "Natural-language question." },
        plan_only: {
          type: "boolean",
          description:
            "If true, return the query plan without executing it. Default false.",
        },
      },
      required: ["nl"],
      additionalProperties: false,
    },
  },
  {
    name: "oc_sql",
    description:
      "Run a typed SQL SELECT against the OriginChain tenant. Returns rows as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL SELECT statement." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "oc_vector_topk",
    description:
      "Vector similarity search. Returns the top-k nearest rows in `table` to the supplied query vector.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table containing the vector column." },
        vector: {
          type: "array",
          items: { type: "number" },
          description: "Query embedding.",
        },
        k: {
          type: "integer",
          minimum: 1,
          description: "Number of neighbours to return. Default 10.",
        },
        mode: {
          type: "string",
          enum: ["fast", "high_recall"],
          description:
            "Search mode. `high_recall` is the default; `fast` trades recall for latency.",
        },
      },
      required: ["table", "vector"],
      additionalProperties: false,
    },
  },
  {
    name: "oc_fts_search",
    description:
      "BM25 full-text search over a string field in `table`. Returns matching rows ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name." },
        field: { type: "string", description: "Indexed text field." },
        query: { type: "string", description: "Search terms." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Max rows to return. Default 20.",
        },
      },
      required: ["table", "field", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "oc_list_schemas",
    description:
      "List all schema IDs registered in the tenant. Use this for discovery before issuing typed queries.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool implementations (one short comment each)
// ---------------------------------------------------------------------------

// POST /ask {nl, plan_only}
async function callAsk(args: { nl: string; plan_only?: boolean }) {
  const body: Record<string, unknown> = { nl: args.nl };
  if (typeof args.plan_only === "boolean") body.plan_only = args.plan_only;
  return ocFetch("POST", `/ask`, body);
}

// POST /sql {sql}
async function callSql(args: { sql: string }) {
  return ocFetch("POST", `/sql`, { sql: args.sql });
}

// POST /vector/{table}/topk {vector, k, mode}
async function callVectorTopk(args: {
  table: string;
  vector: number[];
  k?: number;
  mode?: "fast" | "high_recall";
}) {
  const body = {
    vector: args.vector,
    k: args.k ?? 10,
    mode: args.mode ?? "high_recall",
  };
  return ocFetch(
    "POST",
    `/vector/${encodeURIComponent(args.table)}/topk`,
    body,
  );
}

// GET /fts/{table}/{field}?q=…&limit=…
async function callFtsSearch(args: {
  table: string;
  field: string;
  query: string;
  limit?: number;
}) {
  const limit = args.limit ?? 20;
  const qs = `?q=${encodeURIComponent(args.query)}&limit=${limit}`;
  return ocFetch(
    "GET",
    `/fts/${encodeURIComponent(args.table)}/${encodeURIComponent(args.field)}${qs}`,
  );
}

// GET /schemas — discovery, also backs the originchain://schemas resource.
async function callListSchemas() {
  return ocFetch("GET", `/schemas`);
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "originchain-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "oc_ask": {
        if (typeof args.nl !== "string") throw new Error("`nl` must be a string");
        return asTextResult(
          await callAsk({
            nl: args.nl,
            plan_only:
              typeof args.plan_only === "boolean" ? args.plan_only : undefined,
          }),
        );
      }
      case "oc_sql": {
        if (typeof args.sql !== "string") throw new Error("`sql` must be a string");
        return asTextResult(await callSql({ sql: args.sql }));
      }
      case "oc_vector_topk": {
        if (typeof args.table !== "string")
          throw new Error("`table` must be a string");
        if (!Array.isArray(args.vector) || !args.vector.every((v) => typeof v === "number"))
          throw new Error("`vector` must be an array of numbers");
        const k = args.k === undefined ? undefined : Number(args.k);
        const mode =
          args.mode === "fast" || args.mode === "high_recall" ? args.mode : undefined;
        return asTextResult(
          await callVectorTopk({
            table: args.table,
            vector: args.vector as number[],
            k,
            mode,
          }),
        );
      }
      case "oc_fts_search": {
        if (typeof args.table !== "string") throw new Error("`table` must be a string");
        if (typeof args.field !== "string") throw new Error("`field` must be a string");
        if (typeof args.query !== "string") throw new Error("`query` must be a string");
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        return asTextResult(
          await callFtsSearch({
            table: args.table,
            field: args.field,
            query: args.query,
            limit,
          }),
        );
      }
      case "oc_list_schemas": {
        return asTextResult(await callListSchemas());
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return asErrorResult(err);
  }
});

// Resource: originchain://schemas — eager schema dump for context attach.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "originchain://schemas",
      name: "OriginChain schemas",
      description:
        "List of schema IDs registered in this tenant. Auto-discoverable for context attach.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== "originchain://schemas") {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  const schemas = await callListSchemas();
  return {
    contents: [
      {
        uri: req.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(schemas, null, 2),
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[originchain-mcp] connected to ${OC_HOST} tenant=${OC_TENANT}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[originchain-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
