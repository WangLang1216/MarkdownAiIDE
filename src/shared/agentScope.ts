import type { AgentApprovalMode, AgentTaskScope, StartTaskInput } from './types'

export function resolveAgentScope(
  scope: StartTaskInput['scope'],
  approvalMode: AgentApprovalMode,
  hasWorkspace: boolean
): AgentTaskScope {
  if (scope !== 'auto') return scope
  return hasWorkspace && approvalMode !== 'ask' ? 'workspace' : 'document'
}
