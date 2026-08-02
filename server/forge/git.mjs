/**
 * Git operations the forge owns, rather than the agent.
 *
 * These run on the host side, in the forge, against `$WS/repo` — which works
 * because the workspace is a host directory that sbx passes through into the
 * VM. Running them here rather than exec'ing into the sandbox means the clone
 * happens *before* any sandbox exists, and it keeps the push guard out of
 * reach of the process it is guarding.
 *
 * The credential helper reads $GITHUB_TOKEN from the environment of this
 * process only. The token is never written into the remote URL or
 * .git/config, where `git remote -v` inside the VM would hand it straight to
 * an agent with a shell.
 */
import { execFile } from "node:child_process"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const GIT_TIMEOUT_MS = 10 * 60 * 1000

/** Paths that must never reach a commit — Kiln's own state and the agent's. */
const FORBIDDEN = [/(^|\/)\.kiln(\/|$)/, /(^|\/)\.claude(\/|$)/]

export function repoDir(ws) {
  return join(ws, "repo")
}
export function kilnDir(ws) {
  return join(ws, ".kiln")
}

function git(args, { cwd, token, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          ...(token ? { GITHUB_TOKEN: token } : {}),
          // Identity for the commits the agent's work lands in. Not a real
          // address: it must not look like a person who could be contacted
          // about a change they didn't make.
          GIT_AUTHOR_NAME: "Kiln",
          GIT_AUTHOR_EMAIL: "kiln@localhost",
          GIT_COMMITTER_NAME: "Kiln",
          GIT_COMMITTER_EMAIL: "kiln@localhost",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          // Never echo the token back if it somehow reached a message.
          const scrub = (s) =>
            token ? String(s ?? "").split(token).join("«token»") : String(s ?? "")
          reject(new Error(scrub(stderr) || scrub(err.message)))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * A credential helper that answers from $GITHUB_TOKEN. Written into the repo's
 * own config (not global), and it stores no secret itself — the token only
 * exists in the environment of the git process the forge spawns.
 */
const CRED_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

export async function ensureClone({ ws, owner, name, baseBranch, workBranch, token }) {
  const dir = repoDir(ws)
  await mkdir(kilnDir(ws), { recursive: true })
  await mkdir(join(kilnDir(ws), "uploads"), { recursive: true })

  if (existsSync(join(dir, ".git"))) return { cloned: false, dir }

  await mkdir(dir, { recursive: true })
  // Base is overridable so tests can clone from a local bare repo instead of
  // reaching github.com; production never sets it.
  const base = process.env.KILN_GITHUB_BASE ?? "https://github.com"
  const url = `${base}/${owner}/${name}.git`
  // Shallow: an agent needs the tree, not the history, and a deep clone of a
  // large repo is the slowest part of a first turn by a wide margin.
  await git(
    ["clone", "--branch", baseBranch, "--depth", "50", url, "."],
    { cwd: dir, token },
  )
  await git(["config", "credential.helper", CRED_HELPER], { cwd: dir })
  await git(["checkout", "-b", workBranch], { cwd: dir })

  // Repo-local, never committed, so it leaves no diff in the user's project.
  // Claude Code writes settings.local.json into the project directory.
  await writeFile(
    join(dir, ".git", "info", "exclude"),
    "# added by Kiln — local only, never committed\n/.claude/\n",
    "utf8",
  )
  return { cloned: true, dir }
}

/** Porcelain status as a list of paths, for the journal and the guard. */
export async function changedPaths(ws) {
  const out = await git(["status", "--porcelain"], { cwd: repoDir(ws) })
  return out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
}

/**
 * Commit and push the work branch.
 *
 * Deliberately not `git add -A` with a blind push: $WS/.kiln is a sibling of
 * the tree so it is already out of reach, but the assertion is cheap and what
 * it prevents — a session transcript or a token pushed to a public repo — is
 * unrecoverable once done.
 */
export async function commitAndPush({ ws, workBranch, baseBranch, message, token }) {
  const cwd = repoDir(ws)
  const paths = await changedPaths(ws)
  if (!paths.length) return { pushed: false, files: 0, commits: 0 }

  const offending = paths.filter((p) => FORBIDDEN.some((re) => re.test(p)))
  if (offending.length)
    throw new Error(
      `Refusing to commit Kiln's own state: ${offending.slice(0, 5).join(", ")}`,
    )

  // Just the tree. Naming the excluded paths explicitly here would be worse
  // than redundant: `git add` *errors* when a pathspec names an ignored path,
  // so the completely ordinary case of Claude Code writing
  // .claude/settings.local.json would fail the whole turn. .git/info/exclude
  // already skips it silently; the staged assertion below is the real guard,
  // and it catches anything the ignore rules didn't.
  await git(["add", "--", "."], { cwd })
  const staged = (await git(["diff", "--cached", "--name-only"], { cwd }))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!staged.length) return { pushed: false, files: 0, commits: 0 }

  const stagedOffending = staged.filter((p) => FORBIDDEN.some((re) => re.test(p)))
  if (stagedOffending.length)
    throw new Error(
      `Refusing to push Kiln's own state: ${stagedOffending.slice(0, 5).join(", ")}`,
    )

  await git(["commit", "-m", message], { cwd })
  await git(["push", "-u", "origin", workBranch], { cwd, token })

  // How many commits this branch adds over its base. Counted against the
  // base's remote-tracking ref, which exists in a shallow clone — unlike
  // origin/<workBranch>, which may not be written yet immediately after the
  // push that created it.
  //
  // Wrapped because the push has already succeeded by this point: failing a
  // completed turn over a number shown on a card would throw away real work.
  let commits = 1
  try {
    const out = await git(
      ["rev-list", "--count", "HEAD", "--not", `origin/${baseBranch}`],
      { cwd },
    )
    commits = Number(out.trim()) || 1
  } catch {
    /* keep 1 — the branch card is descriptive, not load-bearing */
  }
  return { pushed: true, files: staged.length, commits }
}

/** Chat deleted — the workspace goes with it. */
export async function shred(ws) {
  await rm(ws, { recursive: true, force: true })
}
