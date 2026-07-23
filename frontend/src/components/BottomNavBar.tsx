import { ReactNode } from 'react'

export interface BottomNavAction {
  key: string
  /** Filled icon (shown when active). */
  icon: string
  /** Outline icon (shown when inactive). Falls back to `icon`. */
  iconOutline?: string
  label: ReactNode
  active?: boolean
  disabled?: boolean
  /** Small dot badge on the icon (e.g. unread indicator). */
  badge?: boolean
  onClick: (e: React.MouseEvent) => void
}

/**
 * Shared bottom navigation shell used by both the app BottomNav and the
 * ChapterReader nav so their look, spacing, and interactions stay in sync.
 * The container + nav markup and the `.lg-nav-*` classes are the single source
 * of truth; callers just supply the action items.
 */
export default function BottomNavBar({
  items,
  className = '',
  style,
  onContainerClick,
  variant = 'default',
  progress,
}: {
  items: BottomNavAction[]
  className?: string
  style?: React.CSSProperties
  onContainerClick?: (e: React.MouseEvent) => void
  /** 'glass' renders a floating, transparent pill with icon highlight chips (used by the reader). */
  variant?: 'default' | 'glass'
  /** 0-1 reading progress; renders a thin fill bar above the glass pill. Ignored for 'default'. */
  progress?: number
}) {
  const isGlass = variant === 'glass'
  const nav = (
    <nav className={`lg-bottom-nav ${isGlass ? 'lg-bottom-nav--glass' : ''}`}>
      {items.map(t => (
        <button
          key={t.key}
          onClick={t.onClick}
          disabled={t.disabled}
          className={`lg-nav-item ${isGlass ? 'lg-nav-item--glass' : ''} ${t.active ? 'active' : ''}`}
        >
          <span className="lg-nav-icon" style={{ position: 'relative' }}>
            <span className="ms">{t.active ? t.icon : (t.iconOutline || t.icon)}</span>
            {t.badge && (
              <span style={{
                position: 'absolute', top: -3, right: -5,
                minWidth: 8, height: 8, borderRadius: '50%',
                background: 'var(--red, #ff3b3b)',
                border: '2px solid var(--bg-base)',
                boxShadow: '0 0 0 1px var(--red, #ff3b3b)',
              }} />
            )}
          </span>
          <span className="lg-nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
  return (
    <div className={`lg-bottom-nav-container ${isGlass ? 'lg-bottom-nav-container--glass' : ''} ${className}`} style={style} onClick={onContainerClick}>
      {isGlass ? (
        // Grid wrapper: an auto-sized grid column shrinks to the nav's natural
        // width, and its sibling (the progress bar) stretches to fill that same
        // column — so the bar's width always matches the pill exactly with no JS.
        <div className="lg-reader-navwrap">
          {progress !== undefined && (
            <div className="lg-reader-progress">
              <div className="lg-reader-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {nav}
        </div>
      ) : nav}
    </div>
  )
}
