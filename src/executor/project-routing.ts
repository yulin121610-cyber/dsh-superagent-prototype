/** Resolves a group's fixed local project before a ticket or worker is created. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { FeishuConfig } from '../sources/feishu.ts'

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

/** Only a listed Feishu group's explicit binding overrides the installation's default workspace. */
export function boundProjectPath(settings: Settings, trigger: Trigger | undefined, localWorkspace?: string): string | undefined {
  if (trigger?.source !== 'feishu' || trigger.meta.direct === true) return undefined
  const config = settings.sources.feishu?.config as Partial<FeishuConfig> | undefined
  const binding = config?.chats?.find(chat => chat.chatId === trigger.meta.chatId)?.projectPath?.trim()
  if (!binding) return undefined
  if (!localWorkspace) throw new Error('Group project routing requires local workspace mode')
  return existingProjectPath(binding)
}
