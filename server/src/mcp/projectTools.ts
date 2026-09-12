import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import * as projects from '../services/projectService'
import * as references from '../services/projectReferenceService'
import * as reviews from '../services/projectReviewService'
import * as insights from '../services/projectInsightService'
import { getWorkStatistics } from '../services/workStatisticsService'
import { broadcastEvent } from '../services/eventBus'

const targetType = z.enum(['area', 'milestone'])
const sourceType = z.enum(['task', 'note'])
const range = { start: z.number().optional(), end: z.number().optional(), asOf: z.number().optional() }
const scope = { targetType, targetId: z.string(), periodStart: z.number().nullable().optional(), periodEnd: z.number().nullable().optional() }
const reference = z.object({ targetType, targetId: z.string(), role: z.enum(['related', 'outcome', 'review', 'growth']).optional() })
const insightBudget = z.object({ inputCharacters: z.number().int().min(1000).max(480000).optional(), maxCalls: z.number().int().min(1).max(24).optional(), maxOutputTokens: z.number().int().min(256).max(16000).optional() })

/** All transports use the same domain services, revision checks and snapshots. */
export function registerProjectTools(server: McpServer): void {
  function tool(name: string, description: string, schema: any, run: (input: any) => unknown | Promise<unknown>, mutation = false) {
    server.registerTool(name, { description, inputSchema: schema }, async (input: any) => {
      try {
        const value = await run(input)
        if (value == null) return { content: [{ type: 'text' as const, text: 'Not found' }], isError: true }
        if (mutation) broadcastEvent('projects_changed', { source: 'mcp', operation: name })
        return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, code: error.code }) }], isError: true }
      }
    })
  }
  const filters = { query: z.string().optional(), includeArchived: z.boolean().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional() }
  tool('query_areas', 'List long-lived Areas. Area is the first management level; milestones belong to Areas.', filters, projects.listAreas)
  tool('create_area', 'Create an Area without creating tasks or changing their time allocation.', { name: z.string().min(1), description: z.string().optional(), focus: z.string().optional(), latestProgress: z.string().optional(), nextStep: z.string().optional() }, projects.createArea, true)
  tool('update_area', 'Edit or archive an Area using its current revision. Child states and history do not cascade.', {
    id: z.string(), expectedRevision: z.number().int().positive(), name: z.string().optional(), description: z.string().optional(), focus: z.string().optional(), status: z.enum(['active', 'paused', 'ended']).optional(), archived: z.boolean().optional(),
    latestProgress: z.string().optional(), nextStep: z.string().optional(),
  }, ({ id, ...input }) => projects.updateArea(id, input), true)
  tool('apply_area_insight_summary', 'On explicit user instruction, use reviewed text from an accepted Area insight as its current progress and next step. Checks both Area and source Note revisions; never changes the Note or confirms a review.', {
    id: z.string(), insightDraftId: z.string(), expectedRevision: z.number().int().positive(), expectedNoteRevision: z.number().int().positive(), latestProgress: z.string(), nextStep: z.string(),
  }, ({ id, ...input }) => projects.applyAreaInsightSummary(id, input), true)
  tool('query_milestones', 'List stage or ongoing milestones. Tasks allocate work to at most one primary milestone.', { ...filters, areaId: z.string().optional() }, projects.listMilestones)
  tool('create_milestone', 'Create a stage or ongoing milestone under an Area. Do not infer completion from time or task counts.', {
    areaId: z.string(), name: z.string().min(1), kind: z.enum(['stage', 'ongoing']).optional(), goal: z.string().optional(), completionCriteria: z.string().optional(), startDate: z.number().nullable().optional(), targetDate: z.number().nullable().optional(),
  }, projects.createMilestone, true)
  tool('update_milestone', 'Edit a milestone with revision checks. Complete only on the user\'s instruction and set confirmCompletion; Area changes require an assignment preview token.', {
    id: z.string(), expectedRevision: z.number().int().positive(), name: z.string().optional(), goal: z.string().optional(), completionCriteria: z.string().optional(),
    status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled', 'ended']).optional(), kind: z.enum(['stage', 'ongoing']).optional(), areaId: z.string().optional(),
    archived: z.boolean().optional(), confirmCompletion: z.boolean().optional(), confirmKindChange: z.boolean().optional(), assignmentToken: z.string().optional(),
    latestProgress: z.string().optional(), nextStep: z.string().optional(), blockers: z.string().optional(), startDate: z.number().nullable().optional(), targetDate: z.number().nullable().optional(), priority: z.string().nullable().optional(),
  }, ({ id, ...input }) => projects.updateMilestone(id, input), true)
  tool('get_project', 'Read an Area or milestone, its primary work, backlinks and recorded time.', { targetType, targetId: z.string(), ...range }, ({ targetType: kind, targetId, ...window }) => kind === 'area' ? projects.getAreaDetail(targetId, window) : projects.getMilestoneDetail(targetId, window))
  tool('project_statistics', 'Recorded work-session statistics in milliseconds for [start,end), at asOf. References and Notes never allocate extra work time.', range, getWorkStatistics)
  tool('preview_project_assignment', 'Preview historical time reclassification before applying. Existing task assignments require this token. Merely mentioning a project must not move time.', {
    changes: z.array(z.object({ taskId: z.string(), primaryMilestoneId: z.string().nullable(), expectedRevision: z.number().int().positive() })).optional(),
    milestoneId: z.string().optional(), areaId: z.string().optional(), expectedRevision: z.number().int().positive().optional(), asOf: z.number().optional(),
  }, projects.previewAssignment)
  tool('apply_project_assignment', 'Apply a previously reviewed assignment preview. May fail if source relationships or work records changed.', { token: z.string() }, ({ token }) => projects.applyAssignment(token), true)
  tool('undo_project_assignment', 'Undo a previous assignment event only if no conflicting subsequent changes occurred.', { eventId: z.string() }, ({ eventId }) => projects.undoAssignment(eventId), true)
  tool('get_project_references', 'Read typed Area/milestone references and their independent revision for a Task or Note.', { sourceType, sourceId: z.string() }, input => references.getReferences(input.sourceType, input.sourceId))
  tool('set_project_references', 'Replace explicit references with a revision check. References provide knowledge backlinks and never change the primary work allocation.', {
    sourceType, sourceId: z.string(), expectedRevision: z.number().int().positive(), references: z.array(reference),
  }, input => references.setReferences(input.sourceType, input.sourceId, input.references, input.expectedRevision), true)
  tool('get_project_backlinks', 'Read referenced Tasks and Notes, deduplicated with the association paths.', { targetType, targetId: z.string() }, input => references.getBacklinks(input.targetType, input.targetId))
  tool('list_project_reviews', 'List durable reviews for an Area or milestone. A review role does not imply confirmation.', { targetType, targetId: z.string() }, input => reviews.listProjectReviews(input.targetType, input.targetId))
  tool('get_project_review', 'Read a review and its immutable confirmation versions, including original evidence.', { id: z.string() }, input => reviews.getProjectReview(input.id))
  tool('create_project_review', 'Create a draft linked to an existing Note or a new Note. Completion and review confirmation are separate.', {
    ...scope, kind: z.enum(['completion', 'periodic']), noteId: z.string().optional(), title: z.string().optional(), contentHtml: z.string().optional(), completionEventId: z.string().nullable().optional(), insightDraftId: z.string().optional(),
  }, reviews.createProjectReview, true)
  tool('update_project_review', 'Change the Note or period of an unconfirmed review. Confirmed metadata is immutable.', {
    id: z.string(), noteId: z.string().optional(), periodStart: z.number().nullable().optional(), periodEnd: z.number().nullable().optional(),
  }, ({ id, ...input }) => reviews.updateProjectReview(id, input), true)
  tool('delete_project_review', 'Delete an unconfirmed review record. The Note is retained and confirmed versions cannot be deleted.', {
    id: z.string(),
  }, ({ id }) => reviews.deleteProjectReview(id) ? { deleted: true } : null, true)
  tool('confirm_project_review', 'Save an immutable review version only when the user requests confirmation. Check the current Note revision first.', {
    id: z.string(), expectedNoteRevision: z.number().int().positive(), acknowledgeStaleEvidence: z.boolean().optional(),
  }, ({ id, ...input }) => reviews.confirmProjectReview(id, input), true)
  tool('generate_project_insight', 'Generate an evidence-backed draft using the configured LLM. Does not change tasks, completion or confirmed reviews.', {
    ...scope, budget: insightBudget.optional(),
  }, insights.createProjectInsight, true)
  tool('get_project_insight', 'Read a durable generated draft, source snapshots and coverage. Running jobs may be queried again later.', { id: z.string() }, input => insights.getProjectInsight(input.id))
  tool('list_project_insights', 'List generated drafts and failures for a scope without generating a new one.', { targetType, targetId: z.string() }, input => insights.listProjectInsights(input.targetType, input.targetId))
  tool('cancel_project_insight', 'Cancel generation without deleting the durable source snapshot or previous successful drafts.', { id: z.string() }, input => insights.cancelProjectInsight(input.id), true)
  tool('retry_project_insight', 'Retry generation as a new draft without replacing the old draft or confirmed Note. Optionally increase the bounded output budget after truncation.', { id: z.string(), budget: insightBudget.optional() }, ({ id, ...input }) => insights.retryProjectInsight(id, input), true)
  tool('accept_project_insight', 'On user instruction, append a successful draft to an existing Note with revision checking or create a Note. This does not confirm a review.', {
    id: z.string(), noteId: z.string().optional(), expectedNoteRevision: z.number().int().positive().optional(), title: z.string().optional(),
  }, ({ id, ...input }) => insights.acceptProjectInsight(id, input), true)
}
