/** Host-managed git worktrees that isolate local-workspace write tickets from their project's own checkout. */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, readlink, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Execution, ServiceScope, WorktreeRecord } from '../core/index.ts'
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
/** A git checkout containing `directory`: its toplevel, the path of `directory` inside it, and whether HEAD is a commit. */
export function gitCheckout(directory: string): { repository: string; subdirectory: string; commits: boolean } | undefined {
  try {
    const run = (args: string[], cwd = directory) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnvironment(), timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return undefined
    const repository = realpathSync(run(['rev-parse', '--show-toplevel']))
    const subdirectory = relative(repository, realpathSync(directory))
    if (subdirectory.startsWith('..') || isAbsolute(subdirectory)) return undefined
    let commits = true
    try { run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) } catch { commits = false }
    return { repository, subdirectory, commits }
  } catch { return undefined }
}
/**
 * The top level of the git checkout holding `projectPath` when it is a non-bare repository with at least one commit, and the
 * project's path inside it; undefined otherwise, which keeps the ticket on the project's exclusive lock.
 */
export function gitProject(projectPath: string): { repository: string; subdirectory: string } | undefined {
  const checkout = gitCheckout(projectPath)
  if (!checkout?.commits) return undefined
  // A project the repository ignores or does not track is absent from a new worktree of it.
  if (checkout.subdirectory) {
    try {
      const listed = execFileSync('git', ['-C', checkout.repository, 'ls-tree', '-d', '--name-only', 'HEAD', '--', checkout.subdirectory],
        { env: gitEnvironment(), timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      if (!listed) return undefined
    } catch { return undefined }
  }
  return { repository: checkout.repository, subdirectory: checkout.subdirectory }
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
/** Where a service-scoped write ticket runs. `aggregate` is a directory that shows every touched service under its name. */
export interface ServicePlan {
  directory: string
  worktree?: WorktreeRecord
  worktrees?: WorktreeRecord[]
  aggregate?: { path: string }
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8)
/** A path is usable only outside the project, where a worker could not scan or write the project's own checkout through it. */
const outsideProject = (projectPath: string, path: string): boolean => path !== projectPath && !path.startsWith(projectPath.endsWith(sep) ? projectPath : projectPath + sep)
const repoWorktreePath = (root: string, repository: string, name: string): string => join(root, `${basename(repository)}-${digest(repository)}`, name)
/**
 * Plans where a write ticket scoped to `services` runs. One monorepo gets a single worktree of that repository when
 * `concurrentWrites` is on, and otherwise stays in the shared checkout. Several repositories get one aggregate directory;
 * each repository with a commit gets a worktree there, and the others stay links to the shared checkout.
 */
export function planServices(root: string, projectPath: string, ticketId: string, name: string, services: ServiceScope[], concurrentWrites: boolean): ServicePlan {
  const branch = worktreeBranch(ticketId)
  const monorepos = new Map<string, ServiceScope[]>()
  const own: ServiceScope[] = []
  const plain: ServiceScope[] = []
  for (const service of services) {
    if (service.repository && service.repository !== service.path) (monorepos.get(service.repository) ?? monorepos.set(service.repository, []).get(service.repository)!).push(service)
    else if (service.repository) own.push(service)
    else plain.push(service)
  }
  const onlyMonorepo = own.length + plain.length === 0 && monorepos.size === 1
  if (onlyMonorepo) {
    const repository = [...monorepos.keys()][0]!
    const path = repoWorktreePath(root, repository, name)
    if (concurrentWrites && outsideProject(projectPath, path) && gitProject(repository)) return { directory: path, worktree: { path, branch, repository } }
    return { directory: services.length === 1 ? services[0]!.path : projectPath }
  }
  if (services.length === 1 && own.length === 1) {
    const service = own[0]!
    const path = repoWorktreePath(root, service.repository!, name)
    if (concurrentWrites && outsideProject(projectPath, path) && gitProject(service.path)) {
      return { directory: path, worktree: { path, branch, repository: service.repository!, service: service.name } }
    }
    return { directory: service.path }
  }
  if (services.length === 1) return { directory: services[0]!.path }
  const aggregate = join(root, `services-${digest(projectPath)}`, name)
  if (!outsideProject(projectPath, aggregate)) return { directory: projectPath }
  const worktrees: WorktreeRecord[] = []
  if (concurrentWrites) {
    for (const service of own) {
      if (!gitProject(service.path)) continue
      worktrees.push({ path: join(aggregate, service.name), branch, repository: service.repository!, service: service.name })
    }
    for (const repository of monorepos.keys()) {
      const path = repoWorktreePath(root, repository, name)
      if (outsideProject(projectPath, path) && gitProject(repository)) worktrees.push({ path, branch, repository })
    }
  }
  return { directory: aggregate, aggregate: { path: aggregate }, ...worktrees.length ? { worktrees } : {} }
}
/** How each service appears under an aggregate directory. `link` is false when the worktree itself is that entry. */
export function aggregateLinks(aggregate: string, services: ServiceScope[], trees: readonly WorktreeRecord[]): { name: string; target: string; link: boolean }[] {
  const usable = trees.filter(tree => !tree.error)
  return services.map(service => {
    const own = usable.find(tree => tree.service === service.name)
    if (own) return { name: service.name, target: own.path, link: own.path !== join(aggregate, service.name) }
    const repo = usable.find(tree => !tree.service && service.repository === tree.repository)
    if (repo) {
      const sub = relative(repo.repository, service.path)
      const target = !sub || sub === '.' ? repo.path : join(repo.path, sub)
      return { name: service.name, target, link: target !== join(aggregate, service.name) }
    }
    return { name: service.name, target: service.path, link: true }
  })
}
/** Points `dest` at `target`, keeping a link or directory that already does. */
async function ensureLink(dest: string, target: string): Promise<void> {
  try {
    const info = await lstat(dest)
    if (info.isSymbolicLink()) {
      const current = resolve(dirname(dest), await readlink(dest))
      if (current === target) return
      throw new Error(`${dest} points at ${current}, not ${target}`)
    }
    if (realpathSync(dest) === target) return
    throw new Error(`${dest} exists and is not a link to ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await symlink(target, dest)
  }
}
const ownRepository = (directory: string): boolean => {
  try { return gitCheckout(directory)?.repository === realpathSync(directory) } catch { return false }
}
/**
 * Creates `aggregate` and the links that expose touched services and the project's shared non-git files. A service whose
 * worktree is already the entry is left as that directory. Other git repositories under the project are not linked.
 */
export async function ensureAggregate(projectPath: string, aggregate: string, links: { name: string; target: string; link: boolean }[]): Promise<void> {
  await mkdir(aggregate, { recursive: true })
  const used = new Set(links.map(link => link.name))
  for (const link of links) if (link.link) await ensureLink(join(aggregate, link.name), link.target)
  for (const name of readdirSync(projectPath)) {
    if (name.startsWith('.') || used.has(name)) continue
    const source = join(projectPath, name)
    let info
    try { info = statSync(source) } catch { continue }
    if ((!info.isDirectory() && !info.isFile()) || (info.isDirectory() && ownRepository(source))) continue
    await ensureLink(join(aggregate, name), realpathSync(source))
  }
}
/** Removes an aggregate's symlinks and the directory when nothing else remains. Symlink targets are left in place. */
export async function removeAggregate(aggregate: string): Promise<void> {
  if (!existsSync(aggregate)) return
  for (const name of readdirSync(aggregate)) {
    const path = join(aggregate, name)
    if (lstatSync(path).isSymbolicLink()) await unlink(path)
  }
  await rmdir(aggregate).catch(() => { /* A kept worktree, or anything else, stays with the directory. */ })
}
