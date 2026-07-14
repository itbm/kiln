# kiln-agentd — server-side coding agent sessions

`kiln-agentd` is the optional companion runner that gives Kiln its **Code**
tab: the phone starts a task against a GitHub repository, streams progress,
and reviews the resulting pull request. Each task runs in its own disposable
**Docker Sandboxes (`sbx`) microVM** containing a fresh clone and a headless
**Claude Agent SDK** loop pointed at *your* model provider (OpenRouter's
Anthropic-compatible endpoint or Ollama cloud).

Kiln without a configured runner behaves exactly as before — everything here
is opt-in.

## Design tenets

1. **Keys live on the device.** Provider key + GitHub PAT are sent per
   session, held only in runner memory, injected into the sandbox as
   environment, scrubbed at teardown, and redacted from every streamed byte.
2. **Nothing readable persists server-side.** Workspaces live on tmpfs;
   transcripts persist only in the phone's IndexedDB. The sole durable
   artefact is a minimal session journal encrypted with a key only the
   client holds (`X-Kiln-Journal-Key`).
3. **The server is boring.** agentd is a thin control plane; the agent runs
   inside the sandbox; policy is enforced by systems that can actually
   enforce it (sbx network policy, PAT scope, GitHub branch protection).
4. **Git + the phone are the durable state.** Any session — interrupted,
   failed or completed — can be continued or retried by seeding a fresh
   sandbox with its `kiln/*` task branch plus client-held history.
   Non-completed teardowns checkpoint-push work-in-progress first.

## Host prerequisites

- Linux with KVM (`/dev/kvm` present, user in the `kvm` group) — bare metal
  or a nested-virt-enabled VPS. `POST /sandbox` returns 500 without it.
- Docker Engine.
- `docker-sbx` installed with `sandboxd` running as a user service, plus a
  one-time `sbx login` and network-policy initialisation.
- The sandbox template image built and present:

  ```bash
  docker build -t kiln-agent:0.1.0 agentd/sandbox
  ```

## Running

The supported deployment is the compose profile in the repo root:

```bash
export KILN_AGENT_TOKEN="$(openssl rand -base64 33)"   # runner bearer token
export KILN_UID=$(id -u) KILN_GID=$(id -g)             # owner of the sandboxd socket
sudo mkdir -p /var/kiln-agent && sudo mount -t tmpfs tmpfs /var/kiln-agent  # tmpfs-backed workspaces
docker compose --profile agent up -d --build
```

Then in Kiln: **Settings → Agent runner** → enter the same token, your
GitHub PAT, and generate the journal key. The runner URL defaults to the
same origin (`/agent`), relayed by the bundled nginx.

Container subtleties baked into `compose.yaml` (§10 of the spec):

- `sandboxd` interprets `workspace` as a **host** path, so `/var/kiln-agent`
  is bind-mounted identically on both sides; keep it tmpfs-backed on the
  host or the nothing-persists guarantee doesn't hold.
- The socket's **directory** is mounted, not the socket file — a file bind
  pins the inode and goes stale when sandboxd restarts.
- agentd runs as the same UID/GID as the socket's owner and passes the
  socket path explicitly (no `sbx` CLI inside the container).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `KILN_AGENT_TOKEN` | — (required) | static bearer token for the Session API |
| `SBX_SOCKET` | `/run/sandboxd/sandboxd.sock` | sandboxd unix socket |
| `WORKSPACE_ROOT` | `/var/kiln-agent` | host-visible per-session workspace root |
| `JOURNAL_PATH` | `/var/lib/agentd/journal.jsonl` | encrypted session journal |
| `MAX_SESSIONS` | `3` | concurrent live sessions |
| `KILN_AGENT_TEMPLATE` | `kiln-agent:0.1.0` | sandbox template image tag |
| `SBX_EXPECTED_API_VERSION` | `0.16.0` | pinned sandboxd `api_version` (drift probe) |
| `IDLE_TTL_MINUTES` / `HARD_TTL_MINUTES` | `30` / `120` | session lifetimes |
| `LOG_LEVEL` | `info` | logs carry ids/states/timings only — never content |

