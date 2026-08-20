import CodeBlock from '@tiptap/extension-code-block'
import { mergeAttributes } from '@tiptap/core'
import type { NodeViewRendererProps } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

export const WrappedCodeBlock = CodeBlock.extend({
  addOptions() {
    return {
      ...this.parent!(),
      enableTabIndentation: true,
    }
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // In a code block, Cmd/Ctrl+A should select only the code block's text,
      // like a <textarea>, instead of the whole document.
      'Mod-a': () => {
        const { state, view } = this.editor
        const { $from } = state.selection
        if ($from.parent.type.name !== this.name) return false
        view.dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, $from.start(), $from.end()))
            .scrollIntoView(),
        )
        return true
      },
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
      button.setAttribute('tabindex', '-1')
      button.setAttribute('contenteditable', 'false')
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
