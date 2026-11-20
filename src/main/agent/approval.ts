import type { AgentApprovalMode, ReviewData } from '@shared/types'

export function shouldAutoApply(
  mode: AgentApprovalMode,
  review: Pick<ReviewData, 'autoApplicable' | 'files'>,
  activeDocumentId: string | null
): boolean {
  if (mode === 'full_access') return true
  return (
    mode === 'assisted' &&
    activeDocumentId !== null &&
    review.autoApplicable &&
    review.files.length === 1 &&
    review.files[0].documentId === activeDocumentId
  )
}
