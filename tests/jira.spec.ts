/** Jira HTTP protocol simulated entirely in memory: no sockets and no real network requests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Jira } from '../src/app/jira.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { JiraConfigSchema, JIRA_STATES } from '../src/jira/config.ts'
import { JiraClient, jiraSecret } from '../src/jira/client.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { deferred } from './fixtures/async.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const TOKEN = 'synthetic-jira-test-credential'
const CONFIG = { enabled: true, baseUrl: 'https://jira.invalid/context', secret: { kind: 'env', name: 'JIRA_TEST_TOKEN' },
  mappings: [{ chatId: 'oc_team', projectKey: 'DEMO', labels: ['team'], components: ['API'], assignee: 'alice' }],
  transitions: { working: 'Start', completed: '31', failed: 'Fail' } }
interface Issue { key: string; fields: { summary: string; status: { id: string; name: string }; labels: string[]; project: { key: string }
  priority: { name: string }; assignee: { displayName: string }; updated: string }; comments: { body: string }[] }
/** REST v2 mock server: accepts Request-shaped fetch calls and returns HTTP responses without opening a socket. */
class MockJira {
  issues: Issue[] = []
  calls: { method: string; path: string; body: any; authorization: string | null }[] = []
  offline = false
  loseCreate = false
  hideCreated = false
  loseTransition = false
  loseComment = false
  rejectCreate = false
  createCount = 0
  commentCount = 0
  transitionCount = 0
  cap = 100
  fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init), parsed = new URL(request.url)
    if (!request.url.startsWith('https://jira.invalid/context/rest/api/2/')) throw new Error('Unexpected network target')
    const path = parsed.pathname.slice('/context/rest/api/2/'.length), method = request.method
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.calls.push({ method, path, body, authorization: request.headers.get('authorization') })
    if (this.offline) return Response.json({ error: TOKEN }, { status: 503 })
    if (path === 'myself') return Response.json({ name: 'bot', displayName: 'Jira Bot' })
    if (path.startsWith('project/')) return Response.json({ issueTypes: [{ id: '3', name: 'Task' }, { id: '1', name: 'Bug' }] })
    if (path === 'search') {
      let rows = this.issues
      const marker = /labels = "([^"]+)"/.exec(body.jql)?.[1]
      if (marker) rows = this.hideCreated ? [] : rows.filter(issue => issue.fields.labels.includes(marker))
      const maxResults = Math.min(this.cap, body.maxResults)
      return Response.json({ startAt: body.startAt, maxResults, total: rows.length, issues: rows.slice(body.startAt, body.startAt + maxResults) })
    }
    if (path === 'issue' && method === 'POST') {
      this.createCount++
      if (this.rejectCreate) return Response.json({ error: TOKEN }, { status: 400 })
      const issue = this.add(body.fields.summary, body.fields.labels)
      if (this.loseCreate) { this.loseCreate = false; throw new Error(`lost response ${TOKEN}`) }
      return Response.json({ key: issue.key }, { status: 201 })
    }
    const [, key, operation] = path.split('/')
    const issue = this.issues.find(issue => issue.key === key)
    if (!issue) return Response.json({ error: TOKEN }, { status: 404 })
    if (!operation) return Response.json(issue)
    if (operation === 'transitions') {
      if (method === 'GET') return Response.json({ transitions: [
        { id: '21', name: 'Start', to: { id: '2', name: 'In Progress' } },
        { id: '31', name: 'Complete', to: { id: '3', name: 'Done' } },
        { id: '41', name: 'Fail', to: { id: '4', name: 'Failed' } },
      ] })
      this.transitionCount++
      issue.fields.status = { id: ({ '21': '2', '31': '3', '41': '4' } as Record<string, string>)[body.transition.id]!, name: body.transition.id === '31' ? 'Done' : 'In Progress' }
      if (this.loseTransition) { this.loseTransition = false; throw new Error('lost transition response') }
      return new Response(null, { status: 204 })
    }
    if (operation === 'comment') {
      if (method === 'GET') {
        const startAt = Number(parsed.searchParams.get('startAt') ?? 0)
        return Response.json({ comments: issue.comments.slice(startAt, startAt + 100), total: issue.comments.length, startAt })
      }
      this.commentCount++; issue.comments.push({ body: body.body })
      if (this.loseComment) { this.loseComment = false; throw new Error('lost comment response') }
      return Response.json({ id: String(issue.comments.length) }, { status: 201 })
    }
    throw new Error(`Unexpected mocked route ${path}`)
  })
  add(summary = 'Example', labels: string[] = []): Issue {
    const issue: Issue = { key: `DEMO-${this.issues.length + 1}`, fields: { summary, labels, project: { key: 'DEMO' }, status: { id: '1', name: 'Open' },
      priority: { name: 'Medium' }, assignee: { displayName: 'Alice' }, updated: '2026-11-01T00:00:00Z' }, comments: [] }
    this.issues.push(issue); return issue
  }
}
let directory: string, store: Store, effects: Effects, jira: Jira, board: HealthBoard, mock: MockJira, clock: number
let host: Host | undefined
let paused: boolean
const trigger = (id = 'request'): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_request' }],
  actor: { source: 'feishu', id: 'alice' }, human: true, addressed: 'mention', at: '2026-11-01T00:00:00Z', text: 'Please fix the API',
  url: 'https://feishu.invalid/request', meta: { chatId: 'oc_team' } })
