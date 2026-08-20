import { Extension } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'
import type { Editor } from '@tiptap/core'
import type { ResolvedPos } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

function findAncestorDepth($pos: ResolvedPos, nodeName: string): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === nodeName) return depth
  }
  return null
}

export function turnTrailingFenceIntoCodeBlock(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  const { $from } = selection
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name !== 'paragraph') return false

  if ($from.parentOffset !== $from.parent.content.size) return false
  const textBeforeCursor = state.doc.textBetween($from.start(), $from.pos, '\n', '\ufffc')
  const fence = textBeforeCursor.match(/```([A-Za-z0-9_+-]+)?$/)
  if (!fence || fence.index === undefined) return false
  if (fence.index > 0 && textBeforeCursor[fence.index - 1] === '`') return false

  const codeBlock = state.schema.nodes.codeBlock
  if (!codeBlock) return false

  let fenceOffset = fence.index
  while (fenceOffset > 0 && /[ \t]/.test(textBeforeCursor[fenceOffset - 1])) fenceOffset--
  const hasPrefix = textBeforeCursor.slice(0, fenceOffset).trim().length > 0
  const inListItem = findAncestorDepth($from, 'listItem') !== null
  const codeBlockNode = codeBlock.create({ language: fence[1] ?? null })
  const tr = state.tr
  let codeStart: number

  if (!hasPrefix && !inListItem) {
    // Standalone empty paragraph: replace it with the code block directly,
    // leaving no empty paragraph behind.
    codeStart = $from.before()
    tr.replaceWith(codeStart, $from.after(), codeBlockNode)
  } else {
    // Keep the paragraph (empty in a list item, or with prefix text) and
    // append the code block after it, so a list item never starts with a
    // codeBlock (content model is `paragraph block*`).
    tr.delete($from.start() + fenceOffset, $from.pos)
    codeStart = tr.mapping.map($from.after())
    tr.insert(codeStart, codeBlockNode)
  }

  tr.setSelection(TextSelection.create(tr.doc, codeStart + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const ChronicleListEditing = Extension.create({
  name: 'chronicleListEditing',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => turnTrailingFenceIntoCodeBlock(this.editor),
    }
  },
})

// Use TipTap's default list item content model (paragraph first). Pasted
// nested lists / code-first items are normalized at paste time instead of
// relaxing the schema, which keeps splitListItem / joinItemBackward correct.
export const ChronicleListItem = ListItem.extend({
  content: 'paragraph block*',
})
