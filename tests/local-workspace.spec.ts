import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feishuKind } from '../src/sources/feishu.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { claimsConflict, lockClaim, type Execution, type ServiceScope } from '../src/core/index.ts'
import { WorkerSlots } from '../src/executor/dsh.ts'
import { discoverServices, freezeServices } from '../src/executor/project-routing.ts'
import { aggregateLinks, ensureAggregate, ensureWorktree, planServices, planWorktree, removeAggregate, removeCleanWorktree, serialized } from '../src/executor/worktrees.ts'
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
  const services = [{ name: 'ebfs-pay', path: 'ebfs-pay' }, { name: 'ebfs-account', path: 'ebfs-account' }]
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/ebfs', services }])).success).toBe(true)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', services }])).success).toBe(false)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/ebfs', services: [{ name: 'ebfs-pay', path: '/abs' }] }])).success).toBe(false)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/ebfs', services: [{ name: 'pay', path: 'pay' }, { name: 'pay', path: 'other' }] }])).success).toBe(false)
  expect(feishuKind.schema.safeParse(config([{ chatId: 'oc_1', listen: 'mentions', projectPath: '/ebfs', services: [{ name: 'pay', path: 'pay' }, { name: 'nested', path: 'pay/api' }] }])).success).toBe(false)
})

const execution = (patch: Partial<Execution>): Execution => ({ name: 'n', directory: '/p', assignment: '', ...patch })
const scope = (name: string, path: string, repository?: string): ServiceScope => ({ name, path, ...repository ? { repository } : {} })

it('locks services instead of the whole project, and keeps an unconfigured group on the project path', () => {
  const project = execution({ projectPath: '/ebfs' })
  const pay = execution({ projectPath: '/ebfs', services: [scope('pay', '/ebfs/ebfs-pay', '/ebfs/ebfs-pay')] })
  const account = execution({ projectPath: '/ebfs', services: [scope('account', '/ebfs/ebfs-account', '/ebfs/ebfs-account')] })
  const both = execution({ projectPath: '/ebfs', services: [scope('pay', '/ebfs/ebfs-pay', '/ebfs/ebfs-pay'), scope('account', '/ebfs/ebfs-account', '/ebfs/ebfs-account')] })
  const dealer = execution({ projectPath: '/otc', services: [scope('dealer', '/otc/dealer', '/otc')] })
  const web = execution({ projectPath: '/otc', services: [scope('web', '/otc/web', '/otc')] })
  expect(lockClaim(project)).toEqual({ readOnly: false, isolated: false, scopes: ['/ebfs'] })
  expect(claimsConflict(lockClaim(pay), lockClaim(account))).toBe(false)
  expect(claimsConflict(lockClaim(pay), lockClaim(pay))).toBe(true)
  expect(claimsConflict(lockClaim(both), lockClaim(account))).toBe(true)
  expect(claimsConflict(lockClaim(project), lockClaim(pay))).toBe(true)
  expect(claimsConflict(lockClaim(dealer), lockClaim(web))).toBe(true)
  const isolated = execution({ projectPath: '/otc', services: [scope('dealer', '/otc/dealer', '/otc')],
    worktree: { path: '/wt/dealer', branch: 'superagent/t', repository: '/otc' } })
  expect(lockClaim(isolated).isolated).toBe(true)
  expect(claimsConflict(lockClaim(isolated), lockClaim(web))).toBe(false)
  const reader = execution({ projectPath: '/otc', access: 'read-only', services: [scope('dealer', '/otc/dealer', '/otc')] })
  expect(claimsConflict(lockClaim(reader), lockClaim(web))).toBe(false)
  expect(claimsConflict(lockClaim(reader), lockClaim(dealer))).toBe(true)
  expect(claimsConflict(lockClaim(reader), lockClaim({ ...reader, services: [scope('web', '/otc/web', '/otc')] }))).toBe(false)
})

