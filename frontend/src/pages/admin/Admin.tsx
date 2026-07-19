import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AppLayout from '../../components/AppLayout'
import AdminRootFoldersTab from './AdminRootFoldersTab'
import AdminUsersTab from './AdminUsersTab'
import AdminSettingsTab from './AdminSettingsTab'
import AdminScrambleTab from './AdminScrambleTab'
import { useIsDesktop } from '../../hooks/useBreakpoint'
import { useAuth } from '../../context/AuthContext'

const baseItems = [
  { key: 'sources', icon: 'folder', iconOutline: 'folder_open', label: 'Quản lý nguồn' },
  { key: 'users', icon: 'group', iconOutline: 'group', label: 'Quản lý user' },
  { key: 'settings', icon: 'settings', iconOutline: 'settings', label: 'Cấu hình' },
]

export default function Admin() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState(searchParams.get('tab') || 'sources')
  const navigate = useNavigate()
  const [showAddModal, setShowAddModal] = useState(false)
  const isDesktop = useIsDesktop()
  const { user } = useAuth()

  const canScramble = isDesktop && user?.role === 'Admin'
  const items = canScramble
    ? [...baseItems, { key: 'scramble', icon: 'shuffle', iconOutline: 'shuffle', label: 'Scramble ảnh' }]
    : baseItems

  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && items.some(i => i.key === t)) setTab(t)
  }, [searchParams, items])

  useEffect(() => {
    if (tab === 'scramble' && !canScramble) setTab('sources')
  }, [tab, canScramble])

  const changeTab = (key: string) => {
    setTab(key)
    setSearchParams({ tab: key })
  }

  return (
    <AppLayout showSearch={false} showBottomNav={false} showSider={false} maxWidth={900}>

      {/* Desktop: Inline tabs */}
      <div className="desktop-only" style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-elevated)', borderRadius: 12, border: '1px solid var(--border)' }}>
          {items.map(i => (
            <button
              key={i.key}
              onClick={() => changeTab(i.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 24px', borderRadius: 8, border: 'none',
                background: tab === i.key ? 'var(--accent)' : 'transparent',
                color: tab === i.key ? '#fff' : 'var(--text-secondary)',
                fontSize: 14, fontWeight: 500, cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              <span className="ms" style={{ fontSize: 18 }}>{i.icon}</span>
              {i.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile: Bottom nav */}
      <div className="mobile-only lg-bottom-nav-container">
        <nav className="lg-bottom-nav">
          <button onClick={() => navigate('/')} className="lg-nav-item">
            <span className="ms">home</span>
            <span className="lg-nav-label">Home</span>
          </button>
          {items.map((i) => (
            <button
              key={i.key}
              onClick={() => changeTab(i.key)}
              className={`lg-nav-item ${tab === i.key ? 'active' : ''}`}
            >
              <span className="ms">{tab === i.key ? i.icon : i.iconOutline}</span>
              <span className="lg-nav-label">{i.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="admin-content">
        {tab === 'sources' && <AdminRootFoldersTab showAddModal={showAddModal} onCloseAddModal={() => setShowAddModal(false)} />}
        {tab === 'users' && <AdminUsersTab />}
        {tab === 'settings' && <AdminSettingsTab />}
        {tab === 'scramble' && canScramble && <AdminScrambleTab />}
      </div>
    </AppLayout>
  )
}
