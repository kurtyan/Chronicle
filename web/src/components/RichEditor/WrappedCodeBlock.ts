import CodeBlock from '@tiptap/extension-code-block'
import { mergeAttributes } from '@tiptap/core'
import type { Editor, NodeViewRendererProps } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

function moveAcrossCodeBlockBoundary(editor: Editor, nodeName: string, direction: 'up' | 'down'): boolean {
  const { state, view } = editor
  const { selection } = state

  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== nodeName) return false

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')
  const textAfter = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '\n', '\n')
  const isAtBoundaryLine = direction === 'up' ? !textBefore.includes('\n') : !textAfter.includes('\n')

  if (!isAtBoundaryLine) return false

  const boundaryPos = direction === 'up' ? $from.before() : $from.after()
  const resolvedPos = state.doc.resolve(Math.max(0, Math.min(boundaryPos, state.doc.content.size)))
  const nextSelection = TextSelection.near(resolvedPos, direction === 'up' ? -1 : 1)

  if (nextSelection.$from.parent.type.name === nodeName) return false

  view.dispatch(state.tr.setSelection(nextSelection).scrollIntoView())
  return true
}

export const WrappedCodeBlock = CodeBlock.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      ArrowUp: () => moveAcrossCodeBlockBoundary(this.editor, this.name, 'up'),
      ArrowDown: () => moveAcrossCodeBlockBoundary(this.editor, this.name, 'down'),
    }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      softWrap: {
        default: true,
        parseHTML: (element) => element.getAttribute('data-code-wrap') !== 'off',
        renderHTML: (attributes) => ({
          'data-code-wrap': attributes.softWrap === false ? 'off' : 'on',
        }),
      },
    }
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-code-wrap': node.attrs.softWrap === false ? 'off' : 'on',
      }),
      ['code', 0],
    ]
  },

  addNodeView() {
    return (props: NodeViewRendererProps) => {
      let currentNode = props.node
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      const button = document.createElement('button')

      const renderState = () => {
        const softWrap = currentNode.attrs.softWrap !== false
        pre.setAttribute('data-code-wrap', softWrap ? 'on' : 'off')
        button.setAttribute('aria-pressed', String(softWrap))
        button.title = softWrap ? 'Disable soft wrap' : 'Enable soft wrap'
      }

      button.type = 'button'
      button.className = 'code-block-wrap-toggle'
      button.setAttribute('aria-label', 'Toggle code block soft wrap')
      button.textContent = '↵'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (typeof props.getPos !== 'function') return
        const pos = props.getPos()
        if (typeof pos !== 'number') return
        const nextAttrs = {
          ...currentNode.attrs,
          softWrap: currentNode.attrs.softWrap === false,
        }
        props.editor.view.dispatch(props.editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs))
      })

      pre.append(button, code)
      renderState()

      return {
        dom: pre,
        contentDOM: code,
        update: (node) => {
          if (node.type !== currentNode.type) return false
          currentNode = node
          renderState()
          return true
        },
      }
    }
  },
})
