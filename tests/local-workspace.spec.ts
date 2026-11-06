import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feishuKind } from '../src/sources/feishu.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { WorkerSlots } from '../src/executor/dsh.ts'
import { ensureWorktree, planWorktree, removeCleanWorktree, serialized } from '../src/executor/worktrees.ts'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testMachine } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-local-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

it('starts from an existing multi-repository workspace without probing GitHub or altering its files', async () => {
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'AGENTS.md'), 'Existing project instructions\n')
  const probe = vi.fn(async () => { throw new Error('GitHub must not run') })
  const deployment = await resolveDeployment(testMachine({ stateDir: directory, localWorkspace: workspace }), {}, probe)
  expect(deployment).toMatchObject({ localWorkspace: realpathSync(workspace), repository: '' })
  expect(deployment.github).toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
  expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Existing project instructions\n')
})

it('rejects relative, absent and non-directory workspaces instead of creating them', async () => {
  writeFileSync(join(directory, 'file'), 'keep')
  for (const workspace of ['relative', join(directory, 'missing'), join(directory, 'file')]) {
    await expect(resolveDeployment(testMachine({ localWorkspace: workspace }), {}, vi.fn()))
      .rejects.toMatchObject({ code: 'localWorkspaceInvalid', place: 'deployment' })
  }
})

it('keeps a GitLab remote intact and blocks the operator GitHub CLI in local mode', async () => {
  const deployment = await resolveDeployment(testMachine({ stateDir: directory, localWorkspace: directory }), {}, vi.fn())
  await writeEnvironment(deployment, [])
  expect(readFileSync(workerGitConfig(directory), 'utf8')).not.toContain('github.com')
  const env = { ...gitEnv(), ...agentVariables(directory) }
  await exec('git', ['init', '-q', 'repo'], { cwd: directory, env })
  const cwd = join(directory, 'repo')
  const remote = 'git@gitlab.example.test:team/service.git'
  await exec('git', ['remote', 'add', 'origin', remote], { cwd, env })
  expect((await exec('git', ['remote', 'get-url', 'origin'], { cwd, env })).stdout.trim()).toBe(remote)
  await expect(exec(join(workerBin(directory), 'gh'), ['api', 'user'], { env }))
    .rejects.toThrow('GitHub is unavailable in local workspace mode')
})

it('refuses GitHub API calls before starting a process in local mode', async () => {
  const deployment = await resolveDeployment(testMachine({ localWorkspace: directory }), {}, vi.fn())
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run')
  await expect(commands.api('issues/1')).rejects.toThrow('GitHub is unavailable')
  expect(run).not.toHaveBeenCalled()
})

it('keeps human follow-ups from launching a second worker against a shared local workspace', () => {
  const slots = new WorkerSlots(() => [], () => 1, false)
  slots.reserve('first', 'launch')
  expect(() => slots.reserve('second', 'launch')).toThrow('No worker slot')
  expect(() => slots.reserve('second', 'person')).toThrow('No worker slot')
  slots.free('first')
  expect(() => slots.reserve('second', 'person')).not.toThrow()
})

it('locks canonical project roots through startup, running turns and human wakes while honoring the total limit', () => {
  const running: string[] = []
  const projects: Record<string, string> = { a: '/ebfs', a2: '/ebfs', child: '/ebfs/service', b: '/otc', c: '/other', prefix: '/ebfs-other' }
  const slots = new WorkerSlots(() => running, () => 2, false, id => projects[id])
  slots.reserve('a', 'launch')
  for (const by of ['launch', 'wake', 'person'] as const) expect(() => slots.reserve('a2', by)).toThrow('Project workspace is busy')
  expect(() => slots.reserve('child', 'launch')).toThrow('Project workspace is busy')
  slots.reserve('prefix', 'launch') // Path prefixes alone do not identify the same project.
  expect(() => slots.reserve('c', 'person')).toThrow('No worker slot')
  slots.free('prefix')
  slots.reserve('b', 'wake')
  running.push('a'); slots.free('a')
  expect(() => slots.reserve('a2', 'person')).toThrow('Project workspace is busy')
  running.length = 0
  slots.reserve('a2', 'person')
  expect(slots.used()).toBe(2)
})

