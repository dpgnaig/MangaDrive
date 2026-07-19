import { Layout, Menu } from 'antd'
import { ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { ItemType } from 'antd/es/menu/interface'
import TopNav from './TopNav'

const navItems = [
  { key: '/', icon: 'home', label: 'Trang chủ' },
  { key: '/favorites', icon: 'favorite', label: 'Yêu thích' },
]

interface Props {
  children: ReactNode
  showTopNav?: boolean
  showBottomNav?: boolean
  showSider?: boolean
  showSearch?: boolean
  maxWidth?: number
  noPadding?: boolean
  siderItems?: ItemType[]
  siderSelectedKey?: string
  onSiderSelect?: (key: string) => void
}

export default function AppLayout({ children, showTopNav = true, showBottomNav = true, showSider = true, showSearch = true, maxWidth, noPadding = false, siderItems, siderSelectedKey, onSiderSelect }: Props) {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const defaultMenuItems: ItemType[] = [
    ...navItems.map(i => ({ key: i.key, icon: <span className="ms ms-sm">{i.icon}</span>, label: i.label })),
  ]

  const menuItems = siderItems || defaultMenuItems
  const selectedKey = siderSelectedKey || navItems.find(i => i.key === pathname)?.key || '/'

  const handleMenuClick = (key: string) => {
    if (onSiderSelect) onSiderSelect(key)
    else navigate(key)
  }

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      {showTopNav && <TopNav showSearch={showSearch} />}
      <Layout hasSider={showSider} style={{ flex: 1, background: 'var(--bg-base)' }}>
        {showSider && (
          <Layout.Sider width={220} className="app-sider desktop-only"
            style={{ background: 'var(--bg-surface)', borderRight: '1px solid var(--border)', overflow: 'auto', height: 'calc(100vh - 56px)', position: 'sticky', top: 56, left: 0 }}>
            <Menu mode="inline" selectedKeys={[selectedKey]}
              onClick={({ key }) => handleMenuClick(key)}
              style={{ background: 'transparent', border: 'none', paddingTop: 8 }}
              items={menuItems} />
          </Layout.Sider>
        )}

        <Layout.Content style={{ padding: noPadding ? 0 : '16px 24px', paddingBottom: noPadding ? 0 : (showBottomNav ? 80 : 16) }}>
          <div style={{ maxWidth, margin: maxWidth ? '0 auto' : undefined }}>{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
