/** Jira settings, issue browser, and explicit per-ticket sync actions, using only the same-origin backend. */
import { useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { JiraState } from '../jira/config.ts'
import type { Ticket } from '../core/model.ts'
import { usePoll } from './api.ts'
import { Button, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { ConfigHistory, Field, Fields, SwitchRow, useBlockDraft, useSettings } from './settings-kit.tsx'
import { ActionLink, ConfirmButton, ExternalLink, Hint, LoadState, Section, StatusHead, When } from './widgets.tsx'

const STATES: readonly JiraState[] = ['accepted', 'working', 'waiting', 'blocked', 'failed', 'ready', 'completed', 'merged', 'closed', 'dropped', 'stopped']
const words = (text: string) => text.split(',').map(value => value.trim()).filter(Boolean)
export function JiraSettings() {
  const { t, call } = usePanel()
  const { blocks, sources } = useSettings().settings
  const block = blocks.jira
  const saved = { ...block.value, mappings: block.value.mappings.map(row => ({ ...row, labels: row.labels.join(', '), components: row.components.join(', ') })) }
  const draft = useBlockDraft('jira', saved, block.revision, value => ({ ...value,
    mappings: value.mappings.map(row => ({ ...row, labels: words(row.labels), components: words(row.components) })) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const chats = (sources.find(source => source.id === 'feishu')?.value.config.chats ?? []) as { chatId: string; name?: string }[]
  const [project, setProject] = useState(''), [sample, setSample] = useState('')
  const [result, setResult] = useState<ApiResponse<'POST jira/test'>>()
  const test = useAction(async () => { setResult(await call('POST jira/test', { body: { project: project || block.value.mappings[0]?.projectKey || '', issue: sample } })) })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <Hint>{t('jira.secretHint')}</Hint>
        <SwitchRow label={t('jira.enabled')} checked={value.enabled} onChange={enabled => edit({ enabled })} />
        <Field label={t('jira.baseUrl')}><Input value={value.baseUrl} placeholder="https://jira.example.org" onChange={event => edit({ baseUrl: event.target.value })} /></Field>
        <Field label={t('jira.auth')}><select className="dt-select" value={value.auth} onChange={event => edit({ auth: event.target.value as 'bearer' | 'basic' })}>
          <option value="bearer">{t('jira.bearer')}</option><option value="basic">{t('jira.basic')}</option>
        </select></Field>
        {value.auth === 'basic' && <Field label={t('jira.username')}><Input value={value.username} onChange={event => edit({ username: event.target.value })} /></Field>}
        <Field label={t('jira.secretKind')}><select className="dt-select" value={value.secret.kind} onChange={event => edit({ secret: event.target.value === 'env'
          ? { kind: 'env', name: 'DSH_SUPERAGENT_JIRA_TOKEN' } : { kind: 'file', path: '~/.config/dsh-superagent-jira/token' } })}>
          <option value="file">{t('jira.file')}</option><option value="env">{t('jira.env')}</option>
        </select></Field>
        <Field label={t(value.secret.kind === 'env' ? 'jira.envName' : 'jira.filePath')}><Input spellCheck={false} value={value.secret.kind === 'env' ? value.secret.name : value.secret.path}
          onChange={event => edit({ secret: value.secret.kind === 'env' ? { kind: 'env', name: event.target.value } : { kind: 'file', path: event.target.value } })} /></Field>
        <Field label={t('jira.panelUrl')}><Input value={value.panelUrl} onChange={event => edit({ panelUrl: event.target.value })} /></Field>
        <Section title={t('jira.mappings')} hint={t('jira.mappingHint')} action={<Button onClick={() => edit({ mappings: [...value.mappings,
          { chatId: '', projectKey: '', issueType: 'Task', labels: '', components: '', assignee: '' }] })}>{t('addRow')}</Button>}>
          {value.mappings.map((row, index) => {
            const set = (next: Partial<typeof row>) => edit({ mappings: value.mappings.map((item, position) => position === index ? { ...row, ...next } : item) })
            return <div key={index} className="dt-form dt-block">
              <Field label={t('jira.group')}><select className="dt-select" required value={row.chatId} onChange={event => set({ chatId: event.target.value })}>
                <option value="">{t('jira.chooseGroup')}</option>
                {row.chatId && !chats.some(chat => chat.chatId === row.chatId) && <option value={row.chatId}>{row.chatId}</option>}
                {chats.map(chat => <option key={chat.chatId} value={chat.chatId}>{chat.name || chat.chatId}</option>)}
              </select></Field>
              {(['projectKey', 'issueType', 'labels', 'components', 'assignee'] as const).map(name => <Field key={name} label={t(`jira.${name}`)}>
                <Input required={name === 'projectKey' || name === 'issueType'} value={row[name]} onChange={event => set({ [name]: event.target.value })} />
              </Field>)}
              <Button onClick={() => edit({ mappings: value.mappings.filter((_, position) => position !== index) })}>{t('removeRow', { name: row.projectKey || row.chatId })}</Button>
            </div>
          })}
        </Section>
        <Section title={t('jira.transitions')} hint={t('jira.transitionHint')}>
          <div className="dt-grid3">{STATES.map(state => <Field key={state} label={t(`jira.state.${state}`)}>
            <Input value={value.transitions[state] ?? ''} onChange={event => {
              const next = { ...value.transitions }
              if (event.target.value) next[state] = event.target.value; else delete next[state]
              edit({ transitions: next })
            }} />
          </Field>)}</div>
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <Section title={t('jira.test')}>
      <Hint>{t('jira.testHint')}</Hint>
      <Field label={t('jira.project')}><select className="dt-select" value={project || block.value.mappings[0]?.projectKey || ''} onChange={event => { setProject(event.target.value); setResult(undefined) }}>
        {[...new Set(block.value.mappings.map(row => row.projectKey))].map(key => <option key={key} value={key}>{key}</option>)}
      </select></Field>
      <Field label={t('jira.sampleIssue')}><Input value={sample} onChange={event => setSample(event.target.value)} /></Field>
      <Button variant="outline" disabled={test.busy || draft.dirty || !block.value.enabled || !block.value.mappings.length} onClick={() => { void test.run() }}>{t('jira.test')}</Button>
      {result && <div role="status">
        <Hint>{t('jira.connected', { user: result.user })}</Hint>
        {result.warning && <p className="dt-error">{result.warning}</p>}
        <Hint>{t('jira.issueTypes', { items: result.issueTypes.map(type => `${type.name} (${type.id})`).join(', ') })}</Hint>
        <Hint>{result.sampleIssue ? t('jira.availableTransitions', { issue: result.sampleIssue, items: result.transitions.map(item => `${item.name} (${item.id}) → ${item.to}`).join(', ') || '—' }) : t('jira.noSample')}</Hint>
      </div>}
    </Section>
    <ConfigHistory blocks={['jira']} />
  </div>
}

export function JiraPage() {
  const { call } = usePanel()
  const status = usePoll(() => call('GET jira'), [])
  if (!status.data) return <LoadState error={status.error} loading />
  return <JiraBrowser key={JSON.stringify(status.data)} status={status.data} />
}
function JiraBrowser({ status }: { status: ApiResponse<'GET jira'> }) {
  const { t, call, navigate } = usePanel()
  const [project, setProject] = useState(''), [filter, setFilter] = useState<'all' | 'assigned' | 'reported' | 'open' | 'done'>('open')
  const [text, setText] = useState(''), [jql, setJql] = useState(''), [search, setSearch] = useState({ text: '', jql: '' })
  const [startAt, setStartAt] = useState(0), [board, setBoard] = useState(false)
  const fresh = useRef(false)
  const { data, error, reload } = usePoll<ApiResponse<'GET jira/search'>>(async () => {
    if (!status.enabled) return { issues: [], total: 0, startAt: 0, next: null }
    const refresh = fresh.current; fresh.current = false
    return call('GET jira/search', { query: { project, filter, ...search, startAt, maxResults: 25, refresh: refresh ? '1' : '0' } })
  }, [status.enabled, project, filter, search, startAt], 30_000)
  const refresh = useAction(async () => { fresh.current = true; await reload() })
  if (!status.enabled) return <>
    <Hint>{t('jira.disabled')}</Hint><Button variant="outline" onClick={() => navigate(settingsRoute('jira'))}>{t('jira.setup')}</Button>
  </>
  const issues = data?.issues ?? []
  const link = (issue: typeof issues[number]) => <>
    <ExternalLink href={issue.url}>{issue.key}</ExternalLink>
    {issue.ticketId && <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: issue.ticketId! })}>{t('openTicket')}</button>}
  </>
  return <>
    <StatusHead hint={t('jira.browseHint')} settings="jira" />
    {status.warning && <p className="dt-error">{status.warning}</p>}
    <div className="dt-actions">
      <select className="dt-select dt-inline-select" aria-label={t('jira.project')} value={project} onChange={event => { setStartAt(0); setProject(event.target.value) }}>
        <option value="">{t('jira.allProjects')}</option>{status.projects.map(key => <option key={key} value={key}>{key}</option>)}
      </select>
      <Button variant="outline" disabled={refresh.busy} onClick={() => { void refresh.run() }}>{t('jira.refresh')}</Button>
      <SwitchRow label={t('jira.board')} checked={board} onChange={setBoard} />
    </div>
    <div className="dt-filters">{(['all', 'assigned', 'reported', 'open', 'done'] as const).map(value => <Pill key={value} active={filter === value}
      onClick={() => { setStartAt(0); setFilter(value) }}>{t(`jira.filter.${value}`)}</Pill>)}</div>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); setStartAt(0); setSearch({ text, jql }) }}>
      <Field label={t('jira.text')}><Input type="search" value={text} onChange={event => setText(event.target.value)} /></Field>
      <Field label={t('jira.jql')}><Input value={jql} onChange={event => setJql(event.target.value)} /></Field>
      <Button variant="outline" type="submit">{t('searchLabel')}</Button>
    </form>
    <LoadState error={error} loading={!data} />
    {data && <>
      <Hint>{t('jira.total', { count: data.total })}</Hint>
      {board ? <div className="dt-jira-board">{[...new Set(issues.map(issue => issue.status))].map(state => <Section key={state} title={state}>
        <ul className="dt-plain-list">{issues.filter(issue => issue.status === state).map(issue => <li key={issue.key}>
          {link(issue)}<p>{issue.summary}</p><Hint>{issue.assignee} · {issue.priority}</Hint>
        </li>)}</ul>
      </Section>)}</div> : <div className="dt-jira-table"><table className="dt-table">
        <thead><tr>{(['key', 'summary', 'status', 'priority', 'assignee', 'updated'] as const).map(name => <th key={name}>{t(`jira.${name}`)}</th>)}</tr></thead>
        <tbody>{issues.map(issue => <tr key={issue.key}><td>{link(issue)}</td><td><ExternalLink href={issue.url}>{issue.summary}</ExternalLink></td>
          <td>{issue.status}</td><td>{issue.priority}</td><td>{issue.assignee}</td><td><When at={issue.updated} /></td></tr>)}</tbody>
      </table></div>}
      <div className="dt-actions">
        <Button variant="outline" disabled={startAt === 0} onClick={() => setStartAt(Math.max(0, startAt - 25))}>{t('jira.previous')}</Button>
        <Button variant="outline" disabled={data.next == null} onClick={() => setStartAt(data.next!)}>{t('jira.next')}</Button>
      </div>
    </>}
  </>
}

