/** Bounded REST v2 transport. Only the backend resolves credentials; errors never echo Jira response bodies. */
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JiraConfig, JiraSecret } from './config.ts'

export async function jiraSecret(reference: JiraSecret): Promise<{ value: string; warning: string }> {
  let value: string | undefined, warning = ''
  if (reference.kind === 'env') value = process.env[reference.name]
  else {
    const path = reference.path.startsWith('~/') ? join(homedir(), reference.path.slice(2)) : reference.path
    let file
    try {
      file = await open(path, 'r')
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16_384) throw new Error()
      if (stat.mode & 0o177) warning = 'Jira token file permissions are broader than 0600; run chmod 600 on the token file.'
      value = await file.readFile('utf8')
    } catch { throw new Error('Jira credential file is missing, unreadable, not a regular file, or too large') }
    finally { await file?.close() }
  }
  const token = value?.trim()
  if (!token || token.length > 16_384 || /[\r\n\0]/.test(token)) throw new Error('Jira credential reference is empty or invalid')
  return { value: token, warning }
}

/** A definite Jira rejection permits a safe retry; uncertain writes must first be reconciled. */
export class JiraHttpError extends Error {
  constructor(readonly status: number) { super(`Jira HTTP ${status}; check authentication, project permissions and field/transition configuration`) }
  get rejected(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 408 }
}
export interface JiraIssue {
  key: string
  fields: { summary: string; status: { id: string; name: string }; priority?: { name: string } | null
    assignee?: { displayName: string } | null; updated?: string }
}
export interface JiraSearch { startAt: number; maxResults: number; total: number; issues: JiraIssue[] }
export interface JiraTransition { id: string; name: string; to: { id: string; name: string } }
export const jqlString = (value: string): string => JSON.stringify(value)
export const jiraUrl = (base: string, key: string): string => `${base.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`

/** Per-operation Jira connection; no credential, request headers or response bodies are persisted or logged. */
export class JiraClient {
  private constructor(readonly config: JiraConfig, private readonly authorization: string, readonly warning: string,
    private readonly signal: AbortSignal) {}
  static async connect(config: JiraConfig, signal: AbortSignal): Promise<JiraClient> {
    if (!config.enabled) throw new Error('Jira is disabled; configure Settings → Jira')
    const secret = await jiraSecret(config.secret)
    const authorization = config.auth === 'basic' ? `Basic ${Buffer.from(`${config.username}:${secret.value}`).toString('base64')}`
      : `Bearer ${secret.value}`
    return new JiraClient(config, authorization, secret.warning, signal)
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/rest/api/2/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: this.authorization, accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      })
      if (!response.ok) { await response.body?.cancel(); throw new JiraHttpError(response.status) }
      if (response.status === 204) return undefined as T
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []; let size = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 2_000_000) { await reader.cancel(); throw new Error() }
        chunks.push(next.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
    } catch (error) {
      if (error instanceof JiraHttpError) throw error
      throw new Error('Jira request failed, timed out, redirected, or returned an invalid response; write outcome may be unknown')
    }
  }
  search(jql: string, startAt = 0, maxResults = 50): Promise<JiraSearch> {
    return this.request('search', { jql, startAt, maxResults, fields: ['summary', 'status', 'priority', 'assignee', 'updated'] })
  }
  transitions(key: string): Promise<{ transitions: JiraTransition[] }> { return this.request(`issue/${encodeURIComponent(key)}/transitions`) }
}
