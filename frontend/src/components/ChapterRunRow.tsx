import { memo } from 'react'
import type { ChapterRunState } from '../lib/scrambleDriveRun'

// Fade-out duration for a row right before scrambleDriveRun.ts removes it from
// chapterRuns (see scheduleAutoHide there) — kept here as the single source
// since this is the only place it drives a CSS transition.
export const AUTO_HIDE_FADE_MS = 350
export const CHAPTER_ROW_HEIGHT = 56

// One row in a Drive upload progress list — shared by AdminScrambleTab's full
// per-chapter list and UploadMonitorDock's floating summary, so both surfaces
// render chapter status identically instead of drifting apart. Memoized so
// that when one chapter's doneCount ticks up, only that row re-renders
// instead of the whole visible window — chapterRuns is rebuilt as a new
// array on every update, but unaffected chapter objects keep their old
// reference, so memo's shallow prop check bails out on them as long as
// onRetry/onCancel are stable (retryDriveChapter/cancelDriveChapterRow are
// module-level functions, so they're always stable).
export const ChapterRunRow = memo(function ChapterRunRow({ chapter: c, onRetry, onCancel }: {
  chapter: ChapterRunState
  onRetry: (name: string) => void
  onCancel: (name: string) => void
}) {
  const icon = c.status === 'done' ? 'check_circle'
    : c.status === 'skipped' ? 'check_circle'
    : c.status === 'uploading' ? 'progress_activity'
    : c.status === 'error' ? 'error'
    : c.status === 'cancelled' ? 'cancel'
    : 'schedule'
  const color = c.status === 'done' ? 'var(--green, #4caf50)'
    : c.status === 'skipped' ? 'var(--text-muted)'
    : c.status === 'uploading' ? 'var(--accent)'
    : c.status === 'error' ? 'var(--red, #e5484d)'
    : 'var(--text-muted)'
  const pct = c.fileCount > 0 ? Math.round((c.doneCount / c.fileCount) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', height: CHAPTER_ROW_HEIGHT, boxSizing: 'border-box', opacity: c.fadingOut ? 0 : 1, transition: `opacity ${AUTO_HIDE_FADE_MS}ms ease` }}>
      <span className={c.status === 'uploading' ? 'ms spin' : 'ms'} style={{ fontSize: 18, color }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 500, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.name}{c.slug ? ` → ${c.slug}` : ''}
        </p>
        {c.status === 'uploading' && (
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-hover)', marginTop: 4 }}>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--accent)', width: `${pct}%`, transition: 'width 0.3s' }} />
          </div>
        )}
        {c.status === 'error' && c.error && (
          <p style={{ fontSize: 11, color: 'var(--red, #e5484d)', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.error}</p>
        )}
        {c.status === 'skipped' && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Đã có trên Drive</p>
        )}
        {c.status === 'cancelled' && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Đã hủy</p>
        )}
      </div>
      {c.status === 'error' && (
        <button className="icon-btn icon-btn-sm" onClick={() => onRetry(c.name)} title="Thử lại" style={{ color: 'var(--accent)' }}>
          <span className="ms">refresh</span>
        </button>
      )}
      {c.status === 'uploading' && (
        <button className="icon-btn icon-btn-sm" onClick={() => onCancel(c.name)} title="Hủy chapter này" style={{ color: 'var(--text-muted)' }}>
          <span className="ms">close</span>
        </button>
      )}
    </div>
  )
})