export function JiraTicketSync({ id, jira, available, reload }: { id: string; jira: Ticket['jira']; available: boolean; reload: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [existing, setExisting] = useState('')
  const sync = useAction(async (retryUncertain: boolean = false) => {
    await call('POST tickets/:id/jira', { id, body: { ...existing ? { issueKey: existing } : {}, retryUncertain } })
    notify(t('jira.queued')); await reload()
  })
  if (!available && !jira) return null
  return <Section title="Jira">
    {jira?.key && jira.url && <ActionLink href={jira.url}>{jira.key}</ActionLink>}
    {jira?.pending && <Hint>{t('jira.pending')}</Hint>}
    {jira?.error && <p role="alert" className="dt-error">{t('jira.syncError')}: {jira.error}</p>}
    {available && <>
      <Button variant="outline" disabled={sync.busy} onClick={() => { void sync.run() }}>{t('jira.syncTicket')}</Button>
      {jira?.error && <>
        {!jira.key && <Field label={t('jira.existingKey')}><Input value={existing} onChange={event => setExisting(event.target.value)} /></Field>}
        <Hint>{t('jira.uncertainHint')}</Hint>
        <ConfirmButton label={t('jira.retryUncertain')} title={t('jira.retryUncertain')} message={t('jira.confirmAbsent')}
          onConfirm={() => sync.run(true)} />
      </>}
    </>}
  </Section>
}
