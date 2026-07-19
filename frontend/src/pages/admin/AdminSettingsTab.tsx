import { useEffect, useState } from 'react'
import { Input, Button, message } from 'antd'
import api from '../../lib/api'
import { AdminSettingsSkeleton } from '../../components/Skeleton'

export default function AdminSettingsTab() {
  const [announcement, setAnnouncement] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get('/settings/announcement')
      .then(r => setAnnouncement(r.data || ''))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await api.put('/settings/announcement', { value: announcement })
      message.success('Đã cập nhật thông báo')
    } catch {
      message.error('Cập nhật thất bại')
    }
    setSaving(false)
  }

  return (
    <>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Cấu hình</h2>

      {loading ? <AdminSettingsSkeleton /> : (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="ms" style={{ fontSize: 18, color: 'var(--accent)' }}>campaign</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Thông báo</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Nội dung hiển thị trên banner chạy ở trang chủ. Để trống để ẩn banner.
          </p>
          <Input.TextArea
            value={announcement}
            onChange={e => setAnnouncement(e.target.value)}
            rows={4}
            placeholder="Nội dung thông báo hiển thị trên banner..."
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Button type="primary" onClick={save} loading={saving} style={{ borderRadius: 20, height: 36 }}>
              Lưu
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
