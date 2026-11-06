// @vitest-environment jsdom
// Jira tab, settings, local-only requests, pagination, board, issue links and explicit enrollment.
import { act } from 'react'
import { expect, it } from 'vitest'
import { JiraConfigSchema } from '../src/jira/config.ts'
import { en, zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, remount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const enable = () => { server.settings.jira = JiraConfigSchema.parse({ enabled: true, baseUrl: 'https://jira.invalid',
  mappings: [{ chatId: 'oc_team', projectKey: 'DEMO' }, { chatId: 'oc_other', projectKey: 'API' }] }) }

it('shows a setup hint when disabled in both languages without querying Jira search', async () => {
  at({ page: 'jira' }); await mount()
  expect(text()).toContain(zh['jira.disabled'])
  expect(server.requests.some(request => request.path.startsWith('jira/search'))).toBe(false)
  await click(zh['jira.setup'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe('Jira')
  expect(find(zh['jira.enabled'], '[role="switch"]').getAttribute('aria-checked')).toBe('false')
  expect(all('input[type="password"]')).toHaveLength(0)
  expect(field<HTMLInputElement>(zh['jira.filePath']).value).toBe('~/.config/dsh-superagent-jira/token')
  at({ page: 'jira' }); await remount(en)
  expect(text()).toContain(en['jira.disabled'])
})

it('edits reference-only Jira settings, group mapping and transition names, then tests the saved configuration', async () => {
  at({ page: 'settings', query: { group: 'jira' } }); await mount(en)
  await click(find(en['jira.enabled'], '[role="switch"]'))
  await type(field<HTMLInputElement>(en['jira.baseUrl']), 'https://jira.invalid/context')
  await type(field<HTMLSelectElement>(en['jira.secretKind']), 'env')
  await type(field<HTMLInputElement>(en['jira.envName']), 'DSH_JIRA_TOKEN')
  await click(en.addRow)
  await type(field<HTMLSelectElement>(en['jira.group']), 'oc_team')
  await type(field<HTMLInputElement>(en['jira.projectKey']), 'DEMO')
  await type(field<HTMLInputElement>(en['jira.labels']), 'agent, local')
  await type(field<HTMLInputElement>(en['jira.state.working']), 'Start')
  await click(en.save)
  expect(server.settings.jira).toMatchObject({ enabled: true, secret: { kind: 'env', name: 'DSH_JIRA_TOKEN' },
    mappings: [{ chatId: 'oc_team', projectKey: 'DEMO', issueType: 'Task', labels: ['agent', 'local'] }], transitions: { working: 'Start' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/jira'])
  await click(find(en['jira.test'], 'button'))
  expect(text()).toContain('Authenticated as Jira Bot')
  expect(text()).toContain('Task (3)')
  expect(text()).toContain('Start (21) → In Progress')
  expect(JSON.stringify(server.requests)).not.toContain('authorization')
})

it('queries the backend for mapped projects and filters, searches JQL, follows Jira pagination and offers ticket navigation', async () => {
  enable(); at({ page: 'jira' })
  server.jiraSearch = query => ({ total: 2, startAt: Number(query.startAt ?? 0), next: query.startAt === '1' ? null : 1,
    issues: [{ key: query.startAt === '1' ? 'DEMO-2' : 'DEMO-1', url: 'https://jira.invalid/browse/DEMO-1', summary: 'Fix API',
      status: 'In Progress', priority: 'High', assignee: 'Alice', updated: '2026-11-01T00:00:00Z', ticketId: 't1' }] })
  await mount(en)
  expect(text()).toContain('DEMO-1')
  expect(all('a').find(link => link.textContent === 'DEMO-1')?.getAttribute('target')).toBe('_blank')
  await click(en['jira.filter.assigned'])
  await type(field<HTMLSelectElement>(en['jira.project']), 'DEMO')
  await type(field<HTMLInputElement>(en['jira.text']), 'API')
  await type(field<HTMLInputElement>(en['jira.jql']), 'priority = High')
  await act(async () => { field<HTMLInputElement>(en['jira.jql']).form!.requestSubmit() }); await settle()
  expect(server.requests.at(-1)!.path).toContain('jql=priority = High')
  expect(server.requests.at(-1)!.path).toContain('project=DEMO&filter=assigned')
  await click(en['jira.next']); expect(text()).toContain('DEMO-2')
  expect(server.requests.at(-1)!.path).toContain('startAt=1')
  await click(en['jira.refresh']); expect(server.requests.at(-1)!.path).toContain('refresh=1')
  await click(find(en['jira.board'], '[role="switch"]'))
  expect(document.querySelector('.dt-jira-board')?.textContent).toContain('In Progress')
  await click(en.openTicket)
  expect(text()).toContain('修复回归')
  await click(en['jira.syncTicket'])
  expect(server.requests.some(request => request.path === 'tickets/t1/jira' && request.method === 'POST')).toBe(true)
})
