import type { ProjectLocale } from '../../../shared/projectReviewTypes'

/** Locale belongs to newly generated text, never to the user's source material. */
export function projectLocale(value: unknown, fallback: ProjectLocale = 'zh-CN'): ProjectLocale {
  if (value === undefined) return fallback
  if (value === 'en' || value === 'zh-CN') return value
  throw Object.assign(new Error('Invalid project locale'), { status: 400, code: 'INVALID_PROJECT_LOCALE' })
}

export const projectLocaleCopy = {
  'zh-CN': {
    reviewTag: '复盘', aiTag: 'AI草稿', completionTitle: '复盘', periodicTitle: '阶段回顾', draftTitle: '复盘草稿',
    completionHeadings: ['结果与完成标准', '关键判断与转折', '有效做法与失误', '感悟与可复用认识', '适用边界与下一次验证'],
    periodicHeadings: ['过去与现在的变化', '具体案例与个人贡献', '感悟与尚未验证的认识', '下一次验证'],
    source: '来源：', observations: '观察（模型提炼，需核对）', interpretations: '可能解释（待验证）', suggestedChecks: '建议验证', evidenceGaps: '反证与证据缺口', reflectionQuestions: '留给自己的感悟',
    completeCoverage: '已覆盖本次记录', partialCoverage: '部分覆盖，请查看缺口', staleCoverage: '；来源已变化，保留生成时快照',
  },
  en: {
    reviewTag: 'Review', aiTag: 'AI draft', completionTitle: 'Completion review', periodicTitle: 'Periodic review', draftTitle: 'Review draft',
    completionHeadings: ['Outcome and completion criteria', 'Key decisions and turning points', 'What worked and what did not', 'Lessons and reusable insights', 'Limits and the next validation'],
    periodicHeadings: ['What changed', 'Examples and personal contributions', 'Reflections and untested ideas', 'Next validation'],
    source: 'Source: ', observations: 'Observations (AI draft, review required)', interpretations: 'Possible explanations (to validate)', suggestedChecks: 'Suggested checks', evidenceGaps: 'Counterevidence and evidence gaps', reflectionQuestions: 'Your reflections',
    completeCoverage: 'All captured records included', partialCoverage: 'Partial coverage; check the gaps', staleCoverage: '; sources changed, original snapshots retained',
  },
} satisfies Record<ProjectLocale, object>
