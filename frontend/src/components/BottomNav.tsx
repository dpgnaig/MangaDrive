import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../lib/api'
import BottomNavBar, { BottomNavAction } from './BottomNavBar'

const tabs = [
  { path: '/', icon: 'home', iconOutline: 'home', label: 'Home' },
  { path: '/favorites', icon: 'favorite', iconOutline: 'favorite_border', label: 'Likes' },
  { path: '/notifications', icon: 'notifications', iconOutline: 'notifications_none', label: 'Thông báo' },
]

const adminTab = { path: '/admin', icon: 'admin_panel_settings', iconOutline: 'admin_panel_settings', label: 'Admin' }

export default function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { user } = useAuth()
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const fetch = () => { api.get('/notifications/unread-count').then(r => setUnreadCount(r.data)).catch(() => {}) }
    fetch()
    const interval = setInterval(fetch, 30000)
    return () => clearInterval(interval)
  }, [])

  // Clear badge when user navigates to notifications
  useEffect(() => {
    if (pathname === '/notifications') setUnreadCount(0)
  }, [pathname])

  const isAdmin = user?.role === 'Admin'
  const allTabs = isAdmin ? [...tabs, adminTab] : tabs

  const items: BottomNavAction[] = allTabs.map(t => ({
    key: t.path,
    icon: t.icon,
    iconOutline: t.iconOutline,
    label: t.label,
    active: pathname === t.path,
    badge: t.path === '/notifications' && unreadCount > 0,
    onClick: () => navigate(t.path),
  }))

  return <BottomNavBar items={items} />
}
