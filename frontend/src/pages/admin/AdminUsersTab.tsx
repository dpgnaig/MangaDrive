import { useEffect, useState, useRef, useCallback } from 'react'
import { Avatar, Tag, Popconfirm, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import api from '../../lib/api'
import { useIsDesktop } from '../../hooks/useBreakpoint'
import { AdminUsersSkeleton } from '../../components/Skeleton'

interface User { id: string; email: string; displayName: string; avatarUrl: string; role: string; isApproved: boolean; isDisabled: boolean }

const PAGE_SIZE = 20

export default function AdminUsersTab() {
  const isDesktop = useIsDesktop()
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingRef = useRef(false)

  // load(): `replace` swaps the page (desktop / new search); otherwise appends (mobile "Xem thêm").
  const load = useCallback(async (p: number, q: string, replace: boolean) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (replace) setLoading(true); else setLoadingMore(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (q.trim()) params.set('search', q.trim())
      const { data } = await api.get(`/admin/users?${params}`)
      setUsers(prev => replace ? data.items : [...prev, ...data.items])
      setTotal(data.total)
      setHasMore(data.hasMore)
      setPage(data.page)
    } catch { /* ignore */ }
    setLoading(false)
    setLoadingMore(false)
    loadingRef.current = false
  }, [])

  // Debounced search — always resets to page 1 and replaces.
  useEffect(() => {
    const t = setTimeout(() => load(1, search, true), 300)
    return () => clearTimeout(t)
  }, [search, load])

  const toggleDisable = async (id: string) => { await api.post(`/admin/users/${id}/disable`); setUsers(users.map(u => u.id === id ? { ...u, isDisabled: !u.isDisabled } : u)) }
  const deleteUser = async (id: string) => { await api.delete(`/admin/users/${id}`); setUsers(users.filter(u => u.id !== id)); setTotal(t => Math.max(0, t - 1)) }

  const searchBar = (
    <>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Users ({total})</h2>
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <span className="ms ms-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>search</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Tìm theo tên hoặc email..."
          style={{ width: '100%', height: 40, borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', paddingLeft: 40, paddingRight: 14, fontSize: 15, outline: 'none' }}
          onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
        />
      </div>
    </>
  )

  // ===== Desktop: antd Table with built-in pagination =====
  if (isDesktop) {
    const columns: ColumnsType<User> = [
      {
        title: 'Người dùng', dataIndex: 'displayName', key: 'displayName',
        render: (_, u) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar src={u.avatarUrl} size={34} />
            <span style={{ fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {u.displayName}
              {u.role === 'Admin' && <Tag color="gold" style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px', margin: 0 }}>Admin</Tag>}
              {u.isDisabled && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px', margin: 0 }}>Đã khóa</Tag>}
            </span>
          </div>
        ),
      },
      { title: 'Email', dataIndex: 'email', key: 'email', responsive: ['lg'], render: (v: string) => <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{v}</span> },
      { title: 'Vai trò', dataIndex: 'role', key: 'role', width: 110, render: (r: string) => <Tag color={r === 'Admin' ? 'gold' : 'default'}>{r}</Tag> },
      {
        title: 'Thao tác', key: 'actions', width: 110, align: 'right',
        render: (_, u) => (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <button className="icon-btn icon-btn-sm" onClick={() => toggleDisable(u.id)} title={u.isDisabled ? 'Mở khóa' : 'Khóa'} style={{ color: u.isDisabled ? 'var(--green)' : 'var(--yellow)' }}>
              <span className="ms">{u.isDisabled ? 'person_add' : 'block'}</span>
            </button>
            <Popconfirm title="Xóa user này?" onConfirm={() => deleteUser(u.id)} okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }}>
              <button className="icon-btn icon-btn-sm" title="Xóa" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
            </Popconfirm>
          </div>
        ),
      },
    ]

    return (
      <>
        {searchBar}
        <Table<User>
          rowKey="id"
          columns={columns}
          dataSource={users}
          loading={loading}
          rowClassName={u => u.isDisabled ? 'admin-row-disabled' : ''}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: p => load(p, search, true),
          }}
        />
      </>
    )
  }

  // ===== Mobile: card list + "Xem thêm" (unchanged) =====
  return (
    <>
      {searchBar}
      {loading ? <AdminUsersSkeleton /> : users.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
          <span className="ms" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>person_off</span>
          <p style={{ fontSize: 14 }}>{search.trim() ? 'Không tìm thấy user nào' : 'Chưa có user nào'}</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {users.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', opacity: u.isDisabled ? 0.4 : 1, transition: 'opacity 0.3s' }}>
                <Avatar src={u.avatarUrl} size={38} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {u.displayName}
                    {u.role === 'Admin' && <Tag color="gold" style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px' }}>Admin</Tag>}
                    {u.isDisabled && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px' }}>Đã khóa</Tag>}
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.email}</p>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="icon-btn icon-btn-sm" onClick={() => toggleDisable(u.id)} style={{ color: u.isDisabled ? 'var(--green)' : 'var(--yellow)' }}>
                    <span className="ms">{u.isDisabled ? 'person_add' : 'block'}</span>
                  </button>
                  <Popconfirm title="Xóa user này?" onConfirm={() => deleteUser(u.id)}>
                    <button className="icon-btn icon-btn-sm" style={{ color: 'var(--red)' }}><span className="ms">delete</span></button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button onClick={() => load(page + 1, search, false)} disabled={loadingMore}
                style={{ padding: '10px 24px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: loadingMore ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {loadingMore && <span className="ms spin" style={{ fontSize: 16 }}>progress_activity</span>}
                {loadingMore ? 'Đang tải...' : 'Xem thêm'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
