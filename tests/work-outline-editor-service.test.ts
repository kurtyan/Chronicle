import { test, expect } from '@playwright/test'
import { normalizeOutlineDocument, normalizePastedOutline, visibleOutlineRows, outlineTaskIds, outlineTaskId, outlineLineText, indentOutlineRows, moveOutlineBranch, splitOutlineLine, parseOutlineText, parseOutlineClipboardNodes, bindOutlineTask, rankOutlineTasks, outlineLabel, type OutlineClipboardNode } from '../web/src/lib/workOutline'
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'

function line(id: string, depth: number, text: string, taskId?: string): OutlineLine {
  return { type: 'outlineLine', attrs: { id, depth }, content: [{ type: 'text', text }, ...(taskId ? [{ type: 'taskRef' as const, attrs: { taskId, label: taskId } }] : [])] }
}
const document = (...content: OutlineLine[]): OutlineDocument => ({ type: 'doc', schemaVersion: 1, content })

test('completion inheritance stops at the nearest independently active task', () => {
  const doc = document(line('a', 0, 'A', 'A'), line('b', 1, '说明'), line('c', 2, '细节'), line('d', 1, 'B', 'B'), line('e', 2, 'B细节'))
  expect(visibleOutlineRows(doc, new Set(), { A: 'DONE', B: 'DOING' }).map(row => row.dimmed)).toEqual([true, true, true, false, false])
  expect(visibleOutlineRows(doc, new Set(), { A: 'DOING', B: 'DONE' }).map(row => row.dimmed)).toEqual([false, false, false, true, true])
})

test('pure ancestors complete only when at least one descendant task exists and every task is DONE', () => {
  const doc = document(line('root', 0, '方向'), line('p', 1, '阶段'), line('a', 2, 'A', 'A'), line('b', 2, 'B', 'B'), line('empty', 0, '想法'))
  expect(visibleOutlineRows(doc, new Set(), { A: 'DONE', B: 'DONE' }).map(row => row.dimmed)).toEqual([true, true, true, true, false])
  for (const status of ['DOING', 'DROPPED', 'ON_HOLD', 'MISSING']) expect(visibleOutlineRows(doc, new Set(), { A: 'DONE', B: status }).slice(0, 2).map(row => row.dimmed)).toEqual([false, false])
})

test('folding affects projection without changing stored rows or task references', () => {
  const doc = document(line('r', 0, 'root'), line('a', 1, 'task', 'A'), line('b', 2, 'note'), line('s', 0, 'next'))
  expect(visibleOutlineRows(doc, new Set(['r']), {}).map(row => row.line.attrs.id)).toEqual(['r', 's'])
  expect(outlineTaskIds(doc)).toEqual(['A'])
  expect(doc.content).toHaveLength(4)
})

test('Enter after parent text creates a sibling after its subtree without reparenting children', () => {
  const doc = document(line('r', 0, 'root'), line('c', 1, 'child', 'C'), line('g', 2, 'grandchild'), line('s', 0, 'sibling'))
  const split = splitOutlineLine(doc, 'r', 4)
  expect(split.document.content.map(row => row.attrs.id)).toEqual(['r', 'c', 'g', split.newRowId, 's'])
  expect(split.document.content.map(row => row.attrs.depth)).toEqual([0, 1, 2, 0, 0])
  expect(outlineTaskId(split.document.content[1])).toBe('C')
})

test('middle split keeps original children and preserves the reference only on its actual side', () => {
  const doc = document(line('r', 0, 'plan', 'A'), line('c', 1, 'detail'))
  const split = splitOutlineLine(doc, 'r', 2)
  expect(outlineLineText(split.document.content[0])).toBe('pl')
  expect(split.document.content[1].attrs.id).toBe('c')
  expect(outlineLineText(split.document.content[2])).toBe('an@A')
  expect(outlineTaskIds(split.document)).toEqual(['A'])
  const afterAtom = splitOutlineLine(doc, 'r', 5)
  expect(outlineTaskId(afterAtom.document.content[0])).toBe('A')
  expect(outlineTaskId(afterAtom.document.content[2])).toBeNull()
})

