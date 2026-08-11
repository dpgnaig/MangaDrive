import { useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Avatar, Badge, Dropdown, Modal } from 'antd'
import { useAuth } from '../context/AuthContext'
import { useMessenger } from '../context/MessengerContext'
import NotificationBell from './NotificationBell'
import SearchDrawer from './SearchDrawer'
import MessengerPanel from './messenger/MessengerPanel'
import UploadStatusMenu from './UploadStatusMenu'
import { useIsDesktop } from '../hooks/useBreakpoint'

export default function TopNav({ showSearch = true }: { showSearch?: boolean }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { unread: msgUnread, panelOpen, setPanelOpen } = useMessenger()
  const isDesktop = useIsDesktop()
  const [showProfile, setShowProfile] = useState(false)
  const [showSearchDrawer, setShowSearchDrawer] = useState(false)
  const msgBtnRef = useRef<HTMLButtonElement>(null)

  // Desktop (>=768px) opens the conversation popover in place; mobile navigates
  // to the full-screen Messages page.
  const onMessengerClick = () => {
    if (isDesktop) setPanelOpen(!panelOpen)
    else navigate('/messages')
  }

  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 100, background: 'rgba(13,13,13,0.5)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <Link to="/"><img src="/logo.png" alt="MangaDrive" style={{ height: 32, mixBlendMode: 'lighten' }} /></Link>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {showSearch && (
          <button className="icon-btn icon-btn-sm desktop-only" onClick={() => setShowSearchDrawer(true)} style={{ color: 'var(--text-secondary)' }}>
            <span className="ms" style={{ fontSize: 20 }}>search</span>
          </button>
        )}
        {showSearch && (
          <button className="icon-btn icon-btn-sm mobile-only" onClick={() => setShowSearchDrawer(true)} style={{ color: 'var(--text-secondary)' }}>
            <span className="ms" style={{ fontSize: 20 }}>search</span>
          </button>
        )}

        <div style={{ position: 'relative', display: 'flex' }}>
          <Badge count={msgUnread} size="small" offset={[-2, 2]}>
            <button ref={msgBtnRef} className="icon-btn icon-btn-sm" onClick={onMessengerClick}
              style={{ color: panelOpen ? 'var(--accent)' : 'var(--text-secondary)' }} title="Tin nhắn">
              <span className="ms" style={{ fontSize: 20 }}>forum</span>
            </button>
          </Badge>
          {isDesktop && panelOpen && <MessengerPanel anchorRef={msgBtnRef} />}
        </div>

        <UploadStatusMenu />

        <span className="desktop-only"><NotificationBell /></span>

        <Dropdown menu={{ items: [
          { key: 'name', label: <span style={{ fontWeight: 600 }}>{user?.displayName}</span>, disabled: true },
          { key: 'email', label: <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user?.email}</span>, disabled: true },
          { type: 'divider' },
          { key: 'profile', label: <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="ms ms-sm">person</span>Tài khoản</span>, onClick: () => setShowProfile(true) },
          ...(user?.role === 'Admin' ? [{ key: 'admin', label: <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="ms ms-sm">admin_panel_settings</span>Quản trị hệ thống</span>, onClick: () => navigate('/admin') }] : []),
          { type: 'divider' as const },
          { key: 'logout', label: <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red)' }}><span className="ms ms-sm">logout</span>Đăng xuất</span>, onClick: logout }
        ] as any}} trigger={['click']} placement="bottomRight">
          {user?.avatarUrl
            ? <Avatar src={user.avatarUrl} size={34} style={{ cursor: 'pointer', border: '2px solid var(--border)' }} />
            : <button className="icon-btn icon-btn-sm"><span className="ms">account_circle</span></button>
          }
        </Dropdown>
      </div>

      <Modal open={showProfile} onCancel={() => setShowProfile(false)} footer={null} title="Tài khoản" centered>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 0' }}>
          <img src={user?.avatarUrl} style={{ width: 56, height: 56, borderRadius: '50%' }} />
          <div>
            <p style={{ fontWeight: 600, fontSize: 16 }}>{user?.displayName}</p>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{user?.email}</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Role: {user?.role}</p>
          </div>
        </div>
      </Modal>

      <SearchDrawer open={showSearchDrawer} onClose={() => setShowSearchDrawer(false)} />
    </header>
  )
}
