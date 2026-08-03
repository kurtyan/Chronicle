import { Extension } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

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
  const codeBlockNode = codeBlock.create({ language: fence[1] ?? null })
  const tr = state.tr
  let codeStart: number

  if (!hasPrefix) {
    codeStart = $from.before()
    tr.replaceWith(codeStart, $from.after(), codeBlockNode)
  } else {
    tr.delete($from.start() + fenceOffset, $from.pos)
    codeStart = tr.mapping.map($from.after())
    tr.insert(codeStart, codeBlockNode)
  }

  tr.setSelection(TextSelection.create(tr.doc, codeStart + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const ChronicleTrailingCodeFence = Extension.create({
  name: 'chronicleTrailingCodeFence',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => turnTrailingFenceIntoCodeBlock(this.editor),
    }
  },
})

// The default TipTap list item must start with a paragraph. Chronicle also
// supports pasted nested lists without an artificial empty paragraph.
// Extending ListItem, rather than replacing it with a bare node, retains
// TipTap's Enter, Tab, and Shift+Tab list commands.
export const ChronicleListItem = ListItem.extend({
  content: 'paragraph block* | codeBlock block* | (bulletList | orderedList)+',
})
