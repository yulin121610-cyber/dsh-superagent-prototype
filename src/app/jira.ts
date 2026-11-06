/** One-way Jira synchronization, durable per-ticket journals, and a scoped server-side search proxy. */
import { z } from 'zod'
import { key, latestReport, ticketStage, worktreesOf, type Ticket, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { JiraConfig, JiraMapping, JiraState } from '../jira/config.ts'
import { JiraClient, JiraHttpError, jiraUrl, jqlString, type JiraIssue, type JiraSearch } from '../jira/client.ts'
import { Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

interface Operation {
  id: string; state: JiraState; comment?: string; transitionTarget?: string; transitionDone?: boolean; commentSent?: boolean
}
/** Jira owns this journal; it contains only references and work data, never authentication headers or credentials. */
export interface JiraJournal {
  baseUrl: string; mapping: JiraMapping; marker: string; description: string; summary: string
  creating?: boolean; lastState: JiraState; sequence: number; pending: Operation[]
}
export const JiraSearchQuery = z.object({
  project: z.string().max(100).default(''), filter: z.enum(['all', 'assigned', 'reported', 'open', 'done']).default('open'),
  text: z.string().trim().max(500).default(''), jql: z.string().trim().max(4000).default(''),
  startAt: z.coerce.number().int().nonnegative().default(0), maxResults: z.coerce.number().int().min(1).max(100).default(25),
  refresh: z.enum(['0', '1']).default('0'),
}).strict()
export type JiraQuery = z.input<typeof JiraSearchQuery>
export interface JiraPage {
  issues: { key: string; url: string; summary: string; status: string; priority: string; assignee: string; updated: string; ticketId?: string }[]
  startAt: number; total: number; next: number | null
}
const base = (url: string) => url.replace(/\/+$/, '')
const unknownCreate = 'Jira create outcome is unknown. Waiting for the issue marker to appear in search; link the existing key, or confirm absence in Jira before retrying creation.'
const unknownComment = 'Jira comment outcome is unknown. Waiting for its marker to appear; confirm absence before retrying this operation.'
const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)
export const JiraSyncRequest = z.object({ issueKey: issueKey.optional(), retryUncertain: z.boolean().default(false) }).strict()

/** Keep raw JQL inside the project scope: unmatched parentheses must never escape the wrapping AND clause. */
function splitJql(input: string): { clause: string; order: string } {
  let depth = 0, quote = '', escaped = false, orderAt = -1
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth++
    if (char === ')' && --depth < 0) throw new Error('JQL has unbalanced parentheses')
    if (depth === 0 && (index === 0 || /\s/.test(input[index - 1]!)) && /^ORDER\s+BY\b/i.test(input.slice(index))) {
      orderAt = index; break
    }
  }
  if (depth || quote || escaped) throw new Error('JQL has unbalanced parentheses or quotes')
  const clause = (orderAt < 0 ? input : input.slice(0, orderAt)).trim()
  const order = orderAt < 0 ? 'ORDER BY updated DESC' : input.slice(orderAt)
  if (!/^ORDER\s+BY\s+(?:[\w.]+|"[^"\\]+"|cf\[\d+\])(?:\s+(?:ASC|DESC))?(?:\s*,\s*(?:[\w.]+|"[^"\\]+"|cf\[\d+\])(?:\s+(?:ASC|DESC))?)*\s*$/i.test(order)) throw new Error('JQL ORDER BY is invalid')
  return { clause, order }
}

/** State independent of Jira; changing Jira never affects the Ticket lifecycle or its authorization. */
export function jiraState(ticket: Ticket): JiraState {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') {
    if (stage.action === 'review') return 'ready'
    if (stage.action === 'failed' || stage.action === 'blocked') return stage.action
    return stage.action === 'delivery' ? 'blocked' : 'waiting'
  }
  return stage.stage === 'working' ? stage.action === 'queued' ? 'accepted' : 'working' : 'waiting'
}
interface JiraHost {
  store: Store; effects: Effects; lifetime: AbortSignal
  panelUrl(): string
  sourceLink(trigger: Trigger): Promise<string>
  paused(): boolean
}

