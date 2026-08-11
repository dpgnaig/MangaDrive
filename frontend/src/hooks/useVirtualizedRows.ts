import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'

// Generic scroll-position virtualization for a fixed-height row list: only
// rows within [startIndex, endIndex) of the visible scroll window (plus
// overscan on both sides) need to be mounted. Shared by chapter-run lists
// (AdminScrambleTab's full list, UploadMonitorDock's floating summary) where
// a run can have hundreds/thousands of chapters and reconciling every row's
// DOM node on each progress tick (one per uploaded image) would otherwise be
// wasted work. rAF-throttled so a fast scroll doesn't flood setState calls.
export function useVirtualizedRows(rowSlot: number, maxHeight: number, overscan: number, count: number) {
  const [scrollTop, setScrollTop] = useState(0)
  const rafRef = useRef<number | null>(null)

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setScrollTop(top)
    })
  }, [])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  const visibleSlots = Math.ceil(maxHeight / rowSlot)
  const startIndex = Math.max(0, Math.floor(scrollTop / rowSlot) - overscan)
  const endIndex = Math.min(count, startIndex + visibleSlots + overscan * 2)

  return { onScroll, startIndex, endIndex }
}
