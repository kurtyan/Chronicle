/** The ordered document is the only persisted source of outline hierarchy. */
export type OutlineInlineNode = { type: 'text'; text: string } | { type: 'taskRef'; attrs: { taskId: string; label: string } }
export interface OutlineLine {
  type: 'outlineLine'
  attrs: { id: string; depth: number }
  content?: OutlineInlineNode[]
}
export interface OutlineDocument { type: 'doc'; schemaVersion: 1; content: OutlineLine[] }
export interface WorkOutline { id: string; title: string; document: OutlineDocument; epoch: string; revision: number; createdAt: number; updatedAt: number }
export interface SaveOutlineResult { id: string; epoch: string; revision: number; mutationId: string; updatedAt: number }