## Session API

Base path `/agent/v1`, JSON, `Authorization: Bearer <token>` on every route
(`/healthz` excepted). Live-session routes work without the journal key;
listing sessions from before a restart requires `X-Kiln-Journal-Key`.

| Method & path | Purpose |
|---|---|
| `POST /sessions` | create + start (task, repo, provider `{baseUrl, token, model}`, github PAT, options, optional `resume`) |
| `GET /sessions` | live sessions (+ journal rows with the key) |
| `GET /sessions/{id}` | detail incl. latest `seq`, `prUrl` |
| `GET /sessions/{id}/events` | WebSocket upgrade (SSE fallback) — replays from `?after=<seq>`, then live-tails |
| `POST /sessions/{id}/input` | `{type:"user_message", text}` mid-task steering |
| `POST /sessions/{id}/finalise` | fallback push + PR if the loop ended without one |
| `POST /sessions/{id}/cancel` | graceful stop (checkpoint-push, keep events readable) |
| `DELETE /sessions/{id}` | immediate teardown + secret scrub |
| `GET /healthz` | unauthenticated liveness: driver health, api_version, template presence |

Browser WebSockets can't set headers, so the token rides a subprotocol:
`new WebSocket(url, ["kiln-agent-v1", "bearer." + base64url(token)])`.

Events share one envelope, a deliberate superset of Kiln's ToolStep model:

```json
{ "seq": 412, "ts": 1752402100123, "type": "tool_use",
  "payload": { "tool": "Bash", "input": { "command": "npm test" } } }
```

`type ∈ { state, bootstrap, assistant_text, tool_use, tool_result, diff, pr, result, warning, error }`

### Network resolution

Whatever profile a session picks (`allow-all | balanced | deny-all`), agentd
injects baseline sandbox-scoped allow rules for `github.com`,
`api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`
and the model endpoint, so even a `deny-all` session can clone and think.
`extraHosts` adds `host:port` / `**.host` rules; `allowPackageManagers`
maps to the sbx flag of the same name.

## GitHub integration

- Use a **fine-grained PAT**, selected-repositories only, with *Contents:
  Read/Write* and *Pull requests: Read/Write* (add *Workflows* only if the
  agent may edit `.github/workflows/**`).
- One branch per session (`kiln/<slug>-<id6>`); resumes must target
  `kiln/*` branches — protect `main` with GitHub branch protection so the
  merge gate is GitHub-enforced, not prompt-enforced.
- Finalisation is the agent's instructed last step (`git push` +
  `gh pr create --fill`); agentd's fallback exec covers loops that end
  without a PR and emits the `diff` (stat + patch, 256 KiB cap) and `pr`
  events the phone renders as cards.

## sbx API drift strategy

The sandboxd API is unofficial (reverse-engineered as OpenAPI 0.16.0 / sbx
v0.34.0; `itbm/sbx-sdk` is not published to npm, so `src/driver/sbx.ts`
embeds the handful of calls agentd needs). Mitigations:

- boot probe asserts `GET /daemon/health` `api_version` equals the pin;
  on mismatch agentd keeps diagnostics readable but **refuses new sessions**;
- the `SandboxDriver` interface caps any breaking change to one adapter
  file — a plain-Docker fallback driver for KVM-less hosts is a documented
  follow-up behind the same interface;
- the raw-socket hijack for interactive exec lives in `src/driver/hijack.ts`
  and auto-detects Docker-style stream multiplexing.

## Development

```bash
cd agentd
npm install
npm test          # tsc build + node:test suite (redaction, ring buffer, journal, validation)
KILN_AGENT_TOKEN=$(openssl rand -base64 33) npm run dev
```

`kill -9` resilience: on boot, agentd destroys any `kiln-*` sandbox and
tombstones non-terminal journal rows as `interrupted` — without decrypting
a byte. When the phone next connects with its journal key it learns each
interrupted session's branch and offers **Continue**, which reconstructs
context from the branch + the phone's own transcript. Git is authoritative;
the transcript is advisory.
