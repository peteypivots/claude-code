// Polyfill for React 19's useEffectEvent hook
// Required because the bundled build runs useEffectEvent before React's
// internal hooks dispatcher is initialized. This provides a working
// implementation using useCallback + useRef pattern.
//
// Reference: https://react.dev/reference/react/useEffectEvent

import { useCallback, useRef, useInsertionEffect } from 'react'

/**
 * Polyfill for useEffectEvent - creates a stable callback reference
 * that always calls the latest version of the provided function.
 *
 * Unlike useCallback, this doesn't need dependencies because it
 * always captures the latest closure values.
 */
export function useEffectEvent<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef<T>(fn)

  // useInsertionEffect runs synchronously before any layout effects,
  // ensuring the ref is updated before any effects that use it run.
  // This matches React's internal implementation of useEffectEvent.
  useInsertionEffect(() => {
    ref.current = fn
  })

  // Return a stable callback that delegates to the latest function
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, [])
}

export default useEffectEvent
