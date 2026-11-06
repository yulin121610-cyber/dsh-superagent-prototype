/** Resolves a group's fixed local project before a ticket or worker is created. */
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { ServiceScope, Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { gitCheckout } from './worktrees.ts'
import type { FeishuConfig } from '../sources/feishu.ts'

/** Directories discovery skips in a monorepo: they are shared project files, not services. A saved list can still name them. */
const SUGGESTED_SKIP = new Set(['docs', 'openspec', 'scripts', 'logs', 'tmp', 'output', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'target'])
export interface DiscoveredService { name: string; path: string; kind: 'repo' | 'directory' }

/** Canonical existing project root; an invalid binding never falls back to another project. */
export function existingProjectPath(path: string): string {
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error('Not an absolute directory')
    accessSync(path, constants.R_OK | constants.X_OK)
    return realpathSync(path)
  } catch {
    throw new Error(`Project workspace must be an existing readable absolute directory: ${path}`)
  }
}

const feishuChat = (settings: Settings, trigger: Trigger | undefined) => {
  if (trigger?.source !== 'feishu' || trigger.meta.direct === true) return undefined
  const config = settings.sources.feishu?.config as Partial<FeishuConfig> | undefined
  return config?.chats?.find(chat => chat.chatId === trigger.meta.chatId)
}
/** Only a listed Feishu group's explicit binding overrides the installation's default workspace. */
export function boundProjectPath(settings: Settings, trigger: Trigger | undefined, localWorkspace?: string): string | undefined {
  const binding = feishuChat(settings, trigger)?.projectPath?.trim()
  if (!binding) return undefined
  if (!localWorkspace) throw new Error('Group project routing requires local workspace mode')
  return existingProjectPath(binding)
}
/** The group's saved service list. Empty when the group lists none; the saved list is the source of truth, not a scan. */
export function boundServices(settings: Settings, trigger: Trigger | undefined): { name: string; path: string }[] {
  return feishuChat(settings, trigger)?.services ?? []
}
/**
 * Freezes the services an accept chose. No saved list, an omitted choice, or `*` is the whole project (`undefined`), which
 * keeps the project lock. An unknown name fails the accept rather than widening or dropping the scope.
 */
export function freezeServices(projectPath: string, configured: readonly { name: string; path: string }[], chosen: readonly string[] | undefined): ServiceScope[] | undefined {
  if (!configured.length) return undefined
  const names = [...new Set((chosen ?? []).map(name => name.trim()).filter(Boolean))]
  if (!names.length || names.includes('*')) return undefined
  const byName = new Map(configured.map(service => [service.name, service]))
  const root = projectPath.endsWith(sep) ? projectPath : projectPath + sep
  return names.map(name => {
    const service = byName.get(name)
    if (!service) throw new Error(`Unknown service "${name}". Choose from: ${configured.map(item => item.name).join(', ')}, or * for the whole project.`)
    const canonical = existingProjectPath(resolve(projectPath, service.path))
    if (canonical !== projectPath && !canonical.startsWith(root)) throw new Error(`Service ${name} is outside the project`)
    if (canonical === projectPath) throw new Error(`Service ${name} is the whole project; omit services for the whole project`)
    const checkout = gitCheckout(canonical)
    return { name: service.name, path: canonical, ...checkout ? { repository: checkout.repository } : {} }
  })
}
/**
 * Suggests services under a project: child git repositories when any exist, otherwise the top-level directories of a git
 * root except shared names such as docs and scripts. The suggestion is not saved; the group's list is.
 */
export function discoverServices(projectPath: string): DiscoveredService[] {
  const root = existingProjectPath(projectPath)
  const children = readdirSync(root).flatMap(name => {
    if (name.startsWith('.')) return []
    const path = join(root, name)
    try { if (!statSync(path).isDirectory()) return [] } catch { return [] }
    return [name]
  }).sort()
  const repos = children.filter(name => {
    const path = join(root, name)
    try { return gitCheckout(path)?.repository === realpathSync(path) } catch { return false }
  })
  if (repos.length) return repos.map(name => ({ name, path: name, kind: 'repo' as const }))
  if (!gitCheckout(root)) return []
  return children.filter(name => !SUGGESTED_SKIP.has(name)).map(name => ({ name, path: name, kind: 'directory' as const }))
}
