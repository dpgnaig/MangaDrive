import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { useIsDesktop } from '../../hooks/useBreakpoint'
import { useMessenger } from '../../context/MessengerContext'

/**
 * Keeps the two messenger UIs consistent when the viewport crosses the desktop
 * breakpoint mid-session:
 *  - Mobile → Desktop: if we're on the full-screen /messages route, leave it.
 *    An open thread (/messages/:id) is reopened as a docked desktop chat window.
 *  - Desktop → Mobile: docked chat windows can't render on mobile, so the most
 *    recently opened one is converted into the /messages/:id full-screen thread;
 *    otherwise a plain open panel just routes to /messages.
 * Renders nothing.
 */
export default function MessengerBreakpointSync() {
  const isDesktop = useIsDesktop()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { windows, panelOpen, openChat, closeChat, setPanelOpen } = useMessenger()

  // Latest values without forcing the transition effect to re-run on every change.
  const pathRef = useRef(pathname)
  const windowsRef = useRef(windows)
  const panelRef = useRef(panelOpen)
  useEffect(() => { pathRef.current = pathname }, [pathname])
  useEffect(() => { windowsRef.current = windows }, [windows])
  useEffect(() => { panelRef.current = panelOpen }, [panelOpen])

  // Track the previous breakpoint so we only act on an actual crossing.
  const prevDesktop = useRef(isDesktop)

  useEffect(() => {
    if (prevDesktop.current === isDesktop) return
    prevDesktop.current = isDesktop
    const path = pathRef.current

    if (isDesktop) {
      // Mobile → Desktop
      if (path.startsWith('/messages')) {
        const activeId = path.replace(/^\/messages\/?/, '') || null
        navigate('/', { replace: true })
        if (activeId) {
          // Reopen the thread as a docked window (fetch the header data).
          api.get(`/dm/conversations/${activeId}`)
            .then(({ data }) => openChat(activeId, data.other))
            .catch(() => {})
        }
      }
    } else {
      // Desktop → Mobile
      const openWindows = windowsRef.current
      if (openWindows.length > 0) {
        const top = openWindows[0]
        openWindows.forEach(w => closeChat(w.id))
        setPanelOpen(false)
        navigate(`/messages/${top.id}`)
      } else if (panelRef.current) {
        setPanelOpen(false)
        navigate('/messages')
      }
    }
  }, [isDesktop, navigate, openChat, closeChat, setPanelOpen])

  return null
}
