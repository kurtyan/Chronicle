# Temporary handoff: Focus list continuation fails after a trailing link

## Status

Diagnosis is complete. No source change has been made for this issue.

## User-visible failure

In the Focus / Day Script rich-text editor:

1. Create an ordered (`1.`) or bullet (`-`) list item.
2. Make the final content of that item a normal hyperlink.
3. Put the cursor immediately after the link and press `Enter`.

Expected: a new list item is created, continuing the number or bullet.

Actual: an empty paragraph is inserted inside the existing list item. The list does not continue visually.

## Confirmed scope

There are only two TipTap editor implementations in `web/src`:

- `web/src/components/RichEditor/index.tsx` — used by notes, task bodies, task entries, and meeting editors.
- `web/src/components/DayScriptEditor.tsx` — used by Focus / Day Script.

The shared `RichEditor` is **not** affected in the current source build. Both of these pass there:

- typing `1. https://example.com` and pressing `Enter` after the URL has autolinked;
- loading an existing ordered-list item whose final text is an `<a>` element and pressing `Enter` at its end.

The Focus `DayScriptEditor` is affected for both ordered and bullet lists.

## Root cause

`DayScriptEditor` has a Focus-specific `Enter` interception:

- `splitAfterLink()` at `web/src/components/DayScriptEditor.tsx:294` detects a cursor immediately after a link.
- Its `state.tr.split(selection.from)` call performs a generic, one-level textblock split.
- The `handleKeyDown` branch at `web/src/components/DayScriptEditor.tsx:467` consumes `Enter` when that helper succeeds.

That prevents TipTap's normal list keybinding from running. The list extension's `Enter` shortcut calls `splitListItem(...)`, which is the operation that creates the next `<li>`.

Observed Focus DOM after the broken `Enter` in an ordered list:

```html
<ol>
  <li>
    <p><a href="https://example.com">linked text</a></p>
    <p><br class="ProseMirror-trailingBreak"></p>
  </li>
</ol>
```

The expected shape is a second `<li>` containing the empty paragraph.

## Recommended implementation

Remove the Focus-specific `splitAfterLink()` interception and let TipTap handle `Enter` normally. The Link extension already declares `keepOnSplit: false`, so a normal split will not continue the link mark into the new line.

If retaining the helper is necessary for an uncovered Focus behavior, it must return `false` while the selection is inside either `orderedList` or `bulletList`, allowing `splitListItem` to run. Removing the interception is preferred unless there is a demonstrated regression, because the generic `RichEditor` already relies on TipTap's default behavior successfully.

## Required regression coverage

Add focused browser coverage for `DayScriptEditor` that asserts after `Enter` at a trailing normal link:

- an ordered list has two sibling `li` elements;
- a bullet list has two sibling `li` elements;
- the new list item's paragraph is empty and does not inherit the link mark.

Also preserve a non-list paragraph case: `Enter` after a trailing link should create a normal new paragraph without carrying the link mark.

Run the focused test and `./scripts/with-node.sh npm --prefix web run build`.

## Reproduction environment used for diagnosis

An isolated local server and database under `/private/tmp/chronicle-list-diagnosis` were used. They were stopped after testing. No application data or source files were changed by the diagnosis.