it('acquires every service of a ticket together, so overlapping tickets cannot deadlock', () => {
  const claim = (id: string) => id === 'ab' ? { readOnly: false, isolated: false, scopes: ['/p/a', '/p/b'] }
    : id === 'ba' ? { readOnly: false, isolated: false, scopes: ['/p/b', '/p/a'] }
    : { readOnly: false, isolated: false, scopes: ['/p/c'] }
  const slots = new WorkerSlots(() => [], () => 4, false, undefined, () => false, () => false, claim)
  slots.reserve('ab', 'launch')
  expect(() => slots.reserve('ba', 'launch')).toThrow('Project workspace is busy')
  expect(() => slots.reserve('ba', 'person')).toThrow('Project workspace is busy')
  slots.reserve('c', 'launch')
  expect(slots.used()).toBe(2)
  slots.free('ab')
  slots.reserve('ba', 'wake')
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

  it('discovers child repositories, and top-level directories of a monorepo, without saving them', async () => {
    const ebfs = join(directory, 'ebfs')
    mkdirSync(join(ebfs, 'docs'), { recursive: true })
    mkdirSync(join(ebfs, 'ebfs-pay'), { recursive: true })
    await git(ebfs, 'init', '-q', '-b', 'main', 'ebfs-pay')
    await git(ebfs, 'init', '-q', 'empty')
    const found = discoverServices(ebfs)
    expect(found.map(service => service.name).sort()).toEqual(['ebfs-pay', 'empty'])
    expect(found.every(service => service.kind === 'repo')).toBe(true)
    const otc = await repository('otc')
    mkdirSync(join(otc, 'dealer'))
    mkdirSync(join(otc, 'docs'))
    writeFileSync(join(otc, 'dealer', 'a.txt'), 'a\n')
    await git(otc, 'add', '.'); await git(otc, 'commit', '-q', '-m', 'service')
    expect(discoverServices(otc).map(service => service.name)).toEqual(['dealer', 'service'])
    expect(discoverServices(otc).every(service => service.kind === 'directory')).toBe(true)
  })

  it('freezes chosen services and treats an omitted or star choice as the whole project', async () => {
    const root = join(directory, 'ebfs'); mkdirSync(join(root, 'ebfs-pay'), { recursive: true })
    const configured = [{ name: 'ebfs-pay', path: 'ebfs-pay' }, { name: 'ebfs-account', path: 'ebfs-account' }]
    mkdirSync(join(root, 'ebfs-account'))
    const project = realpathSync(root)
    expect(freezeServices(project, configured, undefined)).toBeUndefined()
    expect(freezeServices(project, configured, ['*'])).toBeUndefined()
    expect(freezeServices(project, [], ['ebfs-pay'])).toBeUndefined()
    expect(freezeServices(project, configured, ['ebfs-pay'])).toEqual([{ name: 'ebfs-pay', path: realpathSync(join(root, 'ebfs-pay')) }])
    expect(() => freezeServices(project, configured, ['missing'])).toThrow('Unknown service "missing"')
  })

  it('plans one monorepo worktree, and an aggregate of multi-repo worktrees that links shared files only', async () => {
    const ebfs = join(directory, 'ebfs')
    const pay = await repository('ebfs/ebfs-pay')
    const account = await repository('ebfs/ebfs-account')
    mkdirSync(join(ebfs, 'docs'), { recursive: true })
    writeFileSync(join(ebfs, 'docs', 'guide.md'), 'guide\n')
    writeFileSync(join(ebfs, 'README.md'), 'shared\n')
    mkdirSync(join(ebfs, 'other'), { recursive: true })
    await git(ebfs, 'init', '-q', '-b', 'main', 'other')
    writeFileSync(join(ebfs, 'other', 'keep'), 'x\n')
    await git(join(ebfs, 'other'), 'add', '.'); await git(join(ebfs, 'other'), 'commit', '-q', '-m', 'other')
    const project = realpathSync(ebfs)
    const services: ServiceScope[] = [
      { name: 'ebfs-pay', path: pay, repository: pay },
      { name: 'ebfs-account', path: account, repository: account },
    ]
    const root = join(realpathSync(directory), 'worktrees')
    const planned = planServices(root, project, 'ticket1', 'fix-pay', services, true)
    expect(planned.aggregate?.path).toMatch(/services-[0-9a-f]{8}\/fix-pay$/)
    expect(planned.worktrees?.map(tree => tree.service).sort()).toEqual(['ebfs-account', 'ebfs-pay'])
    expect(planned.directory).toBe(planned.aggregate!.path)
    for (const tree of planned.worktrees!) await ensureWorktree(tree, tree.path)
    const links = aggregateLinks(planned.aggregate!.path, services, planned.worktrees!)
    await ensureAggregate(project, planned.aggregate!.path, links)
    expect(readFileSync(join(planned.aggregate!.path, 'ebfs-pay', 'README.md'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(planned.aggregate!.path, 'docs', 'guide.md'), 'utf8')).toBe('guide\n')
    expect(readFileSync(join(planned.aggregate!.path, 'README.md'), 'utf8')).toBe('shared\n')
    expect(existsSync(join(planned.aggregate!.path, 'other'))).toBe(false)
    writeFileSync(join(planned.worktrees![0]!.path, 'README.md'), 'changed\n')
    const clean = planned.worktrees!.find(tree => tree.service !== planned.worktrees![0]!.service)!
    expect((await removeCleanWorktree(planned.worktrees![0]!)).removed).toBe(false)
    expect((await removeCleanWorktree(clean)).removed).toBe(true)
    await removeAggregate(planned.aggregate!.path)
    expect(existsSync(planned.aggregate!.path)).toBe(true)
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('shared\n')
    const otc = await repository('otc')
    mkdirSync(join(otc, 'dealer')); writeFileSync(join(otc, 'dealer', 'a.txt'), 'a\n')
    await git(otc, 'add', '.'); await git(otc, 'commit', '-q', '-m', 'dealer')
    const mono = planServices(root, otc, 'ticket2', 'fix-dealer', [{ name: 'dealer', path: join(otc, 'dealer'), repository: otc },
      { name: 'web', path: join(otc, 'web'), repository: otc }], true)
    mkdirSync(join(otc, 'web'))
    expect(mono.worktree?.repository).toBe(otc)
    expect(mono.worktrees).toBeUndefined()
    expect(mono.directory).toBe(mono.worktree!.path)
    expect(planServices(root, otc, 'ticket3', 'n', [{ name: 'dealer', path: join(otc, 'dealer'), repository: otc }], false).directory).toBe(join(otc, 'dealer'))
    await git(ebfs, 'init', '-q', 'empty')
    const empty = realpathSync(join(ebfs, 'empty'))
    expect(planServices(root, project, 'ticket4', 'n', [{ name: 'empty', path: empty, repository: empty }], true)).toEqual({ directory: empty })
  })

  it('runs worktree changes of one repository one at a time', async () => {
    const order: string[] = []
    const slow = (name: string) => serialized('/repo', async () => { order.push(`${name}:start`); await new Promise(resolve => setTimeout(resolve, 20)); order.push(`${name}:end`) })
    await Promise.all([slow('a'), serialized('/repo', async () => { throw new Error('fails') }).catch(() => {}), slow('b')])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })
})
