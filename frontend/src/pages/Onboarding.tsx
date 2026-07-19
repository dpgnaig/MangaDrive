import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Steps, Input, Button, message } from 'antd'
import { useAuth } from '../context/AuthContext'
import api from '../lib/api'

// Validate a yyyy-mm-dd birthday: real calendar date, not in the future,
// age between 6 and 120. Returns an error string, or null when valid.
function validateBirthday(birthday: string): string | null {
  if (!birthday) return 'Vui lòng nhập ngày sinh'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday)
  if (!m) return 'Ngày sinh không hợp lệ'
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return 'Ngày sinh không tồn tại'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (dt > today) return 'Ngày sinh không thể ở tương lai'
  let age = today.getFullYear() - y
  if (today.getMonth() < mo - 1 || (today.getMonth() === mo - 1 && today.getDate() < d)) age--
  if (age < 6) return 'Bạn phải từ 6 tuổi trở lên'
  if (age > 120) return 'Ngày sinh không hợp lệ'
  return null
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text)', padding: '0 14px', fontSize: 15, outline: 'none'
}

export default function Onboarding() {
  const { user, refreshUser } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'Admin'

  const [current, setCurrent] = useState(0)

  // Step: profile (shared)
  const [displayName, setDisplayName] = useState(user?.displayName || '')
  const [birthday, setBirthday] = useState('')
  const [birthdayTouched, setBirthdayTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)

  const birthdayError = validateBirthday(birthday)
  const profileValid = !!displayName.trim() && !birthdayError

  // Admin step: master password
  const [pwStatusLoading, setPwStatusLoading] = useState(true)
  const [pwSet, setPwSet] = useState(false)
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  // Admin step: banner
  const [banner, setBanner] = useState('')
  const [bannerSaving, setBannerSaving] = useState(false)

  // Admin step: sync
  const [sourceCount, setSourceCount] = useState(0)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    if (!isAdmin) { setPwStatusLoading(false); return }
    api.get('/settings/master-password/status').then(r => setPwSet(!!r.data?.isSet)).catch(() => {}).finally(() => setPwStatusLoading(false))
    api.get('/settings/announcement').then(r => setBanner(r.data || '')).catch(() => {})
    api.get('/admin/root-folders').then(r => setSourceCount(r.data.length)).catch(() => {})
  }, [isAdmin])

  // Persist the profile (this flips isProfileCompleted) then show success + redirect.
  // Must run LAST — completing the profile earlier would bounce us out of onboarding.
  const finishProfile = async () => {
    if (!profileValid) { setBirthdayTouched(true); setCurrent(0); return }
    setSaving(true)
    try {
      await api.post('/auth/complete-profile', {
        displayName: displayName.trim(),
        birthday: birthday || null,
      })
      await refreshUser()
      setShowSuccess(true)
      setTimeout(() => { setShowSuccess(false); navigate('/') }, 3000)
    } catch {
      message.error('Lưu hồ sơ thất bại')
    }
    setSaving(false)
  }

  const saveMasterPassword = async () => {
    if (!pwNew.trim()) { message.warning('Vui lòng nhập master password'); return false }
    if (pwNew !== pwConfirm) { message.warning('Mật khẩu xác nhận không khớp'); return false }
    setPwSaving(true)
    try {
      await api.post('/settings/master-password', { newPassword: pwNew })
      setPwSet(true)
      message.success('Đã đặt master password')
      return true
    } catch (e: any) {
      message.error(e?.response?.data?.message || 'Đặt master password thất bại')
      return false
    } finally {
      setPwSaving(false)
    }
  }

  const saveBanner = async () => {
    setBannerSaving(true)
    try {
      await api.put('/settings/announcement', { value: banner })
      message.success('Đã lưu banner')
    } catch {
      message.error('Lưu banner thất bại')
    }
    setBannerSaving(false)
  }

  const syncNow = async () => {
    setSyncing(true)
    try {
      const { data: folders } = await api.get('/admin/root-folders')
      for (const f of folders) await api.post(`/admin/root-folders/${f.id}/sync`)
      message.success('Đang đồng bộ tất cả sources')
    } catch {
      message.error('Đồng bộ thất bại')
    }
    setSyncing(false)
  }

  const profileStep = {
    key: 'profile',
    title: 'Hồ sơ',
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Tên hiển thị</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Nhập tên bạn muốn hiển thị" style={inputStyle} />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>⚠️ Chỉ được đổi tên 1 lần duy nhất</p>
        </div>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Ngày sinh</label>
          <input
            type="date" value={birthday} max={new Date().toISOString().slice(0, 10)}
            onChange={e => setBirthday(e.target.value)} onBlur={() => setBirthdayTouched(true)}
            style={{ ...inputStyle, border: `1px solid ${birthdayTouched && birthdayError ? 'var(--red)' : 'var(--border)'}` }}
          />
          {birthdayTouched && birthdayError && (
            <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="ms" style={{ fontSize: 14 }}>error</span>{birthdayError}
            </p>
          )}
        </div>
      </div>
    ),
  }

  const masterPasswordStep = {
    key: 'master-password',
    title: 'Master password',
    content: pwStatusLoading ? (
      <div style={{ textAlign: 'center', padding: 40 }}><span className="ms spin" style={{ fontSize: 24, color: 'var(--accent)' }}>progress_activity</span></div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Master password dùng cho công cụ scramble ảnh. Hash lưu ở server chỉ để kiểm tra bạn gõ đúng, không giải mã được.
        </p>
        {pwSet ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--green)' }}>
            <span className="ms" style={{ fontSize: 18 }}>check_circle</span> Master password đã được đặt.
          </div>
        ) : (
          <>
            <Input.Password value={pwNew} onChange={e => setPwNew(e.target.value)} placeholder="Master password" disabled={pwSaving} />
            <Input.Password value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} placeholder="Xác nhận master password" disabled={pwSaving} />
          </>
        )}
      </div>
    ),
  }

  const bannerStep = {
    key: 'banner',
    title: 'Banner',
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Nội dung hiển thị trên banner chạy ở trang chủ. Để trống nếu chưa cần. (Tuỳ chọn)
        </p>
        <Input.TextArea value={banner} onChange={e => setBanner(e.target.value)} rows={4} placeholder="Nội dung thông báo..." />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={saveBanner} loading={bannerSaving} style={{ borderRadius: 20, height: 36 }}>Lưu banner</Button>
        </div>
      </div>
    ),
  }

  const syncStep = {
    key: 'sync',
    title: 'Đồng bộ',
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ms" style={{ fontSize: 20, color: 'var(--accent)' }}>cloud_sync</span>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600 }}>Google Drive</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sourceCount > 0 ? `${sourceCount} source cần đồng bộ` : 'Chưa có source nào'}</p>
          </div>
        </div>
        {sourceCount > 0 && (
          <Button onClick={syncNow} loading={syncing} type="primary" style={{ borderRadius: 20, height: 40 }}>
            {syncing ? 'Đang đồng bộ...' : 'Đồng bộ ngay'}
          </Button>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Bạn có thể đồng bộ sau trong trang Quản trị. (Tuỳ chọn)</p>
      </div>
    ),
  }

  const finishStep = {
    key: 'finish',
    title: 'Hoàn tất',
    content: (
      <div style={{ textAlign: 'center', padding: '24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 48 }}>🎉</span>
        <p style={{ fontSize: 15, fontWeight: 600 }}>Mọi thứ đã sẵn sàng!</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 360 }}>
          Nhấn "Hoàn tất" để lưu hồ sơ và bắt đầu {isAdmin ? 'quản trị' : 'đọc truyện'}.
        </p>
      </div>
    ),
  }

  // Everyone gets profile + finish; admins get the three setup steps in between.
  const steps = isAdmin
    ? [profileStep, masterPasswordStep, bannerStep, syncStep, finishStep]
    : [profileStep, finishStep]

  const stepKey = steps[current].key
  const isLast = current === steps.length - 1

  // Gate advancing per step: profile must be valid; master password must be set.
  const handleNext = async () => {
    if (stepKey === 'profile') {
      setBirthdayTouched(true)
      if (!profileValid) return
    }
    if (stepKey === 'master-password' && !pwSet) {
      const ok = await saveMasterPassword()
      if (!ok) return
    }
    setCurrent(c => c + 1)
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          {user?.avatarUrl && <img src={user.avatarUrl} style={{ width: 64, height: 64, borderRadius: '50%', border: '3px solid var(--accent)', marginBottom: 12 }} />}
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{isAdmin ? 'Thiết lập quản trị 🎉' : 'Chào mừng! 🎉'}</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Hoàn tất các bước để bắt đầu</p>
        </div>

        <Steps current={current} items={steps.map(s => ({ title: s.title }))} size="small" style={{ marginBottom: 28 }} />

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, minHeight: 200 }}>
          {steps[current].content}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <Button onClick={() => setCurrent(c => c - 1)} disabled={current === 0 || saving || pwSaving} style={{ borderRadius: 20, height: 40 }}>Quay lại</Button>
          {isLast ? (
            <Button type="primary" onClick={finishProfile} loading={saving} style={{ borderRadius: 20, height: 40 }}>Hoàn tất</Button>
          ) : (
            <Button type="primary" onClick={handleNext} loading={pwSaving} style={{ borderRadius: 20, height: 40 }}>Tiếp</Button>
          )}
        </div>
      </div>

      {showSuccess && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', animation: 'fadeIn 0.3s ease' }}>
          <div style={{ textAlign: 'center', animation: 'scaleIn 0.4s cubic-bezier(.4,0,.2,1)' }}>
            <span style={{ fontSize: 56, display: 'block', marginBottom: 16 }}>📖✨</span>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Chúc bạn đọc truyện vui vẻ!</h2>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>Đang chuyển hướng...</p>
          </div>
        </div>
      )}
    </div>
  )
}
