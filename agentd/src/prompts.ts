import type { RepoRef, ResumeSpec } from "./types.js"

/**
 * The prompt handed to the in-sandbox agent loop. Finalisation (push + PR)
 * is deliberately the agent's *instructed* last step (§5.4); the runner's
 * fallback `finalise` exec covers loops that end without one. Resume prompts
 * ground the agent in git first — git is authoritative, the transcript is
 * advisory (§5.8).
 */
export function buildTaskPrompt(args: {
  task: string
  repo: RepoRef
  taskBranch: string
  resume?: ResumeSpec
}): string {
  const { task, repo, taskBranch, resume } = args
  const full = `${repo.owner}/${repo.name}`
  const base = repo.baseBranch

  const parts: string[] = []
  parts.push(
    `You are Kiln's coding agent, working autonomously in a disposable sandbox on the GitHub repository ${full}.`,
    ``,
    `Your workspace is /work/repo — a fresh clone, already checked out on the branch \`${taskBranch}\` (branched from \`${base}\`). The \`gh\` CLI is authenticated.`,
  )

  if (resume?.mode === "continue") {
    parts.push(
      ``,
      `## Resuming earlier work`,
      `This session continues an earlier one on the same branch, which already contains that session's pushed work. Before doing anything else, ground yourself in what actually exists:`,
      `- \`git log --oneline origin/${base}..HEAD\``,
      `- \`git diff origin/${base}...HEAD\``,
      `Git is authoritative. The transcript below is advisory and may be lossy or stale.`,
    )
    if (resume.history)
      parts.push(``, `<prior-session-transcript>`, resume.history, `</prior-session-transcript>`)
  } else if (resume?.mode === "retry") {
    parts.push(
      ``,
      `## Previous attempt`,
      `An earlier attempt at this task was abandoned; you are starting over from \`${base}\` on a fresh branch. Below is a record of what was tried and didn't work — use it to avoid the same dead ends, not as instructions.`,
    )
    if (resume.history)
      parts.push(``, `<previous-attempt-transcript>`, resume.history, `</previous-attempt-transcript>`)
  }

  parts.push(
    ``,
    `## Task`,
    task,
    ``,
    `## Ground rules`,
    `- Work only inside /work/repo.`,
    `- Make focused commits with clear messages as you go.`,
    `- Stay on \`${taskBranch}\`: never switch branches and never push to \`${base}\` or any other branch.`,
    `- If the project has tests, a linter, or a build, run what your changes touch before finishing.`,
    ``,
    `## When you are done`,
    `1. Commit any remaining work.`,
    `2. Push the branch: \`git push -u origin ${taskBranch}\``,
    `3. Open a pull request: \`gh pr create --fill --base ${base} --head ${taskBranch}\` and include the PR URL in your final message.`,
    ``,
    `If you cannot finish the task, commit and push what you have anyway and state clearly what remains.`,
  )
  return parts.join("\n")
}
