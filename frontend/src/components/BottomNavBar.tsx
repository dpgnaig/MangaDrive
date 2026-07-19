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
}: {
  items: BottomNavAction[]
  className?: string
  style?: React.CSSProperties
  onContainerClick?: (e: React.MouseEvent) => void
}) {
  return (
    <div className={`lg-bottom-nav-container ${className}`} style={style} onClick={onContainerClick}>
      <nav className="lg-bottom-nav">
        {items.map(t => (
          <button
            key={t.key}
            onClick={t.onClick}
            disabled={t.disabled}
            className={`lg-nav-item ${t.active ? 'active' : ''}`}
          >
            <span className="ms" style={{ position: 'relative' }}>
              {t.active ? t.icon : (t.iconOutline || t.icon)}
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
    </div>
  )
}
