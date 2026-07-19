import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Modal, message } from 'antd'
import api from '../lib/api'
import { imgUrl } from '../lib/img'
import { ChapterReaderSkeleton } from '../components/Skeleton'
import UnscrambleImage from '../components/UnscrambleImage'
import ImageViewer from '../components/ImageViewer'
import BottomNavBar from '../components/BottomNavBar'

interface ChapterDetail {
  id: string; mangaId: string; name: string; sortOrder: number
  images: { id: string; driveFileId: string; fileName: string; sortOrder: number }[]
  isScrambled?: boolean
}
interface ChapterNav { id: string; name: string; sortOrder: number }

function LazyImage({ src, alt, onTap }: { src: string; alt: string; onTap: () => void }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div style={{ minHeight: loaded ? 'auto' : 400, background: loaded ? 'transparent' : '#111' }} onClick={onTap}>
      <img src={src} alt={alt} onLoad={() => setLoaded(true)}
        className="reader-img" style={{ width: '100%', display: 'block' }} loading="lazy" decoding="async" />
    </div>
  )
}

export default function ChapterReader() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [chapter, setChapter] = useState<ChapterDetail | null>(null)
  const [chapters, setChapters] = useState<ChapterNav[]>([])
  const [showUI, setShowUI] = useState(true)
  const [showChapterList, setShowChapterList] = useState(false)
  const [viewerImage, setViewerImage] = useState<{ src: string; alt: string } | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reporting, setReporting] = useState(false)

  useEffect(() => {
    api.get(`/chapters/${id}`).then(r => {
      setChapter(r.data)
      api.get(`/mangas/${r.data.mangaId}/chapters`).then(res =>
        setChapters(res.data.sort((a: ChapterNav, b: ChapterNav) => a.sortOrder - b.sortOrder)))
      api.post('/reading-progress', { mangaId: r.data.mangaId, chapterId: r.data.id, pageIndex: 0 }).catch(() => {})
    })
  }, [id])

  useEffect(() => {
    let t: number
    const auto = () => { t = window.setTimeout(() => setShowUI(false), 3000) }
    auto()
    const reset = () => { setShowUI(true); clearTimeout(t); auto() }
    window.addEventListener('scroll', reset)
    return () => { window.removeEventListener('scroll', reset); clearTimeout(t) }
  }, [])

  if (!chapter) return <ChapterReaderSkeleton />

  const currentIdx = chapters.findIndex(c => c.id === chapter.id)
  const prevChapter = currentIdx > 0 ? chapters[currentIdx - 1] : null
  const nextChapter = currentIdx < chapters.length - 1 ? chapters[currentIdx + 1] : null

  const openViewer = (src: string, alt: string) => {
    setViewerImage({ src, alt })
  }

  const submitReport = async () => {
    if (!reportReason.trim()) return
    setReporting(true)
    try {
      await api.post(`/chapters/${chapter.id}/report`, { reason: reportReason.trim() })
      message.success('Đã gửi báo lỗi tới admin')
      setReportOpen(false)
      setReportReason('')
    } catch {
      message.error('Không gửi được báo lỗi')
    }
    setReporting(false)
  }

  return (
    <div style={{ background: '#000', minHeight: '100vh' }} onClick={() => setShowUI(v => !v)}>
      {/* Top bar — static, always at the top of the page (not sticky) */}
      <div style={{
        position: 'relative', zIndex: 50,
        background: 'rgba(20,20,20,0.5)', backdropFilter: 'blur(40px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
        padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '0.5px solid rgba(255,255,255,0.1)'
      }}>
        <button className="icon-btn icon-btn-sm" onClick={e => { e.stopPropagation(); navigate(`/manga/${chapter.mangaId}`) }} style={{ background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)' }}>
          <span className="ms">arrow_back</span>
        </button>
        <p style={{ flex: 1, fontSize: 14, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chapter.name}</p>
        <button className="icon-btn icon-btn-sm" onClick={e => { e.stopPropagation(); setReportOpen(true) }} title="Báo lỗi" style={{ background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
          <span className="ms">flag</span>
        </button>
      </div>

      {/* Images */}
      <div style={{ maxWidth: 820, margin: '0 auto' }} onClick={e => e.stopPropagation()}>
        {chapter.images.map(img => (
          chapter.isScrambled && import.meta.env.VITE_SCRAMBLE_KEY
            ? <UnscrambleImage
                key={img.id}
                src={imgUrl(img.driveFileId)}
                alt={img.fileName}
                scrambleConfig={{ key: import.meta.env.VITE_SCRAMBLE_KEY, grid: Number(import.meta.env.VITE_SCRAMBLE_GRID) || 4 }}
              />
            : <LazyImage key={img.id} src={imgUrl(img.driveFileId)} alt={img.fileName}
                onTap={() => openViewer(imgUrl(img.driveFileId), img.fileName)} />
        ))}
      </div>

      {/* Bottom bar — reuses the shared BottomNavBar shell so Prev / List / Next
          stay visually in sync with the system BottomNav. */}
      <BottomNavBar
        onContainerClick={e => e.stopPropagation()}
        style={{
          zIndex: 50,
          transform: showUI ? 'translateY(0)' : 'translateY(calc(100% + 20px))',
          opacity: showUI ? 1 : 0,
          transition: 'transform 0.35s cubic-bezier(.4,0,.2,1), opacity 0.3s',
          pointerEvents: showUI ? 'auto' : 'none',
        }}
        items={[
          {
            key: 'prev',
            icon: 'skip_previous',
            label: 'Trước',
            disabled: !prevChapter,
            onClick: e => { e.stopPropagation(); if (prevChapter) navigate(`/chapter/${prevChapter.id}`) },
          },
          {
            key: 'list',
            icon: 'list',
            label: `${currentIdx + 1}/${chapters.length}`,
            onClick: e => { e.stopPropagation(); setShowChapterList(true) },
          },
          {
            key: 'next',
            icon: 'skip_next',
            label: 'Sau',
            disabled: !nextChapter,
            onClick: e => { e.stopPropagation(); if (nextChapter) navigate(`/chapter/${nextChapter.id}`) },
          },
        ]}
      />

      {/* Desktop: in-flow Prev / Next buttons below the pages */}
      <div className="desktop-only" style={{ maxWidth: 820, margin: '0 auto', padding: '16px 12px 40px', display: 'flex', gap: 12 }} onClick={e => e.stopPropagation()}>
        <button onClick={() => prevChapter && navigate(`/chapter/${prevChapter.id}`)} disabled={!prevChapter}
          style={{ flex: 1, height: 48, borderRadius: 12, border: '0.5px solid rgba(255,255,255,0.15)', background: prevChapter ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)', color: prevChapter ? '#fff' : 'rgba(255,255,255,0.25)', fontSize: 14, fontWeight: 600, cursor: prevChapter ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <span className="ms" style={{ fontSize: 20 }}>skip_previous</span>Chương trước
        </button>
        <button onClick={() => nextChapter && navigate(`/chapter/${nextChapter.id}`)} disabled={!nextChapter}
          style={{ flex: 1, height: 48, borderRadius: 12, border: 'none', background: nextChapter ? 'var(--accent)' : 'rgba(255,255,255,0.02)', color: nextChapter ? '#fff' : 'rgba(255,255,255,0.25)', fontSize: 14, fontWeight: 600, cursor: nextChapter ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          Chương sau<span className="ms" style={{ fontSize: 20 }}>skip_next</span>
        </button>
      </div>

      {/* Chapter selector drawer */}
      {showChapterList && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} onClick={e => { e.stopPropagation(); setShowChapterList(false) }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
          <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '70vh', background: 'var(--bg-surface)', borderTopLeftRadius: 16, borderTopRightRadius: 16, display: 'flex', flexDirection: 'column', animation: 'slideUp 0.3s ease' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>Chọn Chapter</span>
              <button className="icon-btn icon-btn-sm" onClick={() => setShowChapterList(false)}><span className="ms">close</span></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {chapters.map(c => (
                <button key={c.id} onClick={() => { navigate(`/chapter/${c.id}`); setShowChapterList(false) }}
                  style={{ width: '100%', padding: '14px 16px', background: c.id === chapter.id ? 'var(--accent-subtle)' : 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: c.id === chapter.id ? 'var(--accent)' : 'var(--text)', textAlign: 'left', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {c.id === chapter.id && <span className="ms ms-sm">play_arrow</span>}
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Image Viewer overlay (pinch-to-zoom) */}
      {viewerImage && (
        <ImageViewer src={viewerImage.src} alt={viewerImage.alt} onClose={() => setViewerImage(null)} />
      )}

      {/* Report chapter error modal */}
      <Modal open={reportOpen} onCancel={() => setReportOpen(false)} title="Báo lỗi chương" centered footer={null} destroyOnClose width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Mô tả lỗi bạn gặp (ảnh hỏng, sai thứ tự, thiếu trang...) để admin xử lý.</p>
          <textarea
            value={reportReason}
            onChange={e => setReportReason(e.target.value)}
            placeholder="Mô tả lỗi..."
            rows={4}
            autoFocus
            style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)', padding: '10px 14px', fontSize: 14, outline: 'none', resize: 'vertical' }}
          />
          <button onClick={submitReport} disabled={!reportReason.trim() || reporting}
            style={{ height: 44, borderRadius: 10, border: 'none', background: reportReason.trim() && !reporting ? 'var(--accent)' : 'var(--bg-hover)', color: reportReason.trim() && !reporting ? '#fff' : 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: reportReason.trim() && !reporting ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <span className={`ms ${reporting ? 'spin' : ''}`} style={{ fontSize: 18 }}>{reporting ? 'progress_activity' : 'flag'}</span>
            {reporting ? 'Đang gửi...' : 'Gửi báo lỗi'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
