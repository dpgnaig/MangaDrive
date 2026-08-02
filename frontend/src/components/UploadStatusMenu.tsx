import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Progress } from 'antd'
import { useAuth } from '../context/AuthContext'
import { useIsDesktop } from '../hooks/useBreakpoint'
import { subscribeDriveRun, getDriveRunSnapshot, cancelDriveRun, resumeDriveFromPause, type ChapterRunState } from '../lib/scrambleDriveRun'
import { AUTO_HIDE_FADE_MS } from './ChapterRunRow'
import { useVirtualizedRows } from '../hooks/useVirtualizedRows'

// Deliberately terser than AdminScrambleTab's ChapterRunRow: just the chapter's
// name/slug and a circular ring — full status text, error detail, and
// retry/cancel controls stay on the admin page ("Mở trang quản lý" below is
// the way there). This is a glance view, not a control surface.
const MINI_ROW_HEIGHT = 40
const MINI_ROW_SLOT = MINI_ROW_HEIGHT + 6
const MENU_LIST_MAX_HEIGHT = 220
const MENU_LIST_OVERSCAN = 3

const MiniChapterRow = memo(function MiniChapterRow({ chapter: c }: { chapter: ChapterRunState }) {
  const isFinished = c.status === 'done' || c.status === 'skipped'
  const pct = isFinished ? 100 : c.fileCount > 0 ? Math.round((c.doneCount / c.fileCount) * 100) : 0
  const status = c.status === 'error' ? 'exception' : c.status === 'done' ? 'success' : 'normal'
  // No strokeColor override for error/done — antd's own exception red /
  // success green apply. Pending/uploading get the project's accent instead
  // of antd's default blue; skipped/cancelled are just muted gray.
  const strokeColor = c.status === 'error' || c.status === 'done' ? undefined
    : c.status === 'skipped' || c.status === 'cancelled' ? 'var(--text-muted)'
    : 'var(--accent)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: MINI_ROW_HEIGHT, opacity: c.fadingOut ? 0 : 1, transition: `opacity ${AUTO_HIDE_FADE_MS}ms ease` }}>
      <p style={{ flex: 1, minWidth: 0, fontSize: 13, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {c.name}{c.slug ? ` → ${c.slug}` : ''}
      </p>
      <Progress type="circle" percent={pct} status={status} strokeColor={strokeColor} showInfo={false} size={26} />
    </div>
  )
})

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** Desktop-admin-only header icon + dropdown tracking a Drive scramble upload
 *  run (see scrambleDriveRun.ts) — the run lives at module scope so it keeps
 *  going after AdminScrambleTab unmounts; this menu is what lets the admin
 *  glance at it from anywhere else in the app. Mirrors NotificationBell's
 *  icon/dropdown pattern. Only rendered while a run is active. */
export default function UploadStatusMenu() {
  const { user } = useAuth()
  const isDesktop = useIsDesktop()
  const location = useLocation()
  const navigate = useNavigate()
  const snap = useSyncExternalStore(subscribeDriveRun, getDriveRunSnapshot)
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Auto-open whenever a new run starts, even if a previous run's dropdown
  // had been closed.
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (snap.running && !wasRunningRef.current) setOpen(true)
    wasRunningRef.current = snap.running
  }, [snap.running])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Tick a 1s timer while a run is in flight, based on the module store's
  // true start time — stays correct even after navigating back mid-run.
  useEffect(() => {
    if (!snap.running) return
    const id = setInterval(() => setElapsed(Date.now() - snap.startedAt), 1000)
    return () => clearInterval(id)
  }, [snap.running, snap.startedAt])

  const rowList = useVirtualizedRows(MINI_ROW_SLOT, MENU_LIST_MAX_HEIGHT, MENU_LIST_OVERSCAN, snap.chapterRuns.length)

  const isAdmin = user?.role === 'Admin'
  // AdminScrambleTab already shows the full per-chapter list inline while
  // it's mounted — showing this menu too would just duplicate that UI.
  const onScrambleTab = location.pathname.startsWith('/admin') && new URLSearchParams(location.search).get('tab') === 'scramble'

  if (!isAdmin || !isDesktop || !snap.running || onScrambleTab) return null

  const pct = snap.total > 0 ? Math.round((snap.done / snap.total) * 100) : 0
  const speed = elapsed > 0 ? snap.done / (elapsed / 1000) : 0
  const remaining = speed > 0 && snap.done < snap.total ? Math.round(((snap.total - snap.done) / speed) * 1000) : 0

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <button className="icon-btn icon-btn-sm" onClick={() => setOpen(!open)}
        style={{ color: open ? 'var(--accent)' : 'var(--text-secondary)' }} title="Upload lên Drive">
        <span className="ms" style={{ fontSize: 20 }}>cloud_upload</span>
      </button>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', zIndex: 1000, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Đang upload lên Drive</p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 6px' }}>
            {snap.done}/{snap.total} ảnh · {formatDuration(elapsed)}
          </p>
          <Progress percent={pct} size="small" status="active" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {speed > 0 && <span>{speed.toFixed(1)} ảnh/s</span>}
            {speed > 0 && snap.done < snap.total && <span>Còn lại ~{formatDuration(remaining)}</span>}
          </div>
        </div>

        {snap.pausedInfo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-base)', border: '1px solid var(--red, #e5484d)', borderRadius: 10, padding: '8px 10px' }}>
            <p style={{ fontSize: 11, color: 'var(--text)', margin: 0 }}>{snap.pausedInfo}</p>
            <Button size="small" onClick={resumeDriveFromPause} style={{ borderRadius: 16, alignSelf: 'flex-start' }}>Tiếp tục</Button>
          </div>
        )}

        {/* Glance list: name → slug + circular ring only. Full status text,
            errors, and retry/cancel controls live on the admin page. */}
        {snap.chapterRuns.length > 0 && (
          <div onScroll={rowList.onScroll} style={{ maxHeight: MENU_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
            <div style={{ position: 'relative', height: snap.chapterRuns.length * MINI_ROW_SLOT }}>
              {snap.chapterRuns.slice(rowList.startIndex, rowList.endIndex).map((c, i) => (
                <div key={c.name} style={{ position: 'absolute', top: (rowList.startIndex + i) * MINI_ROW_SLOT, left: 0, right: 0 }}>
                  <MiniChapterRow chapter={c} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" onClick={cancelDriveRun} danger style={{ borderRadius: 16 }}>Hủy</Button>
          <Button size="small" onClick={() => { setOpen(false); navigate('/admin?tab=scramble') }} style={{ borderRadius: 16 }}>Mở trang quản lý</Button>
        </div>
        </div>
      )}
    </div>
  )
}
