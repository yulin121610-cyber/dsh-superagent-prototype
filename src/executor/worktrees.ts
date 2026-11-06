/** Host-managed git worktrees that isolate local-workspace write tickets from their project's own checkout. */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Execution } from '../core/index.ts'
import { GIT_LOCATION } from '../infra/environment.ts'

/** How long one git command used for worktree management may run. */
const GIT_TIMEOUT_MS = 60_000
/** The process environment git runs in: never the repository the host's own environment names, and never prompting. */
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const name of GIT_LOCATION) delete env[name]
  return env
}
/** Runs git and returns its trimmed standard output; rejects with git's message on failure. */
export function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnvironment(), timeout: GIT_TIMEOUT_MS, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${String(stderr || error.message).trim()}`))
      else resolve(String(stdout).trim())
    })
  })
}
/** The branch a ticket's worktree uses. */
export const worktreeBranch = (ticketId: string): string => `superagent/${ticketId}`
/**
 * The top level of the git checkout holding `projectPath` when it is a non-bare repository with at least one commit, and the
 * project's path inside it; undefined otherwise, which keeps the ticket on the project's exclusive lock.
 */
export function gitProject(projectPath: string): { repository: string; subdirectory: string } | undefined {
  try {
    const run = (args: string[], cwd = projectPath) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnvironment(), timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return undefined
    const repository = realpathSync(run(['rev-parse', '--show-toplevel']))
    run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    const subdirectory = relative(repository, projectPath)
    if (subdirectory.startsWith('..') || isAbsolute(subdirectory)) return undefined
    // A project the repository ignores or does not track is absent from a new worktree of it.
    if (subdirectory && !run(['ls-tree', '-d', '--name-only', 'HEAD', '--', subdirectory], repository)) return undefined
    return { repository, subdirectory }
  } catch { return undefined }
}
/**
 * Plans a write ticket's worktree under `root`, outside the project: `<root>/<repository>-<hash>/<name>` on branch
 * `superagent/<ticketId>`. Returns undefined when the project is not a usable git checkout.
 */
export function planWorktree(root: string, projectPath: string, ticketId: string, name: string): { directory: string; worktree: NonNullable<Execution['worktree']> } | undefined {
  const project = gitProject(projectPath)
  if (!project) return undefined
  const hash = createHash('sha256').update(project.repository).digest('hex').slice(0, 8)
  const path = join(root, `${basename(project.repository)}-${hash}`, name)
  // The worktree root must not lie inside the project, where project scans and writes would reach it.
  if (path === project.repository || path.startsWith(project.repository + sep)) return undefined
  return { directory: project.subdirectory ? join(path, project.subdirectory) : path,
    worktree: { path, branch: worktreeBranch(ticketId), repository: project.repository } }
}
/** Pending git work per repository: worktree and branch changes of one repository run one at a time. */
const queues = new Map<string, Promise<unknown>>()
/** Runs `work` after earlier worktree operations on the same repository, in this process. */
export function serialized<T>(repository: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(repository) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  const settled = next.catch(() => {})
  queues.set(repository, settled)
  void settled.then(() => { if (queues.get(repository) === settled) queues.delete(repository) })
  return next
}
/** Whether `path` is the top of a registered worktree of `repository`. */
async function registered(repository: string, path: string): Promise<boolean> {
  const list = await git(['-C', repository, 'worktree', 'list', '--porcelain'])
  return list.split('\n').some(line => line.startsWith('worktree ') && line.slice('worktree '.length) === path)
}
/**
 * Creates the ticket's worktree, or reuses it: an existing registered worktree is kept as it is; a missing one is added
 * again from its branch, which keeps its commits, or with a new branch from the repository's HEAD. Returns the commit it
 * started from when it created the branch. Serialized per repository.
 */
export function ensureWorktree(worktree: NonNullable<Execution['worktree']>, directory: string): Promise<{ base?: string }> {
  return serialized(worktree.repository, async () => {
    const { repository, path, branch } = worktree
    if (existsSync(path) && await registered(repository, path)) {
      if (!existsSync(directory)) throw new Error(`The project directory is absent from worktree ${path}`)
      return {}
    }
    if (existsSync(path)) throw new Error(`${path} exists but is not a worktree of ${repository}`)
    await git(['-C', repository, 'worktree', 'prune'])
    await mkdir(dirname(path), { recursive: true })
    const hasBranch = await git(['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
    let base: string | undefined
    if (hasBranch) await git(['-C', repository, 'worktree', 'add', path, branch])
    else {
      base = await git(['-C', repository, 'rev-parse', 'HEAD^{commit}'])
      await git(['-C', repository, 'worktree', 'add', '-b', branch, path, base])
    }
    if (!existsSync(directory)) {
      await git(['-C', repository, 'worktree', 'remove', path]).catch(() => {})
      throw new Error(`The project directory is absent from worktree ${path}`)
    }
    return base ? { base } : {}
  })
}
/**
 * Removes the ticket's worktree and branch only when nothing would be lost: the worktree has no uncommitted or untracked
 * changes and the branch has no commit outside the repository's HEAD. Returns whether it removed them, or why it kept them.
 */
export function removeCleanWorktree(worktree: NonNullable<Execution['worktree']>, keep: () => boolean = () => false): Promise<{ removed: boolean; reason?: string }> {
  return serialized(worktree.repository, async () => {
    const { repository, path, branch } = worktree
    if (keep()) return { removed: false, reason: 'The ticket runs again' }
    if (!existsSync(path)) return { removed: false, reason: 'Absent' }
    if (await git(['-C', path, 'status', '--porcelain', '--untracked-files=all'])) return { removed: false, reason: 'Uncommitted changes' }
    const ahead = Number(await git(['-C', repository, 'rev-list', '--count', `HEAD..refs/heads/${branch}`]).catch(() => '1'))
    if (ahead !== 0) return { removed: false, reason: 'Unmerged commits' }
    if (keep()) return { removed: false, reason: 'The ticket runs again' }
    await git(['-C', repository, 'worktree', 'remove', path])
    await git(['-C', repository, 'branch', '-d', branch]).catch(() => {})
    return { removed: true }
  })
}
