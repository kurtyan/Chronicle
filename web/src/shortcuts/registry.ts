/**
 * Centralized keyboard shortcut registry for Chronicle.
 * Shortcuts are organized by scope: global, app, page, component.
 * The dispatcher in App.tsx resolves conflicts by scope priority.
 */

export type ShortcutScope = 'global' | 'app' | 'page' | 'component';

export interface ShortcutDef {
  id: string;
  combo: string;
  label: string;
  scope: ShortcutScope;
  context?: () => boolean;
  handler: () => void;
}

interface RegisteredShortcut extends ShortcutDef {
  registeredAt: number;
}

const SCOPE_PRIORITY: ShortcutScope[] = ['component', 'page', 'app', 'global'];

let registry: RegisteredShortcut[] = [];

/**
 * Parse a combo string into checkable parts.
 * "mod+shift+t" => { mod: true, shift: true, key: "t" }
 * "ArrowUp" => { mod: false, shift: false, alt: false, key: "ArrowUp" }
 */
export function parseCombo(combo: string): {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
} {
  const hasPlus = combo.includes('+');
  let key = combo;
  let mod = false;
  let shift = false;
  let alt = false;

  if (hasPlus) {
    const parts = combo.toLowerCase().split('+');
    key = parts[parts.length - 1];
    mod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl');
    shift = parts.includes('shift');
    alt = parts.includes('alt');
    if (key === 'mod' || key === 'cmd' || key === 'ctrl' || key === 'shift' || key === 'alt') {
      key = '';
    }
  }

  return { mod, shift, alt, key };
}

/**
 * Check if a keyboard event matches a combo.
 */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parsed = parseCombo(combo);
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const modMatches = parsed.mod
    ? (isMac ? e.metaKey : e.ctrlKey)
    : (!e.metaKey && !e.ctrlKey);

  const shiftMatches = parsed.shift ? e.shiftKey : !e.shiftKey;
  const altMatches = parsed.alt ? e.altKey : !e.altKey;

  if (!parsed.key) return false;

  // Key matching: always case-insensitive
  const eventKey = e.key.toLowerCase();
  const comboKey = parsed.key.toLowerCase();

  return modMatches && shiftMatches && altMatches && eventKey === comboKey;
}

/**
 * Register a shortcut. Returns an unregister function.
 */
export function registerShortcut(def: ShortcutDef): () => void {
  const entry: RegisteredShortcut = {
    ...def,
    registeredAt: Date.now(),
  };
  registry.push(entry);

  return () => {
    registry = registry.filter(s => s.id !== def.id || s.registeredAt !== entry.registeredAt);
  };
}

/**
 * Get all registered shortcuts, sorted by scope priority.
 */
export function getShortcuts(): RegisteredShortcut[] {
  return [...registry].sort((a, b) => {
    const aPriority = SCOPE_PRIORITY.indexOf(a.scope);
    const bPriority = SCOPE_PRIORITY.indexOf(b.scope);
    return aPriority - bPriority;
  });
}

/**
 * Find a matching shortcut for an event.
 * Returns the first matching shortcut that passes its context guard.
 */
export function findMatchingShortcut(e: KeyboardEvent): RegisteredShortcut | null {
  const shortcuts = getShortcuts();

  for (const shortcut of shortcuts) {
    if (matchesCombo(e, shortcut.combo)) {
      if (shortcut.context && !shortcut.context()) {
        continue;
      }
      return shortcut;
    }
  }

  return null;
}

/**
 * Dispatch a keyboard event to matching shortcuts.
 * Returns true if a shortcut was triggered.
 */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  const shortcut = findMatchingShortcut(e);
  if (shortcut) {
    shortcut.handler();
    return true;
  }
  return false;
}

/**
 * Get shortcuts for display (Help UI).
 */
export function getShortcutsForDisplay(): Record<ShortcutScope, ShortcutDef[]> {
  const grouped: Record<ShortcutScope, ShortcutDef[]> = {
    global: [],
    app: [],
    page: [],
    component: [],
  };

  for (const shortcut of registry) {
    grouped[shortcut.scope].push(shortcut);
  }

  return grouped;
}

/**
 * Clear all registered shortcuts (for testing).
 */
export function clearRegistry(): void {
  registry = [];
}
