# External API and the `ccs` MCP server (issue #150)

Drive Claude Code Studio **from outside**: another Claude Code session, an MCP hub,
a monitoring script, a CI job. This document covers stage 1 — projects and tasks.
Chats (create a chat, send a message, read the reply, stop a turn) are stage 2,
because `send_message`/`stop_turn` have no documented server contract yet.

Two pieces:

- `mcp-ccs.js` — a self-contained stdio MCP server (zero dependencies) that talks to
  the HTTP API over `http` or `https`. Copy it anywhere; it needs no sibling files.
- `/api/external/v1/*` — a small, token-authenticated REST surface. It is the entire
  contract an external client gets; chats, files, settings and terminals are not
  reachable with an external token.

## 1. Create a token

Tokens are opt-in: with none on disk, every call to the external API is `401`.

```bash
# in the CCS data directory (or a container: docker exec -it claude-code-studio …)
node scripts/api-token.js create --name mcphub --scope read
```

The plaintext is printed **once**. Only a SHA-256 is stored, in `data/api-tokens.json`
(mode 0600), so a lost token is revoked and replaced, never recovered.

```bash
node scripts/api-token.js list          # metadata + last use, never the secret
node scripts/api-token.js revoke <id>   # effective on the next request
```

Scopes:

| scope  | may |
| --- | --- |
| `read` (default) | list projects, list/read tasks, read results |
| `full` | the above, plus create and cancel tasks |

`full` is code execution: a created task runs `claude` with the description as its
prompt, in the project workdir, with the container's permissions. Use `read` for
monitoring. Revoking a token does not affect the owner's browser session, and a
session logout does not revoke tokens.

The same operations exist over HTTP for a logged-in client:
`GET /api/api-tokens`, `POST /api/api-tokens {name, scope}`, `DELETE /api/api-tokens/<id>`.

## 2. Point a client at it

Claude Code (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "ccs": {
      "command": "node",
      "args": ["/path/to/claude-code-studio/mcp-ccs.js"],
      "env": {
        "CCS_URL": "http://127.0.0.1:3000",
        "CCS_TOKEN": "ccs_…"
      }
    }
  }
}
```

MCPHub or any host that runs stdio servers in its own container: mount or copy
`mcp-ccs.js`, then set the same two variables. `CCS_URL` may be any address the
container can reach (`http://claude-code-studio:3000` on a compose network, or an
`https://` reverse proxy) and may include a path prefix (`https://host/ccs`).

| variable | default | meaning |
| --- | --- | --- |
| `CCS_URL` | `http://127.0.0.1:3000` | server base URL, `http` or `https`, without `/api` |
| `CCS_TOKEN` | — | token from step 1; without it every tool call explains what is missing |

## 3. Tools

| tool | scope | notes |
| --- | --- | --- |
| `list_projects` | read | returns `id`, `name`, `workdir`, `isRemote` |
| `list_tasks` | read | filters: `project`, `status`, `limit` (default 20, max 100), newest first |
| `get_task` | read | one task, with its description |
| `get_task_result` | read | the structured result a finished run reported |
| `create_task` | full | **requires `project`**; defaults to `status: "backlog"` |
| `cancel_task` | full | refuses a completed task; idempotent otherwise |

`create_task` never inherits a workdir — an outside caller has no parent task, and
guessing one would start an unattended run in an arbitrary tree. A card created
without `status` lands in `backlog` and nothing runs; pass `status: "todo"` to queue
a run now (optionally with `scheduled_at`). Tasks get their own git worktree, the
same as a card created in the UI.

## 4. REST surface

All endpoints take `Authorization: Bearer ccs_…` and return JSON.

| method | path | scope |
| --- | --- | --- |
| GET | `/api/external/v1/me` | read |
| GET | `/api/external/v1/projects` | read |
| GET | `/api/external/v1/tasks?project=&status=&limit=` | read |
| GET | `/api/external/v1/tasks/:id` | read |
| GET | `/api/external/v1/tasks/:id/result` | read |
| POST | `/api/external/v1/tasks` | full |
| POST | `/api/external/v1/tasks/:id/cancel` | full |

`project` accepts an id or an exact name (case-insensitive). An ambiguous name is
refused with the candidate ids instead of resolved to whichever came first.

## 5. Boundaries

- A request carrying an `Origin` header is refused (`403`). Browsers attach one to
  every cross-site fetch; MCP clients never send one. This keeps a page the owner
  visits from spending a token that is sitting in a shell.
- Tokens are a fixed bearer credential, not a session: no expiry, revocable at any
  time, at most 20 at once.
- Remote (SSH) projects are not writable through this API yet; they are listed, and
  creating a task in one returns `400`.
- The external API is a local/trusted-network surface. Terminate TLS in front of it
  if it crosses an untrusted network; the server itself speaks plain HTTP.
