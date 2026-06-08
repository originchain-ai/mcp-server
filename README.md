# @originchain/mcp-server

Model Context Protocol (MCP) server for OriginChain — auto-discoverable database access for any AI agent.

## Why MCP?

AI agents (Claude Desktop, Cursor, Continue, Cline, Zed AI, and every IDE that speaks MCP) auto-discover this server and gain the ability to query your OriginChain instance using natural language, SQL, vector similarity, and full-text search — without you wiring anything per-app. Add the snippet below to your MCP host's config and the agent learns about your data.

## Install

Install globally:

```bash
npm install -g @originchain/mcp-server
```

Or run on demand via `npx` (no install):

```bash
npx -y @originchain/mcp-server
```

Requires Node.js 20 or newer.

## Configure (Claude Desktop)

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "originchain": {
      "command": "npx",
      "args": ["-y", "@originchain/mcp-server"],
      "env": {
        "OC_HOST": "https://abc123.api.originchain.ai",
        "OC_TENANT": "01HZ...",
        "OC_TOKEN": "oc_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. The five `oc_*` tools and the `originchain://schemas` resource become available to the assistant.

Cursor, Continue, Cline, Zed AI and other MCP hosts use the same JSON shape — consult their docs for the config file location.

## Tools

| Name | Description |
|---|---|
| `oc_ask` | Natural-language query. Pass an English question; the engine plans and executes it. Optional `plan_only` flag returns the plan without running. |
| `oc_sql` | Run a typed SQL `SELECT`. Returns rows as JSON. |
| `oc_vector_topk` | Top-k vector similarity over a table. Inputs: `table`, `vector`, optional `k` (default 10), optional `mode` (`fast` \| `high_recall`, default `high_recall`). |
| `oc_fts_search` | BM25 full-text search over a string field. Inputs: `table`, `field`, `query`, optional `limit` (default 20). |
| `oc_list_schemas` | List schema IDs registered in the tenant. Use for discovery. |

## Resources

- `originchain://schemas` — JSON list of schema IDs. MCP hosts that auto-attach resources will keep the schema list in context so the model knows what tables exist.

## Configuration

Three environment variables are required; the server fails fast on launch if any are missing.

| Var | Example | Purpose |
|---|---|---|
| `OC_HOST` | `https://abc123.api.originchain.ai` | Tenant base URL. |
| `OC_TENANT` | `01HZ7K8F9M2N3P4Q5R6S7T8U9V` | Tenant ULID. |
| `OC_TOKEN` | `oc_live_…` | Bearer token. |

## Security

- The bearer token is read from environment variables and is **never logged**, never printed to stdout/stderr, and never echoed in tool output.
- One bearer = full tenant access. Treat it like a database password. Store it in your OS keychain or your MCP host's secret store, not in checked-in files.
- Read-only / scoped tokens are recommended once available — use them by default for AI-agent contexts so an LLM mistake cannot mutate state.
- All traffic is HTTPS; the server only ever connects to the URL in `OC_HOST`.

## Get a tenant

Sign up and provision an OriginChain tenant: <https://originchain.ai/docs/quickstart>.

## License

MIT — copyright (c) 2026 Silicoyn Technologies Pvt Ltd. See [LICENSE](./LICENSE).