/** Owns Jira enrollment and synchronization; Store calls changed inside the same transaction as each ticket save. */
export class Jira {
  private readonly cache = new Map<string, { until: number; value: JiraSearch }>()
  private readonly active = new Set<string>()
  private warning = ''
  constructor(private readonly host: JiraHost) {
    host.store.ticketSaved = (ticket, previous) => this.changed(ticket, previous)
    host.effects.handle('jira', (_payload, id) => this.run(id), {
      limit: () => host.store.settings().jira.enabled && !host.paused() ? 2 : 0, retry: [5000, 300_000],
    })
  }
  status() {
    const config = this.host.store.settings().jira
    return { enabled: config.enabled, projects: [...new Set(config.mappings.map(row => row.projectKey))], warning: this.warning }
  }
  canSync(ticket: Ticket): boolean {
    return this.host.store.settings().jira.enabled && (!!ticket.jira || !!this.mapping(ticket))
  }
  private mapping(ticket: Ticket): JiraMapping | undefined {
    const { store } = this.host, settings = store.settings()
    const trigger = store.triggers.get(ticket.origin.triggerId)
    if (!settings.jira.enabled || trigger?.source !== 'feishu' || trigger.meta.direct === true) return undefined
    const chats = settings.sources.feishu?.config.chats
    if (!Array.isArray(chats) || !chats.some(chat => (chat as { chatId?: string }).chatId === trigger.meta.chatId)) return undefined
    return settings.jira.mappings.find(row => row.chatId === trigger.meta.chatId)
  }
  private enroll(ticket: Ticket): JiraJournal | undefined {
    const mapping = this.mapping(ticket)
    if (!mapping) return undefined
    const { store } = this.host, config = store.settings().jira
    const chat = (store.settings().sources.feishu?.config.chats as { chatId: string; name?: string }[]).find(chat => chat.chatId === mapping.chatId)
    const panel = config.panelUrl || this.host.panelUrl()
    const marker = `dsh-sa-${key(store.get(KV.runtime.masterId) ?? this.host.panelUrl(), ticket.id)}`
    const description = [
      `Superagent ticket: ${ticket.id}`, `Panel: ${panel}${panel.includes('?') ? '&' : '?'}superagentTicket=${encodeURIComponent(ticket.id)}`,
      `Group: ${chat?.name || mapping.chatId} (${mapping.chatId})`,
      `Services touched: ${ticket.execution?.services?.map(service => service.name).join(', ') || '*'}`,
      `Access: ${ticket.execution?.access ?? 'write'}`, `Marker: ${marker}`, '', 'Original Feishu request:',
      ...ticket.origin.triggerIds.map(id => store.triggers.get(id)?.text ?? '').filter(Boolean),
    ].join('\n')
    const journal: JiraJournal = { baseUrl: base(config.baseUrl), mapping, marker, summary: ticket.title,
      description, lastState: jiraState(ticket), sequence: 0, pending: [] }
    this.append(ticket, journal)
    store.set(KV.jira.ticket(ticket.id), journal)
    store.setTicketJira(ticket.id, { pending: true })
    this.host.effects.enqueue('jira', ticket.id, {})
    // The original is resolved by the durable effect, not in the ticket transaction.
    return journal
  }
  private append(ticket: Ticket, journal: JiraJournal): void {
    const state = jiraState(ticket), report = latestReport(ticket)
    const comment = (['failed', 'completed', 'merged', 'closed', 'dropped', 'stopped'].includes(state) || (state === 'ready' && !!ticket.follows?.length))
      ? [`Superagent ${state}: ${ticket.title}`, report?.summary ?? ticket.ended?.reason ?? '',
        ...worktreesOf(ticket.execution).map(tree => `${tree.service ? `${tree.service}: ` : ''}${tree.branch} — ${tree.path}`),
        `Directory: ${ticket.execution?.directory ?? ''}`,
        ...ticket.follows?.flatMap(follow => {
          const thread = this.host.store.threads.get(follow.thread)
          return typeof thread?.meta.url === 'string' ? [thread.meta.url] : []
        }) ?? [],
      ].filter(Boolean).join('\n') : undefined
    journal.pending.push({ id: `${journal.marker}-${++journal.sequence}`, state, ...comment ? { comment } : {} })
    journal.lastState = state
  }
  private changed(ticket: Ticket, previous?: Ticket): void {
    const { store, effects } = this.host
    // No startup scan and no implicit backfill, even if an old ticket later resumes or fails.
    if (!previous) { this.enroll(ticket); return }
    const journal = store.get(KV.jira.ticket(ticket.id))
    if (!journal || jiraState(ticket) === journal.lastState) return
    this.append(ticket, journal)
    store.set(KV.jira.ticket(ticket.id), journal)
    store.setTicketJira(ticket.id, { ...ticket.jira, pending: true })
    effects.enqueue('jira', ticket.id, {})
  }
  /** Explicit enrollment/retry only; uncertain writes require either an existing key or a human confirmation of absence. */
  sync(id: string, input: z.input<typeof JiraSyncRequest> = {}): { queued: true } {
    const request = JiraSyncRequest.parse(input), { store, effects } = this.host
    if (this.active.has(id)) throw new Error('Jira sync is already running for this ticket; retry after it finishes')
    store.atomic(() => {
      const ticket = store.tickets.get(id)
      if (!ticket) throw new Error('Ticket not found')
      let journal = store.get(KV.jira.ticket(id))
      if (!journal) journal = this.enroll(ticket)
      if (!journal) throw new Error('Enable Jira and map this ticket’s Feishu group first')
      if (base(store.settings().jira.baseUrl) !== journal.baseUrl) throw new Error('Restore the enrolled Jira base URL before syncing this ticket')
      if (request.issueKey) {
        if (!request.issueKey.startsWith(`${journal.mapping.projectKey}-`)) throw new Error('Issue key must belong to the enrolled project')
        if (ticket.jira?.key && ticket.jira.key !== request.issueKey) throw new Error('Ticket already has a different Jira issue')
        store.setTicketJira(id, { key: request.issueKey, url: jiraUrl(journal.baseUrl, request.issueKey), pending: true })
      }
      if (request.retryUncertain) {
        journal.creating = false
        for (const op of journal.pending) op.commentSent = false
      }
      store.set(KV.jira.ticket(id), journal)
      effects.enqueue('jira', id, {})
    })
    return { queued: true }
  }
  private async client(config = this.host.store.settings().jira) {
    const client = await JiraClient.connect(config, this.host.lifetime)
    this.warning = client.warning
    return client
  }
  private update(id: string, change: (journal: JiraJournal) => void): JiraJournal {
    const { store } = this.host
    return store.atomic(() => {
      const journal = store.get(KV.jira.ticket(id))!
      change(journal); store.set(KV.jira.ticket(id), journal)
      return journal
    })
  }
  private async run(id: string): Promise<void> {
    const { store } = this.host
    const journal = store.get(KV.jira.ticket(id)), config = store.settings().jira
    if (!journal) return
    if (!config.enabled || this.host.paused()) throw new Later('Jira synchronization is paused')
    this.active.add(id)
    try {
      if (base(config.baseUrl) !== journal.baseUrl) throw new Error('Jira base URL changed; restore it before syncing enrolled tickets')
      const client = await this.client(config)
      let issue = store.tickets.get(id)?.jira?.key
      if (!issue) {
        const found = await client.search(`project = ${jqlString(journal.mapping.projectKey)} AND labels = ${jqlString(journal.marker)}`, 0, 2)
        if (found.issues.length > 1) throw new Error('Multiple Jira issues have this ticket marker; resolve duplicates and link the correct key')
        issue = found.issues[0]?.key
        if (!issue) {
          if (journal.creating) throw new Error(unknownCreate)
          const trigger = store.triggers.get(store.tickets.get(id)!.origin.triggerId)
          const original = trigger && (trigger.url || await this.host.sourceLink(trigger))
          this.update(id, value => { value.creating = true })
          let created: { key: string }
          try {
            const { mapping } = journal
            created = await client.request('issue', { fields: {
              project: { key: mapping.projectKey }, issuetype: { name: mapping.issueType }, summary: journal.summary,
              description: `${journal.description}${original ? `\nOriginal message: ${original}` : ''}`,
              labels: [...new Set([...mapping.labels, journal.marker])],
              ...mapping.components.length ? { components: mapping.components.map(name => ({ name })) } : {},
              ...mapping.assignee ? { assignee: { name: mapping.assignee } } : {},
            } })
          } catch (error) {
            if (error instanceof JiraHttpError && error.rejected) this.update(id, value => { value.creating = false })
            throw error
          }
          issue = issueKey.parse(created.key)
        }
        issueKey.parse(issue)
        store.setTicketJira(id, { key: issue, url: jiraUrl(journal.baseUrl, issue), pending: true })
        this.cache.clear()
      }
      // Read each operation anew: the ticket may change while any HTTP call is awaiting Jira.
      for (;;) {
        const op = store.get(KV.jira.ticket(id))!.pending[0]
        if (!op) break
        await this.transition(client, id, issue, op, config)
        if (op.comment) await this.comment(client, id, issue, op)
        this.update(id, value => { value.pending = value.pending.filter(item => item.id !== op.id) })
      }
      const { error: _error, ...linked } = store.tickets.get(id)?.jira ?? {}
      store.setTicketJira(id, { ...linked, pending: false })
      this.cache.clear()
    } catch (error) {
      // Errors from our transport contain neither response bodies nor credentials.
      const message = error instanceof z.ZodError ? 'Jira returned an invalid issue key' : error instanceof Error ? error.message : 'Jira synchronization failed'
      store.setTicketJira(id, { ...store.tickets.get(id)?.jira, error: message, pending: true })
      throw new Error(message)
    } finally { this.active.delete(id) }
  }
  private async transition(client: JiraClient, id: string, issue: string, op: Operation, config: JiraConfig): Promise<void> {
    const target = config.transitions[op.state]
    if (!target || op.transitionDone) return
    const current = await client.request<JiraIssue>(`issue/${encodeURIComponent(issue)}?fields=status`)
    if (op.transitionTarget && current.fields.status.id === op.transitionTarget) {
      this.update(id, value => { value.pending.find(item => item.id === op.id)!.transitionDone = true }); return
    }
    const available = (await client.transitions(issue)).transitions
    const transition = available.find(item => item.id === target) ?? available.find(item => item.name.toLowerCase() === target.toLowerCase())
    if (!transition) throw new Error(`Jira transition for ${op.state} is unavailable; configure its current transition name or id`)
    this.update(id, value => { value.pending.find(item => item.id === op.id)!.transitionTarget = transition.to.id })
    if (current.fields.status.id !== transition.to.id) await client.request(`issue/${encodeURIComponent(issue)}/transitions`, { transition: { id: transition.id } })
    this.update(id, value => { value.pending.find(item => item.id === op.id)!.transitionDone = true })
  }
  private async comment(client: JiraClient, id: string, issue: string, op: Operation): Promise<void> {
    const marker = `[${op.id}]`
    // Jira comments are paged separately; searching only the issue's default comment window could duplicate an older result.
    for (let start = 0;;) {
      const page = await client.request<{ comments: { body: string }[]; total: number; startAt: number }>(`issue/${encodeURIComponent(issue)}/comment?startAt=${start}&maxResults=100`)
      if (page.comments.some(comment => comment.body.includes(marker))) return
      start += page.comments.length
      if (start >= page.total) break
      if (!page.comments.length) throw new Error('Jira comment pagination made no progress')
    }
    if (op.commentSent) throw new Error(unknownComment)
    this.update(id, value => { value.pending.find(item => item.id === op.id)!.commentSent = true })
    try { await client.request(`issue/${encodeURIComponent(issue)}/comment`, { body: `${op.comment}\n\n${marker}` }) }
    catch (error) {
      if (error instanceof JiraHttpError && error.rejected) this.update(id, value => { value.pending.find(item => item.id === op.id)!.commentSent = false })
      throw error
    }
  }
  async test(project: string, sampleIssue = '') {
    const client = await this.client()
    if (!this.status().projects.includes(project)) throw new Error('Select a mapped Jira project')
    const user = await client.request<{ name: string; displayName: string }>('myself')
    const detail = await client.request<{ issueTypes: { id: string; name: string }[] }>(`project/${encodeURIComponent(project)}`)
    let sample = sampleIssue
    if (sample && (!issueKey.safeParse(sample).success || !sample.startsWith(`${project}-`))) throw new Error('Sample issue must belong to the selected project')
    if (!sample) sample = (await client.search(`project = ${jqlString(project)} ORDER BY updated DESC`, 0, 1)).issues[0]?.key ?? ''
    const transitions = sample ? (await client.transitions(sample)).transitions.map(({ id, name, to }) => ({ id, name, to: to.name })) : []
    return { user: user.displayName || user.name, issueTypes: detail.issueTypes.map(({ id, name }) => ({ id, name })),
      sampleIssue: sample, transitions, warning: client.warning }
  }
  async search(input: JiraQuery): Promise<JiraPage> {
    const query = JiraSearchQuery.parse(input), { store } = this.host
    const config = store.settings().jira, projects = this.status().projects
    if (!config.enabled) throw new Error('Jira is disabled; configure Settings → Jira')
    if (query.project && !projects.includes(query.project)) throw new Error('Select a mapped Jira project')
    if (!projects.length) return { issues: [], startAt: query.startAt, total: 0, next: null }
    const clauses = [`project in (${(query.project ? [query.project] : projects).map(jqlString).join(', ')})`]
    const filter = { all: '', assigned: 'assignee = currentUser()', reported: 'reporter = currentUser()', open: 'statusCategory != Done', done: 'statusCategory = Done' }[query.filter]
    if (filter) clauses.push(filter)
    if (query.text) clauses.push(`text ~ ${jqlString(query.text.replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g, '\\$&'))}`)
    const { clause: raw, order } = splitJql(query.jql)
    if (raw) clauses.push(`(${raw})`)
    const jql = `${clauses.map(clause => `(${clause})`).join(' AND ')} ${order}`
    const cacheKey = JSON.stringify([store.blockRevision('jira'), jql, query.startAt, query.maxResults])
    const cached = this.cache.get(cacheKey)
    const result = query.refresh !== '1' && cached && cached.until > Date.now() ? cached.value
      : await (await this.client(config)).search(jql, query.startAt, query.maxResults)
    if (result !== cached?.value) this.cache.set(cacheKey, { until: Date.now() + 15_000, value: result })
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!)
    const linked = new Map(store.tickets.list().filter(ticket => ticket.jira?.key && ticket.jira.url === jiraUrl(config.baseUrl, ticket.jira.key))
      .map(ticket => [ticket.jira!.key!, ticket.id]))
    return { issues: result.issues.map(issue => ({ key: issueKey.parse(issue.key), url: jiraUrl(config.baseUrl, issue.key), summary: issue.fields.summary,
      status: issue.fields.status.name, priority: issue.fields.priority?.name ?? '', assignee: issue.fields.assignee?.displayName ?? '',
      updated: issue.fields.updated ?? '', ...linked.has(issue.key) ? { ticketId: linked.get(issue.key)! } : {} })),
      startAt: result.startAt, total: result.total,
      next: result.issues.length && result.startAt + result.issues.length < result.total ? result.startAt + result.issues.length : null }
  }
}
