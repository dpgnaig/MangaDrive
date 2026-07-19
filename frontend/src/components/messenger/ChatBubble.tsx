import { useState } from 'react'
import { useMessenger, DmWindow } from '../../context/MessengerContext'

/** A minimized chat, collapsed into a floating avatar bubble (desktop only).
 *  Click to re-expand the window; a small X on hover closes it entirely. */
export default function ChatBubble({ win, bottom, size }: { win: DmWindow; bottom: number; size: number }) {
  const { conversations, toggleMinimize, closeChat } = useMessenger()
  const [hover, setHover] = useState(false)
  const unread = conversations.find(c => c.id === win.id)?.unread ?? 0

  return (
    <div
      className="dm-bubble"
      style={{ position: 'fixed', right: 20, bottom, width: size, height: size, pointerEvents: 'auto' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}>
      <button
        onClick={() => toggleMinimize(win.id)}
        title={win.other.displayName}
        style={{
          width: size, height: size, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
          background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden', display: 'block',
        }}>
        <img src={win.other.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </button>

      {unread > 0 && (
        <span style={{
          position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, padding: '0 5px',
          borderRadius: 10, background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px solid var(--bg-base)', boxShadow: '0 2px 6px rgba(255,107,44,0.4)',
        }}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}

      {hover && (
        <button
          onClick={e => { e.stopPropagation(); closeChat(win.id) }}
          title="Đóng"
          style={{
            position: 'absolute', top: -4, left: -4, width: 20, height: 20, borderRadius: '50%',
            border: 'none', cursor: 'pointer', background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-md)',
          }}>
          <span className="ms" style={{ fontSize: 14 }}>close</span>
        </button>
      )}
    </div>
  )
}
