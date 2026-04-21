/**
 * React hook for registering keyboard shortcuts with the central registry.
 * Automatically registers on mount and unregisters on unmount.
 */

import { useEffect, useRef } from 'react';
import {
  registerShortcut,
  ShortcutScope,
  ShortcutDef,
} from '@/shortcuts/registry';

interface UseShortcutOptions {
  scope?: ShortcutScope;
  context?: () => boolean;
  enabled?: boolean;
}

/**
 * Register a keyboard shortcut.
 *
 * @param combo - Key combo string (e.g., "mod+shift+t", "n", "ArrowUp")
 * @param handler - Function to call when shortcut is triggered
 * @param options - Optional scope, context guard, and enabled flag
 *
 * Usage:
 *   useShortcut('n', handleNewTask, { context: () => !isEditing });
 *   useShortcut('mod+q', doAfk, { scope: 'app' });
 */
export function useShortcut(
  combo: string,
  handler: () => void,
  options?: UseShortcutOptions
): void {
  const { scope = 'page', context, enabled = true } = options ?? {};

  // Keep handler in ref to avoid re-registering on handler changes
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // Keep context in ref
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    if (!enabled) return;

    const def: ShortcutDef = {
      id: `${combo}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      combo,
      label: '', // Label can be set separately for Help UI
      scope,
      handler: () => handlerRef.current(),
      context: contextRef.current ? () => contextRef.current!() : undefined,
    };

    const unregister = registerShortcut(def);
    return unregister;
  }, [combo, scope, enabled]);
}

/**
 * Hook for multiple shortcuts.
 * More efficient when registering many shortcuts at once.
 *
 * @param shortcuts - Array of shortcut definitions
 */
export function useShortcuts(
  shortcuts: Array<{
    combo: string;
    handler: () => void;
    options?: UseShortcutOptions;
  }>
): void {
  // Keep shortcuts in ref
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const unregisters: (() => void)[] = [];

    for (const { combo, handler, options } of shortcutsRef.current) {
      const scope = options?.scope ?? 'page';
      const enabled = options?.enabled ?? true;

      if (!enabled) continue;

      const def: ShortcutDef = {
        id: `${combo}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        combo,
        label: '',
        scope,
        handler,
        context: options?.context,
      };

      unregisters.push(registerShortcut(def));
    }

    return () => {
      for (const unregister of unregisters) {
        unregister();
      }
    };
  }, []); // Re-register when shortcuts change via ref pattern
}