it('keeps legacy and unbound tickets exclusive in both directions', () => {
  const slots = new WorkerSlots(() => [], () => 4, false, id => id === 'bound' ? '/project' : undefined)
  slots.reserve('legacy', 'launch')
  expect(() => slots.reserve('bound', 'launch')).toThrow('Project workspace is busy')
  slots.free('legacy')
  slots.reserve('bound', 'launch')
  expect(() => slots.reserve('legacy', 'person')).toThrow('Project workspace is busy')
})

it('shares project access only between explicit readers and excludes writers, including human wakes', () => {
  const running: string[] = []
  const projects: Record<string, string> = { r1: '/project', r2: '/project', writer: '/project', other: '/other' }
  const slots = new WorkerSlots(() => running, () => 3, false, id => projects[id], id => id.startsWith('r'))
  slots.reserve('r1', 'launch'); slots.reserve('r2', 'person')
  expect(() => slots.reserve('writer', 'launch')).toThrow('Project workspace is busy')
  slots.reserve('other', 'launch')
  expect(slots.used()).toBe(3)
  running.push('r1'); slots.free('r1'); slots.free('r2')
  expect(() => slots.reserve('writer', 'person')).toThrow('Project workspace is busy')
  running.length = 0
  slots.reserve('writer', 'launch')
  for (const by of ['launch', 'wake', 'person'] as const) expect(() => slots.reserve('r2', by)).toThrow('Project workspace is busy')
})


it('validates optional group project paths and rejects duplicate project assignments', () => {
  const config = (chats: unknown[]) => ({ chats })
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions' }])).success).toBe(true)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/ebfs' }, { chatId: 'oc_2', listen: 'mentions', projectPath: '/otc' }])).success).toBe(true)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: 'relative' }])).success).toBe(false)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/project' }, { chatId: 'oc_2', listen: 'mentions', projectPath: '/project/.' }])).success).toBe(false)
  const project = join(directory, 'project'), alias = join(directory, 'alias')
  mkdirSync(project); symlinkSync(project, alias, 'dir')
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: project }, { chatId: 'oc_2', listen: 'mentions', projectPath: alias }])).success).toBe(false)
})

it('lets isolated writers share a project with each other and with readers while unisolated writers stay exclusive', () => {
  const running: string[] = []
  const projects: Record<string, string> = { w1: '/project', w2: '/project', r1: '/project', plain: '/project', other: '/other' }
  const isolated = new Set(['w1', 'w2'])
  const slots = new WorkerSlots(() => running, () => 3, false, id => projects[id], id => id.startsWith('r'), id => isolated.has(id))
  slots.reserve('w1', 'launch'); slots.reserve('w2', 'launch'); slots.reserve('r1', 'person')
  expect(slots.used()).toBe(3)
  expect(() => slots.reserve('other', 'launch')).toThrow('No worker slot') // The total limit still applies.
  running.push('w1', 'w2'); slots.free('w1'); slots.free('w2'); slots.free('r1')
  expect(() => slots.reserve('other', 'launch')).not.toThrow()
  slots.free('other')
  // A writer without a worktree still waits for the reader, though not for the isolated writers.
  running.push('r1')
  expect(() => slots.reserve('plain', 'launch')).toThrow('Project workspace is busy')
  running.splice(running.indexOf('r1'), 1)
  expect(() => slots.reserve('plain', 'wake')).not.toThrow()
  expect(() => slots.reserve('r1', 'launch')).toThrow('Project workspace is busy')
  // A writer whose worktree failed is no longer isolated and waits like any writer.
  slots.free('plain'); isolated.delete('w2'); running.splice(running.indexOf('w2'), 1)
  expect(() => slots.reserve('w2', 'launch')).not.toThrow() // Only isolated w1 runs on the project.
  slots.free('w2'); running.push('r1')
  expect(() => slots.reserve('w2', 'launch')).toThrow('Project workspace is busy')
})

