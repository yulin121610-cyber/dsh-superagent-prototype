/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import { isolatedExecution, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string; projectPath?: string; worktree?: { path: string; branch: string } }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  const workspace = ticket?.projectPath ?? deployment.localWorkspace
  if (workspace) result.push({ key: 'DSH_SUPERAGENT_LOCAL_WORKSPACE', value: workspace, owner: 'executor', description: settings.executor.concurrentWrites || ticket?.worktree
    ? { zh: '已有本地工作区；读取项目指令并使用现有仓库；不要自行创建克隆或 worktree（写工单的隔离 worktree 由宿主创建）', en: 'Existing local workspace; follow its project instructions and use its repositories; never create clones or worktrees yourself (the host creates a write ticket\'s isolated worktree)' }
    : { zh: '已有本地工作区；读取项目指令并使用现有仓库，不创建克隆或 worktree', en: 'Existing local workspace; follow its project instructions and use its repositories without creating clones or worktrees' } })
  if (ticket?.projectPath) result.push({ key: 'DSH_SUPERAGENT_PROJECT', value: ticket.projectPath,
    description: { zh: '来源群固定绑定的项目；本工单始终使用此目录', en: 'Project bound by the source group; this ticket keeps this directory' }, owner: 'executor' })
  if (ticket?.worktree) {
    result.push({ key: 'DSH_SUPERAGENT_WORKTREE', value: ticket.worktree.path, owner: 'executor',
      description: { zh: '宿主为本写工单创建的独立 git worktree（在项目目录之外）；所有修改都在这里进行，不要修改 DSH_SUPERAGENT_PROJECT 原目录', en: 'The isolated git worktree the host created for this write ticket, outside the project; make every change here, never in the DSH_SUPERAGENT_PROJECT checkout' } })
    result.push({ key: 'DSH_SUPERAGENT_BRANCH', value: ticket.worktree.branch, owner: 'executor',
      description: { zh: '本工单 worktree 的独立分支；完成后由人工审阅合并', en: 'This ticket\'s own worktree branch, which a person reviews and merges' } })
  }
  for (const { kind, environment, config } of sources.environments(settings)) {
    if (deployment.localWorkspace && kind.kind === 'github') continue
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const worktree = isolatedExecution(ticket.execution) ? ticket.execution!.worktree! : undefined
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '', ...ticket.execution?.projectPath ? { projectPath: ticket.execution.projectPath } : {},
    ...worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {} }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
