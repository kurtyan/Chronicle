import { ChronicleListEditing, ChronicleListItem } from './ChronicleListItem'
import { WrappedCodeBlock } from './WrappedCodeBlock'

/**
 * Shared editor kernel used by both RichEditor and DayScriptEditor.
 * These are the extensions that were historically patched per-editor; keeping
 * them in one factory ensures the two editors can no longer drift.
 */
export function createSharedEditorExtensions() {
  return [
    ChronicleListItem,
    ChronicleListEditing,
    WrappedCodeBlock,
  ]
}
