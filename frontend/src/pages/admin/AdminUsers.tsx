import { useEffect, useState } from 'react'
import { Avatar, Tag, Popconfirm } from 'antd'
import { AdminNav } from './AdminRootFolders'
import api from '../../lib/api'

interface User { id: string; email: string; displayName: string; avatarUrl: string; role: string; isApproved: boolean; isDisabled: boolean }

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([])
  useEffect(() => { api.get('/admin/users').then(r => setUsers(r.data)) }, [])

  const approve = async (id: string) => { await api.post(`/admin/users/${id}/approve`); setUsers(users.map(u => u.id === id ? { ...u, isApproved: true } : u)) }
  const toggleDisable = async (id: string) => { await api.post(`/admin/users/${id}/disable`); setUsers(users.map(u => u.id === id ? { ...u, isDisabled: !u.isDisabled } : u)) }
  const deleteUser = async (id: string) => { await api.delete(`/admin/users/${id}`); setUsers(users.filter(u => u.id !== id)) }

  return (
    <div style={{ minHeight: '100vh' }}>
      <AdminNav active="users" />
      <main style={{ padding: 20, maxWidth: 800, margin: '0 auto' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>Users ({users.length})</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {users.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', opacity: u.isDisabled ? 0.4 : 1, transition: 'opacity 0.3s' }}>
              <Avatar src={u.avatarUrl} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {u.displayName}
                  {u.role === 'Admin' && <Tag color="gold" style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px' }}>Admin</Tag>}
                  {u.isApproved && <span className="ms ms-xs" style={{ color: 'var(--green)' }}>verified</span>}
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.email}</p>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {!u.isApproved && (
                  <button className="icon-btn icon-btn-sm" onClick={() => approve(u.id)} title="Approve" style={{ color: 'var(--green)' }}><span className="ms">check_circle</span></button>
                )}
                <button className="icon-btn icon-btn-sm" onClick={() => toggleDisable(u.id)} title={u.isDisabled ? 'Enable' : 'Disable'} style={{ color: u.isDisabled ? 'var(--green)' : 'var(--yellow)' }}>
                  <span className="ms">{u.isDisabled ? 'person_add' : 'block'}</span>
                </button>
                <Popconfirm title="Xóa user này?" onConfirm={() => deleteUser(u.id)}>
                  <button className="icon-btn icon-btn-sm" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