test('indent and outdent move a branch as one unit and prevent skipped levels', () => {
  const doc = document(line('a', 0, 'a'), line('b', 0, 'b'), line('c', 1, 'c', 'C'), line('d', 0, 'd'))
  const indented = indentOutlineRows(doc, ['b'], 1)
  expect(indented.content.map(row => row.attrs.depth)).toEqual([0, 1, 2, 0])
  expect(indented.content.map(row => row.attrs.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(indentOutlineRows(indented, ['b'], -1)).toEqual(doc)
  expect(indentOutlineRows(doc, ['a'], 1)).toEqual(doc)
  expect(indentOutlineRows(doc, ['c'], 1)).toEqual(doc)
})

test('branch reorder preserves ids, children and shared Task identities', () => {
  const doc = document(line('a', 0, 'a', 'T'), line('c', 1, 'c'), line('b', 0, 'b', 'T'), line('d', 1, 'd'))
  const moved = moveOutlineBranch(doc, 'b', -1)
  expect(moved.content.map(row => row.attrs.id)).toEqual(['b', 'd', 'a', 'c'])
  expect(outlineTaskIds(moved)).toEqual(['T'])
  expect(moveOutlineBranch(moved, 'b', 1)).toEqual(doc)
})

test('normalization repairs duplicate line IDs and invalid depths while preserving original references', () => {
  const doc = normalizeOutlineDocument(document(line('same', 9, 'first', 'A'), line('same', 5, 'second', 'B'), line('next', -2, 'last')))
  expect(doc.content.map(row => row.attrs.depth)).toEqual([0, 1, 0])
  expect(new Set(doc.content.map(row => row.attrs.id)).size).toBe(3)
  expect(doc.content[0].attrs.id).toBe('same')
  expect(outlineTaskIds(doc)).toEqual(['A', 'B'])
})

test('plain text paste respects tab/space levels but never guesses a Task from its title', () => {
  const doc = parseOutlineText('- root\n\t- @Task A\n\t\t- details\n  - sibling')
  expect(doc.content.map(row => row.attrs.depth)).toEqual([0, 1, 2, 1])
  expect(outlineTaskIds(doc)).toEqual([])
  expect(outlineLineText(doc.content[1])).toBe('@Task A')
})

test('copying a non-root subtree rebases every descendant by the same depth', () => {
  const branch = document(line('a', 1, 'branch'), line('b', 2, 'child'), line('c', 3, 'grandchild'), line('d', 2, 'sibling', 'T'))
  const rebased = normalizePastedOutline(branch)
  expect(rebased.content.map(row => row.attrs.depth)).toEqual([0, 1, 2, 1])
  expect(rebased.content.map(row => row.attrs.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(outlineTaskIds(rebased)).toEqual(['T'])
  expect(parseOutlineText('\t- branch\n\t\t- child\n\t\t\t- grandchild\n\t\t- sibling').content.map(row => row.attrs.depth)).toEqual([0, 1, 2, 1])
})

test('late task binding targets stable id after a branch move and does not recreate a deleted row', () => {
  const doc = document(line('a', 0, 'first'), line('b', 0, 'target'))
  const moved = moveOutlineBranch(doc, 'b', -1)
  const bound = bindOutlineTask(moved, 'b', 'TASK', 'Created task')
  expect(outlineTaskId(bound.content[0])).toBe('TASK')
  expect(outlineTaskId(bound.content[1])).toBeNull()
  expect(bindOutlineTask(document(line('a', 0, 'first')), 'b', 'TASK', 'Created task').content).toHaveLength(1)
})

test('deep outlines are projected iteratively without a fixed business depth limit', () => {
  const doc = document(...Array.from({ length: 2500 }, (_, index) => line(`row-${index}`, index, 'level', index === 2499 ? 'LAST' : undefined)))
  expect(visibleOutlineRows(doc, new Set(), { LAST: 'DONE' }).every(row => row.dimmed)).toBe(true)
})

test('external text accepts variable space indentation, mixed tabs, Unicode bullets and ordered markers', () => {
  const pasted = parseOutlineText('• Direction\r\n    1. Task one\r\n        ◦ Detail\r\n    2) Task two\r\n• Other\r\n\t- Tab task\r\n\t  ▪ Mixed child\r\n\t- Peer\r\n')
  expect(pasted.content.map(value => value.attrs.depth)).toEqual([0, 1, 2, 1, 0, 1, 2, 1])
  expect(pasted.content.map(outlineLineText)).toEqual(['Direction', 'Task one', 'Detail', 'Task two', 'Other', 'Tab task', 'Mixed child', 'Peer'])
  expect(parseOutlineText('    • Copied child\n• New root\n  • Its child').content.map(value => value.attrs.depth)).toEqual([0, 0, 1])
})

const textNode = (text: string): OutlineClipboardNode => ({ text })
const element = (tag: string, children: OutlineClipboardNode[], attrs?: Record<string, string>): OutlineClipboardNode => ({ tag, children, attrs })

test('Notes nested list and paragraph structure produces one row per list item', () => {
  const pasted = parseOutlineClipboardNodes([
    element('ul', [
      element('li', [element('p', [textNode('Direction')]), element('ul', [
        element('li', [element('p', [textNode('Child')]), element('p', [textNode('continued')]), element('ol', [element('li', [element('p', [textNode('Grandchild')])])])]),
        element('li', [element('p', [textNode('Sibling')])]),
      ])]),
      element('li', [element('p', [textNode('Next direction')])]),
    ]),
  ], new Set())!
  expect(pasted.content.map(value => value.attrs.depth)).toEqual([0, 1, 2, 1, 0])
  expect(pasted.content.map(outlineLineText)).toEqual(['Direction', 'Child continued', 'Grandchild', 'Sibling', 'Next direction'])
})

test('clipboard preserves only explicit existing Task IDs and never executes or imports active markup', () => {
  const pasted = parseOutlineClipboardNodes([
    element('script', [textNode('evil()')]), element('style', [textNode('.evil {}')]),
    element('ul', [
      element('li', [textNode('Implement '), element('a', [textNode('@Existing')], { 'data-task-id': 'T1234567890', href: 'javascript:evil()' })]),
      element('li', [element('a', [textNode('@Deleted')], { 'data-task-id': 'T0000000000' })]),
      element('li', [textNode('@Existing without an ID'), element('img', [], { src: 'https://example.invalid/image', onerror: 'evil()' })]),
    ]),
  ], new Set(['T1234567890']))!
  expect(outlineTaskIds(pasted)).toEqual(['T1234567890'])
  expect(pasted.content.map(outlineLineText)).toEqual(['Implement @Existing', '@Deleted', '@Existing without an ID'])
  expect(JSON.stringify(pasted)).not.toMatch(/evil|javascript|example.invalid|href|onerror/)
})

test('multiple explicit Task references survive paste as adjacent rows with one reference each', () => {
  const pasted = parseOutlineClipboardNodes([element('p', [
    textNode('Review '), element('a', [textNode('@One')], { 'data-task-id': 'one' }), textNode(' and '),
    element('span', [textNode('@Two')], { 'data-outline-task': 'two' }), textNode(' today'),
  ])], new Set(['one', 'two']))!
  expect(pasted.content.map(outlineTaskId)).toEqual(['one', 'two'])
  expect(pasted.content.map(outlineLineText)).toEqual(['Review @One and', '@Two today'])
})

test('Chrome inline wrappers and Apple tab spans preserve line breaks and indent levels', () => {
  const pasted = parseOutlineClipboardNodes([element('span', [
    textNode('• Direction'), element('br', []), element('span', [textNode('\t')], { class: 'Apple-tab-span' }),
    textNode('• Child'), element('br', []), textNode('\t\t1. Detail'),
  ])], new Set())!
  expect(pasted.content.map(value => value.attrs.depth)).toEqual([0, 1, 2])
  expect(pasted.content.map(outlineLineText)).toEqual(['Direction', 'Child', 'Detail'])
  const styled = parseOutlineClipboardNodes([
    element('div', [textNode('Direction')]),
    element('div', [textNode('Child')], { style: 'margin-left: 40px;' }),
    element('div', [textNode('Detail')], { style: 'margin-left: 60pt;' }),
    element('div', [textNode('Sibling')], { style: 'padding-left: 2.5em;' }),
  ], new Set())!
  expect(styled.content.map(value => value.attrs.depth)).toEqual([0, 1, 2, 1])
  const prewrapped = parseOutlineClipboardNodes([element('span', [textNode('• Direction\n    1. Child\n        - Detail')], { style: 'white-space: pre-wrap;' })], new Set())!
  expect(prewrapped.content.map(value => value.attrs.depth)).toEqual([0, 1, 2])
  expect(prewrapped.content.map(outlineLineText)).toEqual(['Direction', 'Child', 'Detail'])
})

test('Task labels are single-line and bounded so one unusual title can never block saving the outline', () => {
  const long = 'x'.repeat(1500), multiline = 'First line\r\nSecond line\u2028third'
  const normalized = normalizeOutlineDocument(document({ ...line('a', 0, 'row'), content: [{ type: 'taskRef', attrs: { taskId: 't1', label: long } }] }, { ...line('b', 0, 'row'), content: [{ type: 'taskRef', attrs: { taskId: 't2', label: multiline } }] }))
  const labels = normalized.content.map(row => (row.content![0] as any).attrs.label as string)
  expect(labels[0]).toHaveLength(1000)
  expect(labels[1]).toBe('First line Second line third')
  expect(outlineLabel('', 'T-1')).toBe('T-1')
  expect(outlineLabel(' \n ', 'T-1')).toBe('T-1')
  const bound = bindOutlineTask(document(line('a', 0, 'row')), 'a', 't3', multiline)
  expect((bound.content[0].content!.at(-1) as any).attrs.label).toBe('First line Second line third')
})

test('the @ menu ranks title prefixes, then substrings, then IDs, favours active and recent Tasks, and reports hidden matches', () => {
  const task = (id: string, title: string, status = 'PENDING', updatedAt = 0) => ({ id, title, status, updatedAt })
  const tasks = [
    task('T-1', 'Write the report', 'DONE', 50), task('T-2', 'Report bug triage', 'DOING', 10), task('T-3', 'Annual report draft', 'PENDING', 30),
    task('report-9', 'Unrelated title', 'PENDING', 99), task('T-5', 'Report bug triage', 'DOING', 40),
  ]
  expect(rankOutlineTasks(tasks, 'report').items.map(item => item.id)).toEqual(['T-5', 'T-2', 'T-3', 'T-1', 'report-9'])
  expect(rankOutlineTasks(tasks, 'REPORT bug').items.map(item => item.id)).toEqual(['T-5', 'T-2'])
  expect(rankOutlineTasks(tasks, 'nothing like it')).toEqual({ items: [], total: 0 })
  // An empty query lists active Tasks first, most recently updated first.
  expect(rankOutlineTasks(tasks, '').items.map(item => item.id)).toEqual(['T-5', 'T-2', 'report-9', 'T-3', 'T-1'])
  const many = Array.from({ length: 120 }, (_, index) => task(`M-${index}`, `Match ${index}`, 'PENDING', index))
  const limited = rankOutlineTasks(many, 'match')
  expect(limited.items).toHaveLength(50)
  expect(limited.total).toBe(120)
  expect(limited.items[0].id).toBe('M-119')
  expect(rankOutlineTasks(many, 'match 7', 5).items.map(item => item.id)).toEqual(['M-117', 'M-107', 'M-97', 'M-87', 'M-79'])
})
