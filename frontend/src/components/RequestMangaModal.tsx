import { useState } from 'react'
import { Modal } from 'antd'

/**
 * Collects a manga title + optional reference URL for a "request a manga" action.
 * onSubmit receives the pre-formatted content string ready to POST to /dm/requests.
 */
export default function RequestMangaModal({ open, onClose, onSubmit }: {
  open: boolean
  onClose: () => void
  onSubmit: (content: string) => Promise<void> | void
}) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const urlValid = !url.trim() || /^https?:\/\/.+/i.test(url.trim())
  const canSubmit = title.trim().length > 0 && urlValid && !submitting

  const reset = () => { setTitle(''); setUrl('') }
  const close = () => { reset(); onClose() }

  const submit = async () => {
    if (!canSubmit) return
    const t = title.trim()
    const u = url.trim()
    const content = u ? `${t}\nLink tham khảo: ${u}` : t
    setSubmitting(true)
    try {
      await onSubmit(content)
      close()
    } finally {
      setSubmitting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 42, borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--bg-base)', color: 'var(--text)', padding: '0 14px', fontSize: 14, outline: 'none',
  }

  return (
    <Modal open={open} onCancel={close} title="Tạo yêu cầu manga" centered footer={null} destroyOnClose width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Tên manga <span style={{ color: 'var(--red)' }}>*</span>
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="Nhập tên manga bạn muốn yêu cầu"
            autoFocus
            style={inputStyle}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
          />
        </div>
        <div>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            URL tham khảo
          </label>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="https://..."
            style={{ ...inputStyle, borderColor: url.trim() && !urlValid ? 'var(--red)' : 'var(--border)' }}
            onFocus={e => { if (!(url.trim() && !urlValid)) e.currentTarget.style.borderColor = 'var(--accent)' }}
            onBlur={e => e.currentTarget.style.borderColor = url.trim() && !urlValid ? 'var(--red)' : 'var(--border)'}
          />
          {url.trim() && !urlValid && (
            <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="ms" style={{ fontSize: 14 }}>error</span>URL phải bắt đầu bằng http:// hoặc https://
            </p>
          )}
        </div>
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            height: 44, borderRadius: 10, border: 'none', marginTop: 4,
            background: canSubmit ? 'var(--accent)' : 'var(--bg-hover)',
            color: canSubmit ? '#fff' : 'var(--text-muted)',
            fontSize: 14, fontWeight: 600, cursor: canSubmit ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
          <span className={`ms ${submitting ? 'spin' : ''}`} style={{ fontSize: 18 }}>{submitting ? 'progress_activity' : 'send'}</span>
          {submitting ? 'Đang gửi...' : 'Gửi yêu cầu'}
        </button>
      </div>
    </Modal>
  )
}