const ticket = (id = 't1', origin = 'request'): Ticket => ({ id, title: 'Fix the API', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'feishu', id: 'alice' }, scope: 'API' },
  origin: { triggerId: origin, triggerIds: [origin] }, channels: [], assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-11-01T00:00:00Z' }],
  inputs: [], undelivered: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  execution: { name: id, directory: '/work/t1', assignment: 'API', access: 'read-only', services: [{ name: 'api', path: '/project/api' }],
    worktree: { branch: 'superagent/t1', path: '/trees/t1', repository: '/project' } } })
function install() {
  board = new HealthBoard(); effects = new Effects(store, board, () => clock)
  jira = new Jira({ store, effects, lifetime: new AbortController().signal, panelUrl: () => 'http://127.0.0.1:3082/',
    sourceLink: async () => 'https://feishu.invalid/request', paused: () => paused })
}
function accept(id = 't1', source = trigger()) { store.triggers.save(source); store.tickets.save(ticket(id, source.id)) }
function report(state: 'ready' | 'failed' | 'progress', summary = 'Result: https://gitlab.invalid/acme/api/-/merge_requests/8') {
  const current = store.tickets.get('t1')!
  current.assignments[0]!.state = 'running'
  current.assignments[0]!.report = { state, summary, at: '2026-11-02T00:00:00Z' }
  if (state === 'ready') current.ended = { at: '2026-11-02T00:00:00Z', by: 'executor', outcome: 'completed' }
  store.tickets.save(current)
}
async function retry() { clock += 300_001; await effects.idle('jira') }
beforeEach(() => {
  mkdirSync('.artifacts', { recursive: true }); directory = mkdtempSync('.artifacts/jira-test-')
  store = new Store(join(directory, 'state.sqlite')); clock = Date.now(); paused = false
  store.saveSettings(SettingsSchema.parse({ jira: CONFIG, sources: { feishu: { config: { chats: [{ chatId: 'oc_team' }] } } } }))
  mock = new MockJira(); vi.stubGlobal('fetch', mock.fetch); vi.stubEnv('JIRA_TEST_TOKEN', TOKEN)
  install()
})
afterEach(async () => {
  await host?.stop(); host = undefined
  await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

it('validates strict reference-only settings and never persists a credential in SQLite or settings history', async () => {
  expect(SettingsSchema.parse({}).jira).toMatchObject({ enabled: false, secret: { kind: 'file', path: '~/.config/dsh-superagent-jira/token' } })
  for (const invalid of [{ ...CONFIG, token: TOKEN }, { ...CONFIG, secret: TOKEN }, { ...CONFIG, secret: { kind: 'env', name: 'BAD NAME', value: TOKEN } },
    { ...CONFIG, baseUrl: `https://user:${TOKEN}@jira.invalid` }, { ...CONFIG, mappings: [{ chatId: 'oc_team', projectKey: 'bad key' }] },
    { ...CONFIG, transitions: { unknown: 'Start' } }, { ...CONFIG, auth: 'basic', username: '' }]) {
    expect(() => store.saveSettings({ ...store.settings(), jira: invalid })).toThrow()
  }
  accept(); effects.start(); await effects.idle()
  expect(mock.calls.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
  const saved = JSON.stringify(store.db.prepare('SELECT * FROM kv').all()) + JSON.stringify(store.tickets.list()) + JSON.stringify(store.db.prepare('SELECT * FROM effect').all())
  expect(saved).not.toContain(TOKEN)
  expect(readFileSync(join(directory, 'state.sqlite')).includes(Buffer.from(TOKEN))).toBe(false)
  const config = JiraConfigSchema.parse({ ...CONFIG, auth: 'basic', username: 'jira-bot' })
  await (await JiraClient.connect(config, new AbortController().signal)).request('myself')
  expect(mock.calls.at(-1)!.authorization).toBe(`Basic ${Buffer.from(`jira-bot:${TOKEN}`).toString('base64')}`)
})

it('warns on a token file broader than 0600 and reports unreadable/invalid references without reading arbitrary data into errors', async () => {
  const path = join(process.cwd(), directory, 'token')
  writeFileSync(path, TOKEN, { mode: 0o644 })
  expect(await jiraSecret({ kind: 'file', path })).toEqual({ value: TOKEN, warning: expect.stringContaining('0600') })
  await expect(jiraSecret({ kind: 'file', path: join(path, 'missing') })).rejects.toThrow('credential file')
  vi.stubEnv('JIRA_TEST_TOKEN', `${TOKEN}\nother`)
  await expect(jiraSecret({ kind: 'env', name: 'JIRA_TEST_TOKEN' })).rejects.toThrow('empty or invalid')
})

it('creates once, preserving fields and links, and recovers a lost response across restart and delayed Jira indexing', async () => {
  mock.loseCreate = true; accept(); effects.start(); await effects.idle()
  expect(mock.createCount).toBe(1)
  expect(store.tickets.get('t1')?.jira?.error).not.toContain(TOKEN)
  const created = mock.calls.find(call => call.path === 'issue')!.body.fields
  expect(created).toMatchObject({ summary: 'Fix the API', issuetype: { name: 'Task' }, components: [{ name: 'API' }], assignee: { name: 'alice' } })
  expect(created.description).toContain('Please fix the API')
  for (const text of ['https://feishu.invalid/request', 'superagentTicket=t1', 'oc_team', 'api', 'read-only']) expect(created.description).toContain(text)
  await effects.drain(); store.close(); store = new Store(join(directory, 'state.sqlite')); install(); effects.start()
  mock.hideCreated = true; await retry(); await retry()
  expect(mock.createCount).toBe(1)
  expect(store.tickets.get('t1')?.jira?.error).toContain('outcome is unknown')
  mock.hideCreated = false; await retry()
  expect(store.tickets.get('t1')?.jira).toEqual({ key: 'DEMO-1', url: 'https://jira.invalid/context/browse/DEMO-1', pending: false })
  expect(mock.createCount).toBe(1)
})

it('keeps creation, journals and effects atomic on rollback and never backfills disabled, unmapped, direct or GitHub tickets', async () => {
  expect(() => store.atomic(() => { accept(); throw new Error('rollback') })).toThrow('rollback')
  expect(store.get(KV.jira.ticket('t1'))).toBeUndefined(); expect(effects.pending('jira')).toBe(false)
  const settings = store.settings(); store.saveSettings({ ...settings, jira: { ...settings.jira, enabled: false } })
  accept('old'); store.saveSettings(settings)
  for (const source of [{ ...trigger('other'), meta: { chatId: 'oc_other' } }, { ...trigger('direct'), meta: { chatId: 'oc_team', direct: true } },
    { ...trigger('gh'), source: 'github' }]) accept(source.id, source)
  const old = store.tickets.get('old')!; old.assignments[0]!.state = 'running'; store.tickets.save(old)
  effects.start(); await effects.idle()
  expect(mock.fetch).not.toHaveBeenCalled()
  expect(jira.canSync(store.tickets.get('gh')!)).toBe(false)
  expect(jira.canSync(store.tickets.get('direct')!)).toBe(false)
  expect(jira.canSync(store.tickets.get('other')!)).toBe(false)
  expect(jira.canSync(store.tickets.get('old')!)).toBe(true)
  jira.sync('old'); await effects.idle()
  expect(mock.createCount).toBe(1)
  expect(store.tickets.get('old')?.jira?.key).toBe('DEMO-1')
})

it('applies transition names and ids in order, resumes unknown transition outcomes, and comments with results, branches, worktrees and PR links', async () => {
  accept(); effects.start(); await effects.idle()
  mock.loseTransition = true
  report('progress'); await effects.idle()
  expect(mock.transitionCount).toBe(1)
  await retry(); expect(mock.transitionCount).toBe(1)
  expect(store.tickets.get('t1')?.jira?.error).toBeUndefined()
  report('failed'); report('ready')
  await effects.idle()
  expect(mock.calls.filter(call => call.path.endsWith('/transitions') && call.method === 'POST').map(call => call.body.transition.id)).toEqual(['21', '41', '31'])
  expect(mock.commentCount).toBe(2)
  const comment = mock.issues[0]!.comments.at(-1)!.body
  for (const part of ['completed', 'superagent/t1', '/trees/t1', 'merge_requests/8']) expect(comment).toContain(part)
  expect(store.tickets.get('t1')?.ended?.outcome).toBe('completed')
})

it('finds a previously committed completion comment on a later page after an ambiguous response without posting a duplicate', async () => {
  accept(); effects.start(); await effects.idle()
  mock.issues[0]!.comments = Array.from({ length: 105 }, () => ({ body: 'Older discussion' }))
  mock.loseComment = true; report('ready'); await effects.idle()
  expect(mock.commentCount).toBe(1)
  await effects.drain(); store.close(); store = new Store(join(directory, 'state.sqlite')); install(); effects.start(); await retry()
  expect(mock.commentCount).toBe(1); expect(effects.pending('jira')).toBe(false)
  expect(mock.calls.some(call => call.path.endsWith('/comment') && call.method === 'GET')).toBe(true)
})

it('defers Jira during pause and retries outages with ticket and health errors while independent effects continue', async () => {
  mock.offline = true; accept(); effects.start()
  const independent = vi.fn(async () => {})
  effects.handle('relay', independent); effects.enqueue('relay', 'unrelated', { text: 'continue' })
  await effects.idle(); await retry(); await retry()
  expect(board.all.jira).toMatchObject({ state: 'error' })
  expect(independent).toHaveBeenCalledOnce()
  expect(store.tickets.get('t1')?.jira?.error).toContain('503')
  expect(store.tickets.get('t1')?.ended).toBeUndefined()
  mock.offline = false; await retry()
  expect(board.all.jira).toMatchObject({ state: 'ready' }); expect(mock.createCount).toBe(1)
  paused = true; report('failed'); const pausedCalls = mock.calls.length; await retry(); expect(mock.calls.length).toBe(pausedCalls)
  paused = false; await retry()
  const settings = store.settings(); store.saveSettings({ ...settings, jira: { ...settings.jira, enabled: false } })
  report('ready'); const count = mock.calls.length; await retry(); expect(mock.calls.length).toBe(count)
  expect(effects.pending('jira')).toBe(true)
  store.saveSettings(settings); await retry(); expect(effects.pending('jira')).toBe(false)
})

it('lists issue types and current issue transitions without mutating Jira, scopes search and paginates using the actual Jira page size', async () => {
  accept(); effects.start(); await effects.idle(); mock.add('Second'); mock.add('Third'); mock.cap = 1
  const writes = mock.calls.filter(call => call.method === 'POST' && call.path !== 'search').length
  expect(await jira.test('DEMO')).toMatchObject({ user: 'Jira Bot', issueTypes: [{ id: '3', name: 'Task' }, { id: '1', name: 'Bug' }],
    sampleIssue: 'DEMO-1', transitions: [{ id: '21', name: 'Start', to: 'In Progress' }, { id: '31' }, { id: '41' }] })
  const first = await jira.search({ filter: 'assigned', text: 'API "fix"', jql: 'priority = High OR status = Open ORDER BY updated DESC', maxResults: 25 })
  expect(first).toMatchObject({ total: 3, next: 1, issues: [{ key: 'DEMO-1', ticketId: 't1', assignee: 'Alice' }] })
  const query = mock.calls.at(-1)!.body.jql
  expect(query).toContain('project in ("DEMO")'); expect(query).toContain('assignee = currentUser()')
  expect(query).toContain('(priority = High OR status = Open)')
  const count = mock.calls.length; await jira.search({ filter: 'assigned', text: 'API "fix"', jql: 'priority = High OR status = Open ORDER BY updated DESC', maxResults: 25 })
  expect(mock.calls.length).toBe(count)
  await jira.search({ filter: 'assigned', text: 'API "fix"', jql: 'priority = High OR status = Open ORDER BY updated DESC', refresh: '1' })
  expect(mock.calls.length).toBe(count + 1)
  expect(await jira.search({ startAt: first.next! })).toMatchObject({ startAt: 1, next: 2, issues: [{ key: 'DEMO-2' }] })
  const beforeInvalid = mock.calls.length
  for (const jql of ['status=Open)) OR project=OTHER OR ((status=Open', 'status = "unterminated', 'ORDER BY updated DESC) OR project=OTHER']) {
    await expect(jira.search({ jql })).rejects.toThrow('JQL')
  }
  expect(mock.calls.length).toBe(beforeInvalid)
  await expect(jira.search({ project: 'OTHER' })).rejects.toThrow('mapped')
  await expect(jira.search({ maxResults: 101 })).rejects.toThrow()
  expect(mock.calls.filter(call => call.method === 'POST' && call.path !== 'search').length).toBe(writes)
})

it('keeps actual Runtime ticket acceptance, worker completion and Feishu delivery running during a Jira outage, with proxy routes', async () => {
  host = await startRuntime(store => { store.saveSettings({ ...store.settings(), jira: CONFIG }) })
  mock.offline = true
  const { runtime } = host
  const accepted = await host.acceptedTicket({ ...feishu('1', 'Please fix this'), url: 'https://feishu.invalid/request' })
  runtime.engine.report(accepted.ticket.id, { state: 'ready', summary: 'Fixed and verified' })
  await runtime.idle()
  expect(runtime.store.tickets.get(accepted.ticket.id)?.ended?.outcome).toBe('completed')
  expect(runtime.health.runtime?.state).toBe('ready')
  expect(runtime.store.tickets.get(accepted.ticket.id)?.jira?.error).toContain('503')
  const bad = await host.api('PUT', 'settings/jira', { value: { ...CONFIG, token: TOKEN }, revision: runtime.store.blockRevision('jira') })
  expect(bad.status).toBe(400)
  mock.offline = false
  await host.api('POST', `tickets/${accepted.ticket.id}/jira`, {})
  await runtime.idle()
  expect(runtime.store.tickets.get(accepted.ticket.id)?.jira?.key).toBe('DEMO-1')
  const search = await host.api('GET', 'jira/search?startAt=0&maxResults=1&filter=reported')
  expect(search).toMatchObject({ status: 200, body: { total: 1, issues: [{ key: 'DEMO-1', ticketId: accepted.ticket.id }] } })
  expect(await host.api('POST', 'jira/test', { project: 'DEMO' })).toMatchObject({ status: 200, body: { user: 'Jira Bot' } })
  runtime.outbox.send({ id: 'jira-link', ticketId: accepted.ticket.id, channel: accepted.trigger.channel!, text: 'Fixed '.repeat(100).trim(), kind: 'notice' })
  await runtime.sendReplies()
  expect(runtime.outbox.status('jira-link')).toBe('sent')
  const serialized = JSON.stringify(vi.mocked((await import('../src/infra/commands.ts')).Commands.prototype.lark).mock.calls)
  expect(serialized).toContain('https://jira.invalid/context/browse/DEMO-1')
  expect(JSON.stringify(await host.api('GET', 'settings'))).not.toContain(TOKEN)
})

it('provides locale strings for every configurable Jira state in both languages', async () => {
  const { en, zh } = await import('../src/client/locales.ts')
  for (const state of JIRA_STATES) {
    expect(zh[`jira.state.${state}`]).toBeTruthy(); expect(en[`jira.state.${state}`]).toBeTruthy()
  }
})


it('limits Jira concurrency to two and keeps states appended while creation is in flight, preserving adapter metadata on later ticket saves', async () => {
  const hold = deferred<void>(), handler = mock.fetch.getMockImplementation()!
  let active = 0, peak = 0
  mock.fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/issue') && init?.method === 'POST') {
      active++; peak = Math.max(peak, active)
      await hold.promise
      try { return await handler(url, init) } finally { active-- }
    }
    return handler(url, init)
  })
  accept(); accept('t2'); accept('t3'); effects.start()
  await vi.waitFor(() => expect(active).toBe(2))
  expect(() => jira.sync('t1', { retryUncertain: true })).toThrow('already running')
  report('failed'); report('ready')
  hold.resolve(); await effects.idle()
  expect(peak).toBe(2); expect(mock.createCount).toBe(3)
  expect(mock.commentCount).toBe(2)
  expect(effects.pending('jira')).toBe(false)
  const current = store.tickets.get('t1')!, linked = current.jira
  store.tickets.save({ ...current, jira: undefined, execution: { ...current.execution!, name: 'after-await' } })
  expect(store.tickets.get('t1')!.jira).toEqual(linked)
  expect(store.tickets.get('t1')!.ended?.outcome).toBe('completed')
})

