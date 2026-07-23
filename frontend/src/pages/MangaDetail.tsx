import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Modal, message } from 'antd'
import * as signalR from '@microsoft/signalr'
import api from '../lib/api'
import { imgUrl } from '../lib/img'
import { useAuth } from '../context/AuthContext'
import { MangaDetailSkeleton } from '../components/Skeleton'
import MetadataPickerModal from '../components/MetadataPickerModal'
import CommentInput from '../components/CommentInput'

interface Manga { id: string; title: string; otherTitles: string; description: string; author: string; status: string; genres: string; coverImageFileId: string; bannerImageFileId: string }
interface Chapter { id: string; name: string; sortOrder: number; imageCount: number; chapterNumber?: string | null; chapterName?: string | null }
interface ReactionCount { type: string; count: number }
interface Comment { id: string; content: string; userName: string; avatarUrl: string; createdAt: string; parentCommentId: string | null; reactions: ReactionCount[]; userReactions: string[] }

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥']

// Render comment content, turning "@[Name](userId)" mention tokens into highlighted
// spans. Everything else is plain text; split keeps the pieces in order.
function renderCommentContent(content: string) {
  const parts: React.ReactNode[] = []
  const re = /@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) parts.push(content.slice(last, m.index))
    parts.push(
      <span key={`m${key++}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>@{m[1]}</span>
    )
    last = m.index + m[0].length
  }
  if (last < content.length) parts.push(content.slice(last))
  return parts
}

function detectLang(text: string): string {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'JA'
  if (/[\uAC00-\uD7AF]/.test(text)) return 'KO'
  if (/[\u0E00-\u0E7F]/.test(text)) return 'TH'
  if (/[\u0600-\u06FF]/.test(text)) return 'AR'
  if (/[\u0400-\u04FF]/.test(text)) return 'RU'
  if (/[\u0900-\u097F]/.test(text)) return 'HI'
  if (/[\u4E00-\u9FFF]/.test(text)) return 'ZH'
  if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(text)) return 'VI'
  if (/[äöüß]/i.test(text)) return 'DE'
  if (/[ąćęłńóśźż]/i.test(text)) return 'PL'
  if (/[ğışüöç]/i.test(text)) return 'TR'
  if (/[ãõâêô]/i.test(text) && /[çã]/.test(text)) return 'PT'
  if (/[éèêëàâùûçœæî]/i.test(text)) return 'FR'
  if (/[ñ¿¡]/i.test(text)) return 'ES'
  if (/[åæø]/i.test(text)) return 'NO'
  return 'EN'
}

function CommentItem({ comment: c, onReply, onReact, isReply, compact }: {
  comment: Comment
  onReply: (c: Comment) => void
  onReact: (commentId: string, type: string) => void
  isReply?: boolean
  compact?: boolean
}) {
  const [showPicker, setShowPicker] = useState(false)
  const avatarSize = compact ? 28 : 36
  return (
    <div style={{ display: 'flex', gap: 10, padding: isReply ? '8px 10px' : '12px 14px', background: isReply ? 'transparent' : 'var(--bg-elevated)', borderRadius: isReply ? 8 : 12, border: isReply ? 'none' : '1px solid var(--border)' }}>
      <img src={c.avatarUrl} style={{ width: avatarSize, height: avatarSize, borderRadius: '50%', flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{c.userName}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(c.createdAt).toLocaleString()}</span>
        </div>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5, wordBreak: 'break-word', marginBottom: 6 }}>{renderCommentContent(c.content)}</p>
        {/* Reactions + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {c.reactions?.filter(r => r.count > 0).map(r => (
            <button key={r.type} onClick={() => onReact(c.id, r.type)}
              style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 12, border: '1px solid var(--border)', background: c.userReactions?.includes(r.type) ? 'var(--accent-subtle)' : 'var(--bg-hover)', fontSize: 12, cursor: 'pointer', color: c.userReactions?.includes(r.type) ? 'var(--accent)' : 'var(--text-secondary)' }}>
              <span>{r.type}</span><span style={{ fontWeight: 500 }}>{r.count}</span>
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowPicker(!showPicker)}
              style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-hover)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="ms" style={{ fontSize: 14, color: 'var(--text-muted)' }}>add_reaction</span>
            </button>
            {showPicker && (
              <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, display: 'flex', gap: 4, padding: '6px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 20, boxShadow: 'var(--shadow-md)', zIndex: 10 }}>
                {REACTION_EMOJIS.map(emoji => (
                  <button key={emoji} onClick={() => { onReact(c.id, emoji); setShowPicker(false) }}
                    style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => onReply(c)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px', borderRadius: 4 }}>
            <span className="ms" style={{ fontSize: 14 }}>reply</span>Trả lời
          </button>
        </div>
      </div>
    </div>
  )
}

const ITEM_H = 52

export default function MangaDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [manga, setManga] = useState<Manga | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [isFavorite, setIsFavorite] = useState(false)
  const [showReorder, setShowReorder] = useState(false)
  const [reorderList, setReorderList] = useState<Chapter[]>([])
  const [showImportNames, setShowImportNames] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [showMetadata, setShowMetadata] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [replyTo, setReplyTo] = useState<Comment | null>(null)
  const { user } = useAuth()
  const connRef = useRef<signalR.HubConnection | null>(null)

  useEffect(() => {
    api.get(`/mangas/${id}`).then(r => setManga(r.data))
    api.get(`/mangas/${id}/chapters`).then(r => setChapters(r.data.sort((a: Chapter, b: Chapter) => b.sortOrder - a.sortOrder)))
    api.get(`/mangas/${id}/comments`).then(r => setComments(r.data))
    api.get(`/favorites/check/${id}`).then(r => setIsFavorite(r.data.isFavorite))
  }, [id])

  // Listen for sync completion to reload chapters
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder().withUrl('/hubs/sync', { accessTokenFactory: () => localStorage.getItem('token') || '' }).withAutomaticReconnect().build()
    conn.start()
    conn.on('SyncProgress', (p: { status: string; currentMangaId: string | null }) => {
      if (p.status === 'Completed' || (p.currentMangaId === id && p.status !== 'Running')) {
        // Reload chapters after sync completes
        api.get(`/mangas/${id}/chapters`).then(r => setChapters(r.data.sort((a: Chapter, b: Chapter) => b.sortOrder - a.sortOrder))).catch(() => {})
      }
    })
    return () => { conn.stop() }
  }, [id])

  const toggleFav = async () => {
    const { data } = await api.post(`/favorites/${id}`)
    setIsFavorite(data.isFavorite)
  }

  const startEditTitle = () => {
    setTitleDraft(manga!.title)
    setEditingTitle(true)
  }

  const cancelEditTitle = () => setEditingTitle(false)

  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next || next === manga!.title) { setEditingTitle(false); return }
    setSavingTitle(true)
    try {
      await api.patch(`/admin/mangas/${id}/title`, { title: next })
      setManga(prev => prev ? { ...prev, title: next } : prev)
      setEditingTitle(false)
      message.success('Đã đổi tên manga')
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Đổi tên thất bại')
    }
    setSavingTitle(false)
  }

  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/comments`, { accessTokenFactory: () => localStorage.getItem('token') || '' })
      .withAutomaticReconnect().build()
    conn.start().then(() => conn.invoke('JoinMangaGroup', id))
    conn.on('NewComment', (c: Comment) => setComments(prev => [c, ...prev]))
    conn.on('ReactionUpdated', (data: { commentId: string; reactions: ReactionCount[]; userId: string; type: string; added: boolean }) => {
      setComments(prev => prev.map(c => {
        if (c.id !== data.commentId) return c
        const userReactions = data.userId === user?.id
          ? (data.added ? [...c.userReactions, data.type] : c.userReactions.filter(r => r !== data.type))
          : c.userReactions
        return { ...c, reactions: data.reactions, userReactions }
      }))
    })
    connRef.current = conn
    return () => { conn.stop() }
  }, [id])

  const submitComment = async (content: string) => {
    if (!content.trim()) return
    // Always reply to top-level parent (keep nesting at 1 level)
    const parentId = replyTo ? (replyTo.parentCommentId || replyTo.id) : null
    await api.post(`/mangas/${id}/comments`, { content, parentId })
    setReplyTo(null)
  }

  const toggleReaction = async (commentId: string, type: string) => {
    const { data } = await api.post(`/comments/${commentId}/reactions`, { type })
    setComments(prev => prev.map(c => {
      if (c.id !== commentId) return c
      const userReactions = data.added
        ? [...c.userReactions, type]
        : c.userReactions.filter((r: string) => r !== type)
      return { ...c, reactions: data.reactions, userReactions }
    }))
  }

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop), [])

  if (!manga) return <MangaDetailSkeleton />

  const genres = (() => { try { return JSON.parse(manga.genres) as string[] } catch { return [] } })()
  const otherTitles = (() => {
    try {
      const parsed = JSON.parse(manga.otherTitles)
      // Support both formats: [{lang, title}] and ["string"]
      return parsed.map((item: any) => typeof item === 'string' ? { lang: '', title: item } : item) as { lang: string; title: string }[]
    } catch { return [] }
  })()
  const coverUrl = manga.coverImageFileId ? imgUrl(manga.coverImageFileId) : ''
  const bannerUrl = manga.bannerImageFileId ? imgUrl(manga.bannerImageFileId) : coverUrl
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_H) - 2)
  const endIdx = Math.min(chapters.length, startIdx + 24)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column' }}>

      {/* === COVER BANNER === */}
      <div style={{ position: 'relative', height: 260, overflow: 'hidden', flexShrink: 0 }}>
        {bannerUrl ? (
          <img src={bannerUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' }} />
        )}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, var(--bg-base) 100%)' }} />

        {/* Back button inside banner */}
        <button className="desktop-only" onClick={() => navigate('/')}
          style={{ position: 'absolute', top: 12, left: 12, width: 38, height: 38, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <span className="ms" style={{ fontSize: 20 }}>arrow_back</span>
        </button>
      </div>

      {/* Mobile fixed top bar */}
      <div className="mobile-only" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, background: 'rgba(13,13,13,0.9)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text)' }}>
          <span className="ms" style={{ fontSize: 22 }}>arrow_back</span>
        </button>
        <p style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{manga.title}</p>
      </div>

      {/* === MAIN CONTENT === */}
      <div style={{ maxWidth: 1100, width: '100%', margin: '0 auto', padding: '0 16px', flex: 1 }}>

        {/* === PROFILE HEADER (overlapping banner) === */}
        <div style={{ marginTop: -140, position: 'relative', zIndex: 2, display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 16 }}>
          {/* Cover image */}
          <div style={{ width: 140, aspectRatio: '2/3', borderRadius: 8, overflow: 'hidden', border: '3px solid var(--bg-base)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)', flexShrink: 0, background: 'var(--bg-elevated)' }}>
            {coverUrl ? (
              <img src={coverUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span>
              </div>
            )}
          </div>

          {/* Title + Author + Buttons */}
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
            {editingTitle ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') cancelEditTitle() }}
                  disabled={savingTitle}
                  style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--bg-elevated)', color: 'var(--text)', outline: 'none' }}
                />
                <button onClick={saveTitle} disabled={savingTitle} title="Lưu"
                  style={{ width: 32, height: 32, borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: savingTitle ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: savingTitle ? 0.6 : 1 }}>
                  <span className="ms" style={{ fontSize: 18 }}>check</span>
                </button>
                <button onClick={cancelEditTitle} disabled={savingTitle} title="Hủy"
                  style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: savingTitle ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="ms" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <h1 style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{manga.title}</h1>
                {user?.role === 'Admin' && (
                  <button onClick={startEditTitle} title="Đổi tên manga"
                    style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="ms" style={{ fontSize: 18 }}>edit</span>
                  </button>
                )}
              </div>
            )}
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>{manga.author || 'Unknown'}</p>

            {/* Action buttons */}
            <div className={`manga-actions${user?.role === 'Admin' ? ' manga-actions-admin' : ''}`}>
              {chapters.length > 0 && (
                <button className="manga-action-read" onClick={() => navigate(`/chapter/${chapters[chapters.length - 1].id}`)}
                  style={{ height: 40, padding: '0 20px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13, fontWeight: 600, boxShadow: '0 4px 12px rgba(255,107,44,0.3)' }}>
                  <span className="ms" style={{ fontSize: 18 }}>play_arrow</span>ĐỌC TỪ ĐẦU
                </button>
              )}
              <button className="manga-action-icon" onClick={toggleFav} title={isFavorite ? 'Bỏ thích' : 'Thêm vào thư viện'}
                style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid var(--border)', background: isFavorite ? 'var(--red)' : 'var(--bg-elevated)', color: isFavorite ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}>
                <span className="ms" style={{ fontSize: 20 }}>{isFavorite ? 'favorite' : 'favorite_border'}</span>
              </button>
              {user?.role === 'Admin' && (
                <button className="manga-action-icon" onClick={() => setShowMetadata(true)} title="Lấy metadata từ nguồn ngoài"
                  style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}>
                  <span className="ms" style={{ fontSize: 20 }}>travel_explore</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* === GENRES + STATUS LINE === */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {genres.map(g => (
            <span key={g} style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-secondary)', padding: '3px 8px', background: 'var(--bg-hover)', borderRadius: 4 }}>{g}</span>
          ))}
          {manga.status && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: manga.status === 'ongoing' ? 'var(--green)' : 'var(--accent)' }} />
              {manga.status.toUpperCase()}
            </span>
          )}
        </div>

        {/* === STATS LINE === */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, fontSize: 13, color: 'var(--text-muted)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="ms" style={{ fontSize: 16 }}>menu_book</span>{chapters.length}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="ms" style={{ fontSize: 16 }}>chat</span>{comments.length}
          </span>
        </div>

        {/* === TWO COLUMN: Metadata + Chapters === */}
        <div className="manga-detail-columns">

          {/* LEFT SIDEBAR: Metadata */}
          <aside className="manga-detail-sidebar">
            {/* Description */}
            {manga.description && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Mô tả</h3>
                <div
                  dangerouslySetInnerHTML={{ __html: showFullDesc ? manga.description : manga.description.slice(0, 200) + (manga.description.length > 200 ? '...' : '') }}
                  style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)' }}
                />
                {manga.description.length > 200 && (
                  <button onClick={() => setShowFullDesc(!showFullDesc)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', marginTop: 6, fontWeight: 500 }}>
                    {showFullDesc ? 'Thu gọn' : 'Xem thêm'}
                  </button>
                )}
              </div>
            )}

            {/* Alternative Titles with language detection */}
            {otherTitles.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Tên khác</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {otherTitles.map((t, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-hover)', padding: '1px 5px', borderRadius: 3, fontWeight: 500, flexShrink: 0, textTransform: 'uppercase' }}>{t.lang || detectLang(t.title)}</span>
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* RIGHT: Chapters */}
          <div className="manga-detail-main">

        {/* === CHAPTERS === */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="ms ms-sm" style={{ color: 'var(--accent)' }}>format_list_numbered</span>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Chapters ({chapters.length})</h2>
            {user?.role === 'Admin' && (
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setShowImportNames(true)}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="ms" style={{ fontSize: 16 }}>upload</span>Import tên
                </button>
                <button onClick={() => { setReorderList([...chapters]); setShowReorder(true) }}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="ms" style={{ fontSize: 16 }}>swap_vert</span>Sắp xếp
                </button>
              </div>
            )}
          </div>

          {/* Desktop: virtual scroll */}
          {chapters.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
              <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>menu_book</span>
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Chưa có chapter nào</p>
            </div>
          ) : (
          <>
          <div className="desktop-only" onScroll={onScroll} style={{ maxHeight: 700, overflowY: 'auto', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
            <div style={{ height: chapters.length * ITEM_H, position: 'relative' }}>
              {chapters.slice(startIdx, endIdx).map((c, i) => (
                <Link key={c.id} to={`/chapter/${c.id}`} style={{ position: 'absolute', top: (startIdx + i) * ITEM_H, left: 0, right: 0, height: ITEM_H, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10, borderBottom: '1px solid var(--border)' }}>
                  <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>bookmark</span>
                  <span style={{ flex: 1, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.chapterNumber
                      ? `Chương ${c.chapterNumber}${c.chapterName ? ` - ${c.chapterName}` : ''}`
                      : c.name}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{c.imageCount}p</span>
                  <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>chevron_right</span>
                </Link>
              ))}
            </div>
          </div>

          {/* Mobile: virtual scroll */}
          <div className="mobile-only" onScroll={onScroll} style={{ maxHeight: 600, overflowY: 'auto', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
            <div style={{ height: chapters.length * ITEM_H, position: 'relative' }}>
              {chapters.slice(startIdx, endIdx).map((c, i) => (
                <Link key={c.id} to={`/chapter/${c.id}`} style={{ position: 'absolute', top: (startIdx + i) * ITEM_H, left: 0, right: 0, height: ITEM_H, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10, borderBottom: '1px solid var(--border)' }}>
                  <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>bookmark</span>
                  <span style={{ flex: 1, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.chapterNumber
                      ? `Chương ${c.chapterNumber}${c.chapterName ? ` - ${c.chapterName}` : ''}`
                      : c.name}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{c.imageCount}p</span>
                  <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>chevron_right</span>
                </Link>
              ))}
            </div>
          </div>
          </>
          )}
        </section>

        {/* === COMMENTS (below chapters) === */}
        <section className="desktop-only" style={{ marginBottom: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span className="ms ms-sm" style={{ color: 'var(--accent)' }}>chat</span>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Bình luận ({comments.length})</h2>
          </div>

          {/* Top-level comment input */}
          {!replyTo && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              <CommentInput avatarUrl={user?.avatarUrl} placeholder="Viết bình luận..." onSubmit={submitComment} />
            </div>
          )}

          {/* Comment list - top level */}
          <div>
            {comments.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 20 }}>Chưa có bình luận nào</p>}
            {comments.filter(c => !c.parentCommentId).map(c => (
              <div key={c.id} style={{ marginBottom: 16 }}>
                <CommentItem comment={c} onReply={setReplyTo} onReact={toggleReaction} />
                {/* Replies */}
                {comments.filter(r => r.parentCommentId === c.id).map(r => (
                  <div key={r.id} style={{ marginLeft: 44, marginTop: 8 }}>
                    <CommentItem comment={r} onReply={setReplyTo} onReact={toggleReaction} isReply />
                  </div>
                ))}
                {/* Inline reply input */}
                {(replyTo?.id === c.id || replyTo?.parentCommentId === c.id) && (
                  <div style={{ marginLeft: 44, marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <CommentInput compact autoFocus placeholder={`Trả lời @${replyTo!.userName}...`} onSubmit={submitComment} onCancel={() => setReplyTo(null)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

          </div>{/* end manga-detail-main */}
        </div>{/* end manga-detail-columns */}

        {/* Mobile: comment button fixed */}
        <div className="mobile-only" style={{ marginBottom: 24 }}>
          <button onClick={() => setShowComments(true)}
            style={{ width: '100%', height: 44, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 500 }}>
            <span className="ms">chat</span>
            Bình luận ({comments.length})
          </button>
        </div>
      </div>

      {/* === FOOTER === */}

      {/* Comment Drawer (mobile) */}
      {/* Comment Bottom Sheet (mobile) */}
      {showComments && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300 }}>
          {/* Backdrop */}
          <div onClick={() => { setShowComments(false); setReplyTo(null) }} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} />
          {/* Sheet */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '85vh', background: 'var(--bg-base)', borderTopLeftRadius: 20, borderTopRightRadius: 20, display: 'flex', flexDirection: 'column', animation: 'slideUp 0.3s ease' }}>
            {/* Handle + Header */}
            <div style={{ padding: '12px 20px 8px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 12px' }} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: 16, fontWeight: 600 }}>Bình luận ({comments.length})</h3>
                <button onClick={() => { setShowComments(false); setReplyTo(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
                  <span className="ms" style={{ fontSize: 22 }}>close</span>
                </button>
              </div>
            </div>

            {/* Comment list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
              {comments.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                  <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>chat_bubble_outline</span>
                  <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Chưa có bình luận nào</p>
                </div>
              )}
              {comments.filter(c => !c.parentCommentId).map(c => (
                <div key={c.id} style={{ marginBottom: 12 }}>
                  <CommentItem comment={c} onReply={setReplyTo} onReact={toggleReaction} compact />
                  {comments.filter(r => r.parentCommentId === c.id).map(r => (
                    <div key={r.id} style={{ marginLeft: 32, marginTop: 6 }}>
                      <CommentItem comment={r} onReply={setReplyTo} onReact={toggleReaction} isReply compact />
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Input */}
            <div style={{ padding: '10px 16px', paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
              {replyTo && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 10px', background: 'var(--bg-hover)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span className="ms" style={{ fontSize: 14 }}>reply</span>
                  <span>@{replyTo.userName}</span>
                  <button onClick={() => setReplyTo(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>
                    <span className="ms" style={{ fontSize: 16 }}>close</span>
                  </button>
                </div>
              )}
              <CommentInput compact avatarUrl={user?.avatarUrl} placeholder={replyTo ? `Trả lời @${replyTo.userName}...` : 'Viết bình luận...'} onSubmit={submitComment} />
            </div>
          </div>
        </div>
      )}

      {/* Reorder modal (Admin) */}
      <Modal open={showReorder} onCancel={() => setShowReorder(false)} title="Kéo thả để sắp xếp" centered
        onOk={async () => { await api.post(`/admin/mangas/${id}/reorder-chapters`, reorderList.map(c => c.id)); setChapters([...reorderList]); setShowReorder(false) }}
        okText="Lưu" cancelText="Hủy" styles={{ body: { maxHeight: '60vh', overflowY: 'auto', padding: '4px 0' } }}>
        {reorderList.map((c, idx) => (
          <div key={c.id} draggable
            onDragStart={e => e.dataTransfer.setData('idx', String(idx))}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { const from = Number(e.dataTransfer.getData('idx')); const arr = [...reorderList]; const [item] = arr.splice(from, 1); arr.splice(idx, 0, item); setReorderList(arr) }}
            style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', gap: 10, cursor: 'grab', borderBottom: '1px solid var(--border)', transition: 'background 0.15s' }}
            onDragEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onDragLeave={e => (e.currentTarget.style.background = '')}
            onDragEnd={e => (e.currentTarget.style.background = '')}>
            <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>drag_indicator</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 20 }}>{idx + 1}</span>
            <span style={{ flex: 1, fontSize: 14 }}>{c.name}</span>
          </div>
        ))}
      </Modal>

      {/* Import chapter names modal (Admin) */}
      <Modal open={showImportNames} onCancel={() => { setShowImportNames(false); setImportJson('') }} title="Import tên chapter" centered
        footer={null} destroyOnClose styles={{ body: { maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 12 } }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Paste JSON với format: <code>[{`{ "label": "Ch.1 — Tên chapter" }`}]</code><br />
          Hoặc upload file .json. Số chapter trong label sẽ match với chapter hiện tại.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
            <span className="ms" style={{ fontSize: 16 }}>upload_file</span>Chọn file
            <input type="file" accept=".json" hidden onChange={e => {
              const file = e.target.files?.[0]
              if (file) {
                const reader = new FileReader()
                reader.onload = ev => setImportJson(ev.target?.result as string || '')
                reader.readAsText(file)
              }
            }} />
          </label>
          {importJson && <span style={{ fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}><span className="ms" style={{ fontSize: 14 }}>check_circle</span>Đã load</span>}
        </div>
        <textarea
          value={importJson}
          onChange={e => setImportJson(e.target.value)}
          placeholder='[{ "label": "Ch.1 — Tên chapter" }, ...]'
          style={{ width: '100%', minHeight: 180, flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)', fontSize: 12, fontFamily: 'monospace', outline: 'none', resize: 'vertical' }}
          onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
        />
        {importJson && (() => {
          try {
            const parsed = JSON.parse(importJson)
            const items = Array.isArray(parsed) ? parsed : []
            return <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tìm thấy {items.length} mục</p>
          } catch {
            return <p style={{ fontSize: 12, color: 'var(--red)' }}>JSON không hợp lệ</p>
          }
        })()}
        <button
          disabled={importLoading || !importJson.trim()}
          onClick={async () => {
            try {
              const parsed = JSON.parse(importJson)
              const items = (Array.isArray(parsed) ? parsed : []).map((item: any) => ({ label: item.label || item.name || '' })).filter((i: any) => i.label)
              if (items.length === 0) return
              setImportLoading(true)
              const { data } = await api.post(`/admin/mangas/${id}/import-chapter-names`, items)
              setShowImportNames(false)
              setImportJson('')
              // Reload chapters
              const res = await api.get(`/mangas/${id}/chapters`)
              setChapters(res.data.sort((a: Chapter, b: Chapter) => b.sortOrder - a.sortOrder))
              alert(`Đã cập nhật ${data.updated}/${data.total} chapter` + (data.skipped > 0 ? ` (${data.skipped} không match)` : ''))
            } catch (err: any) {
              alert(err.response?.data?.message || 'Lỗi import')
            }
            setImportLoading(false)
          }}
          style={{ padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: importLoading ? 'not-allowed' : 'pointer', opacity: (importLoading || !importJson.trim()) ? 0.6 : 1 }}
        >
          {importLoading ? 'Đang import...' : 'Import'}
        </button>
      </Modal>

      {/* Metadata picker (Admin) */}
      {user?.role === 'Admin' && (
        <MetadataPickerModal
          open={showMetadata}
          onClose={() => setShowMetadata(false)}
          mangaId={id!}
          initialQuery={manga.title}
          onApplied={() => api.get(`/mangas/${id}`).then(r => setManga(r.data))}
        />
      )}
    </div>
  )
}
