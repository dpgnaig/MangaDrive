import { useEffect, useState } from 'react'

/** Matches the desktop breakpoint used across the app (see index.css @media 768px). */
export const DESKTOP_QUERY = '(min-width: 768px)'

/** Reactive boolean that flips when the viewport crosses the desktop breakpoint. */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP_QUERY).matches : true
  )

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', onChange)
    // Sync in case it changed between initial state and effect run.
    setIsDesktop(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return isDesktop
}