it('retries definite create rejection, refuses a changed server, and requires explicit recovery before resending uncertain creation', async () => {
  mock.rejectCreate = true; accept(); effects.start(); await effects.idle()
  expect(mock.createCount).toBe(1)
  mock.rejectCreate = false; await retry()
  expect(mock.createCount).toBe(2); expect(store.tickets.get('t1')!.jira?.key).toBe('DEMO-1')
  const settings = store.settings()
  store.saveSettings({ ...settings, jira: { ...settings.jira, baseUrl: 'https://other.invalid' } })
  report('ready'); const count = mock.calls.length; await retry()
  expect(mock.calls.length).toBe(count)
  expect(store.tickets.get('t1')!.jira?.error).toContain('base URL changed')
  store.saveSettings(settings); await retry()
  accept('uncertain')
  // Simulate an intent committed just before a crash, with no issue sent yet.
  const journal = store.get(KV.jira.ticket('uncertain'))!
  journal.creating = true; store.set(KV.jira.ticket('uncertain'), journal)
  await retry(); expect(mock.createCount).toBe(2)
  jira.sync('uncertain', { retryUncertain: true }); await effects.idle()
  expect(mock.createCount).toBe(3)
  expect(store.tickets.get('uncertain')!.jira?.key).toBe('DEMO-2')
})