describe('host-managed worktrees', () => {
  const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, env: gitEnv({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' }) }).then(result => result.stdout.trim())
  async function repository(name = 'repo'): Promise<string> {
    const path = join(directory, name)
    mkdirSync(join(path, 'service'), { recursive: true })
    await git(directory, 'init', '-q', '-b', 'main', name)
    writeFileSync(join(path, 'README.md'), 'base\n'); writeFileSync(join(path, 'service', 'a.txt'), 'a\n')
    await git(path, 'add', '.'); await git(path, 'commit', '-q', '-m', 'base')
    return realpathSync(path)
  }

  it('plans worktrees outside git projects only, keeping a tracked subdirectory', async () => {
    const repo = await repository(), root = join(realpathSync(directory), 'worktrees')
    const plan = planWorktree(root, repo, 'ticket1', 'fix-a-ticket1')!
    expect(plan.worktree).toEqual({ path: expect.stringMatching(new RegExp(`^${root}/repo-[0-9a-f]{8}/fix-a-ticket1$`)), branch: 'superagent/ticket1', repository: repo })
    expect(plan.directory).toBe(plan.worktree.path)
    expect(planWorktree(root, join(repo, 'service'), 't2', 'n')!.directory).toBe(join(planWorktree(root, join(repo, 'service'), 't2', 'n')!.worktree.path, 'service'))
    const plain = join(directory, 'plain'); mkdirSync(plain)
    expect(planWorktree(root, realpathSync(plain), 't3', 'n')).toBeUndefined()
    await git(directory, 'init', '-q', 'empty')
    expect(planWorktree(root, realpathSync(join(directory, 'empty')), 't4', 'n')).toBeUndefined() // No commit yet.
    expect(planWorktree(join(repo, '.worktrees'), repo, 't5', 'n')).toBeUndefined() // Never inside the project.
  })

  it('creates concurrent worktrees of one repository on their own branches, reuses them and keeps unmerged work', async () => {
    const repo = await repository(), root = join(realpathSync(directory), 'worktrees')
    const one = planWorktree(root, repo, 'ticket1', 'one')!, two = planWorktree(root, repo, 'ticket2', 'two')!
    const [first, second] = await Promise.all([ensureWorktree(one.worktree, one.directory), ensureWorktree(two.worktree, two.directory)])
    const head = await git(repo, 'rev-parse', 'HEAD')
    expect(first).toEqual({ base: head }); expect(second).toEqual({ base: head })
    expect(await git(one.directory, 'branch', '--show-current')).toBe('superagent/ticket1')
    expect(await git(two.directory, 'branch', '--show-current')).toBe('superagent/ticket2')
    expect(await git(repo, 'status', '--porcelain')).toBe('')
    expect(await git(repo, 'branch', '--show-current')).toBe('main')
    writeFileSync(join(one.directory, 'README.md'), 'changed in one\n')
    expect(await ensureWorktree(one.worktree, one.directory)).toEqual({}) // Reused as it is.
    expect(readFileSync(join(one.directory, 'README.md'), 'utf8')).toBe('changed in one\n')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('base\n')
    // Uncommitted changes and unmerged commits stay; a clean worktree with nothing new goes with its branch.
    expect(await removeCleanWorktree(one.worktree)).toEqual({ removed: false, reason: 'Uncommitted changes' })
    await git(one.directory, 'commit', '-qam', 'work')
    expect(await removeCleanWorktree(one.worktree)).toEqual({ removed: false, reason: 'Unmerged commits' })
    expect(await removeCleanWorktree(two.worktree, () => true)).toEqual({ removed: false, reason: 'The ticket runs again' })
    expect(await removeCleanWorktree(two.worktree)).toEqual({ removed: true })
    expect(await git(repo, 'branch', '--list', 'superagent/ticket2')).toBe('')
    // A worktree removed by hand comes back from its branch with its commits.
    rmSync(one.worktree.path, { recursive: true, force: true })
    expect(await ensureWorktree(one.worktree, one.directory)).toEqual({})
    expect(readFileSync(join(one.directory, 'README.md'), 'utf8')).toBe('changed in one\n')
  })

  it('refuses a planned path that holds something other than its worktree', async () => {
    const repo = await repository(), root = join(realpathSync(directory), 'worktrees')
    const plan = planWorktree(root, repo, 'ticket1', 'one')!
    mkdirSync(plan.worktree.path, { recursive: true }); writeFileSync(join(plan.worktree.path, 'keep'), 'x')
    await expect(ensureWorktree(plan.worktree, plan.directory)).rejects.toThrow('is not a worktree')
    expect(readFileSync(join(plan.worktree.path, 'keep'), 'utf8')).toBe('x')
  })

  it('runs worktree changes of one repository one at a time', async () => {
    const order: string[] = []
    const slow = (name: string) => serialized('/repo', async () => { order.push(`${name}:start`); await new Promise(resolve => setTimeout(resolve, 20)); order.push(`${name}:end`) })
    await Promise.all([slow('a'), serialized('/repo', async () => { throw new Error('fails') }).catch(() => {}), slow('b')])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })
})
