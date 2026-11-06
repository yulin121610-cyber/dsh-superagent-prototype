/** Jira Server / Data Center settings. Credentials are references, never inline values. */
import { z } from 'zod'

const text = z.string().trim().min(1).max(255)
const httpUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, 'An HTTP(S) base URL without credentials, query or fragment is required')
export const JiraSecretSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().trim().max(4096).refine(path => path.startsWith('/') || path.startsWith('~/'), 'Use an absolute path or ~/') }).strict(),
])
export const JIRA_STATES = ['accepted', 'working', 'waiting', 'blocked', 'failed', 'ready', 'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type JiraState = typeof JIRA_STATES[number]
export const JiraMappingSchema = z.object({
  chatId: text,
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100),
  issueType: text.default('Task'),
  labels: z.array(z.string().regex(/^[^\s,]+$/).max(255)).max(50).default([]),
  components: z.array(text).max(50).default([]),
  assignee: z.string().trim().max(255).default(''),
}).strict()
export const JiraConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: httpUrl.default(''),
  auth: z.enum(['bearer', 'basic']).default('bearer'),
  username: z.string().trim().max(255).default(''),
  secret: JiraSecretSchema.default({ kind: 'file', path: '~/.config/dsh-superagent-jira/token' }),
  panelUrl: httpUrl.default(''),
  mappings: z.array(JiraMappingSchema).max(200).refine(rows => new Set(rows.map(row => row.chatId)).size === rows.length, 'Duplicate chat mapping').default([]),
  transitions: z.partialRecord(z.enum(JIRA_STATES), text).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Required when Jira is enabled' })
  if (value.enabled && value.auth === 'basic' && !value.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'Required for basic auth' })
})
export type JiraConfig = z.infer<typeof JiraConfigSchema>
export type JiraMapping = z.infer<typeof JiraMappingSchema>
export type JiraSecret = z.infer<typeof JiraSecretSchema>
