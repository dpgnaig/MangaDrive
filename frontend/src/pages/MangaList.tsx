import { useEffect, useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Swiper, SwiperSlide } from 'swiper/react'
import { Autoplay, Pagination, Navigation } from 'swiper/modules'
import 'swiper/swiper-bundle.css'
import * as signalR from '@microsoft/signalr'
import { Alert, BorderBeam } from 'antd'
import { imgUrl } from '../lib/img'
import api from '../lib/api'
import AppLayout from '../components/AppLayout'
import { MangaGridSkeleton, CarouselSkeleton } from '../components/Skeleton'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Vừa xong'
  if (mins < 60) return `${mins} phút trước`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} giờ trước`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ngày trước`
  return new Date(dateStr).toLocaleDateString()
}

interface Manga { id: string; title: string; author: string; coverImageFileId: string; bannerImageFileId: string; chapterCount: number; latestChapter: string | null; latestChapterNumber: string | null; updatedAt: string; genres: string; status: string; viewCount: number; isNSFW: boolean | null }
interface ContinueItem { id: string; mangaId: string; title: string; coverImageFileId: string; chapterId: string; chapterName: string }

export default function MangaList() {
  const [announcement, setAnnouncement] = useState('')
  const [recentMangas, setRecentMangas] = useState<Manga[]>([])
  const [continueList, setContinueList] = useState<ContinueItem[]>([])
  const [allMangas, setAllMangas] = useState<Manga[]>([])
  const [sort, setSort] = useState('title')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const observerRef = useRef<HTMLDivElement>(null)
  const [syncingManga, setSyncingManga] = useState<string>('') // currentMangaId being synced
  const syncingRef = useRef<string>('')

  // SignalR: track which manga is currently syncing
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder().withUrl('/hubs/sync', { accessTokenFactory: () => localStorage.getItem('token') || '' }).withAutomaticReconnect().build()
    conn.start()
    conn.on('SyncProgress', (p: { status: string; currentMangaId: string | null }) => {
      const id = p.status === 'Running' ? (p.currentMangaId || '') : ''
      if (id !== syncingRef.current) {
        syncingRef.current = id
        setSyncingManga(id)
      }
    })
    return () => { conn.stop() }
  }, [])

  // Initial load
  useEffect(() => {
    setError(null)
    setLoading(true)
    api.get('/settings/announcement').then(r => setAnnouncement(r.data || '')).catch(() => {})
    Promise.all([
      api.get('/mangas/paginated?page=1&pageSize=6&sort=updated'),
      api.get('/continue-reading'),
    ]).then(([recentRes, continueRes]) => {
      setRecentMangas(recentRes.data.items)
      setContinueList(continueRes.data)
    }).catch(err => {
      if (err.response?.status === 403) setError(err.response?.data?.message || 'Không có quyền truy cập')
    }).finally(() => setLoading(false))
  }, [])

  // Load "Tất cả" section with filter/sort
  const loadAll = useCallback(async (p: number, reset = false) => {
    if (p === 1) setLoadingMore(false)
    else setLoadingMore(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: '20', sort })
      const { data } = await api.get(`/mangas/paginated?${params}`)
      setAllMangas(prev => reset ? data.items : [...prev, ...data.items])
      setHasMore(data.hasMore)
      setPage(p)
    } catch { /* ignore */ }
    setLoadingMore(false)
  }, [sort])

  // Load first page of "Tất cả" on mount and when filter changes
  useEffect(() => {
    loadAll(1, true)
  }, [sort])

  // Infinite scroll observer
  useEffect(() => {
    const el = observerRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) {
        loadAll(page + 1)
      }
    }, { threshold: 0.1 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, page, loadAll])

  const removeContinue = async (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    await api.delete(`/continue-reading/${id}`).catch(() => {})
    setContinueList(prev => prev.filter(c => c.id !== id))
  }

  return (
    <AppLayout maxWidth={1100} showSider={false}>
      <div className="narrow-feed">

      {/* Announcement Banner */}
      {announcement.trim() && (
        <Alert
          banner
          style={{ marginBottom: 16, borderRadius: 8, overflow: 'hidden' }}
          message={
            <div className="marquee-container">
              <div className="marquee-content">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, paddingRight: 48 }}>
                  <span className="ms" style={{ fontSize: 16 }}>campaign</span>
                  {announcement}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, paddingRight: 48 }}>
                  <span className="ms" style={{ fontSize: 16 }}>campaign</span>
                  {announcement}
                </span>
              </div>
            </div>
          }
        />
      )}

      {/* Banner Swiper - cuutruyen style */}
      {loading ? <CarouselSkeleton /> : !error && recentMangas.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <Swiper
            modules={[Autoplay, Pagination, Navigation]}
            speed={600}
            autoplay={{ delay: 5000, disableOnInteraction: false }}
            navigation
            loop={recentMangas.slice(0, 5).length > 1}
            spaceBetween={12}
            slidesPerView={1.15}
            centeredSlides
            className="banner-swiper"
          >
            {recentMangas.slice(0, 5).map(m => {
              const bannerSrc = m.bannerImageFileId ? imgUrl(m.bannerImageFileId) : m.coverImageFileId ? imgUrl(m.coverImageFileId) : ''
              return (
                <SwiperSlide key={m.id}>
                  <Link to={`/manga/${m.id}`}>
                    <div className="banner-slide" style={{ position: 'relative', overflow: 'hidden', borderRadius: 12 }}>
                      {/* Full banner image */}
                      {bannerSrc && <img src={bannerSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                      {/* Bottom gradient */}
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '50%', background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, transparent 100%)' }} />
                      {/* Text content bottom-left */}
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '16px 20px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                          <p style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>{m.title}</p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {(m.latestChapterNumber || m.latestChapter) && <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.latestChapterNumber ? `Ch. ${m.latestChapterNumber}` : m.latestChapter}</span>}
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>• {timeAgo(m.updatedAt)}</span>
                          </div>
                        </div>
                        <span className="banner-btn">XEM THÔNG TIN</span>
                      </div>
                    </div>
                  </Link>
                </SwiperSlide>
              )
            })}
          </Swiper>
        </section>
      )}

      {/* Continue Reading */}
      {continueList.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="ms" style={{ color: 'var(--accent)' }}>play_circle</span>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Đọc tiếp</h2>
          </div>
          <Swiper
            modules={[Navigation]}
            navigation
            slidesPerView="auto"
            spaceBetween={12}
            className="card-swiper"
          >
            {continueList.map(c => (
              <SwiperSlide key={c.id} style={{ width: 'auto' }}>
                <Link to={`/chapter/${c.chapterId}`} className="carousel-card">
                  <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', position: 'relative' }}>
                    <div style={{ aspectRatio: '2/3', position: 'relative', background: 'var(--bg-hover)' }}>
                      {c.coverImageFileId && <img src={imgUrl(c.coverImageFileId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />}
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 8px 8px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
                        <p style={{ fontSize: 11, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
                        <p style={{ fontSize: 10, color: 'var(--accent)', marginTop: 2 }}>{c.chapterName}</p>
                      </div>
                      <div style={{ position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span className="ms" style={{ fontSize: 14, color: '#fff' }}>play_arrow</span>
                      </div>
                      <button onClick={(e) => removeContinue(e, c.id)}
                        style={{ position: 'absolute', top: 6, left: 6, width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,0,0,0.7)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
                        <span className="ms" style={{ fontSize: 14, color: '#fff' }}>close</span>
                      </button>
                    </div>
                  </div>
                </Link>
              </SwiperSlide>
            ))}
          </Swiper>
        </section>
      )}

      {/* Mới cập nhật - Swiper */}
      {!loading && !error && recentMangas.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="ms" style={{ color: 'var(--accent)' }}>schedule</span>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Mới cập nhật</h2>
          </div>
          <Swiper
            modules={[Navigation]}
            navigation
            slidesPerView="auto"
            spaceBetween={12}
            className="card-swiper"
          >
            {recentMangas.map(m => (
              <SwiperSlide key={m.id} style={{ width: 'auto' }}>
                <Link to={`/manga/${m.id}`} className="carousel-card">
                  {syncingManga && syncingManga === m.id ? (
                  <BorderBeam color={[{ color: 'var(--accent)', percent: 0 }, { color: '#36cfc9', percent: 100 }]} duration={3} size={60} lineWidth={2}>
                  <div className="manga-card">
                    <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                      {m.coverImageFileId
                        ? <img src={imgUrl(m.coverImageFileId)} alt={m.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                        : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span></div>}
                      {m.isNSFW === true && (
                        <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--red, #e5484d)', color: '#fff' }}>NSFW</span>
                      )}
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '32px 10px 10px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)', marginBottom: 4 }}>{m.title}</p>
                        {(m.latestChapterNumber || m.latestChapter) && <p style={{ fontSize: 11, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.latestChapterNumber ? `Ch. ${m.latestChapterNumber}` : m.latestChapter}</p>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{timeAgo(m.updatedAt)}</span>
                          {m.viewCount > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 2 }}><span className="ms" style={{ fontSize: 12 }}>visibility</span>{m.viewCount}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                  </BorderBeam>
                  ) : (
                  <div className="manga-card">
                    <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                      {m.coverImageFileId
                        ? <img src={imgUrl(m.coverImageFileId)} alt={m.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                        : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span></div>}
                      {m.isNSFW === true && (
                        <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--red, #e5484d)', color: '#fff' }}>NSFW</span>
                      )}
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '32px 10px 10px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)', marginBottom: 4 }}>{m.title}</p>
                        {(m.latestChapterNumber || m.latestChapter) && <p style={{ fontSize: 11, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.latestChapterNumber ? `Ch. ${m.latestChapterNumber}` : m.latestChapter}</p>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{timeAgo(m.updatedAt)}</span>
                          {m.viewCount > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 2 }}><span className="ms" style={{ fontSize: 12 }}>visibility</span>{m.viewCount}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                  )}
                </Link>
              </SwiperSlide>
            ))}
          </Swiper>
        </section>
      )}

      {/* Error state */}
      {error && (
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)', display: 'block', marginBottom: 12 }}>error</span>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>{error}</p>
          <button onClick={() => window.location.reload()}
            style={{ padding: '10px 24px', borderRadius: 8, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Thử lại
          </button>
        </div>
      )}

      {/* Tất cả - with sort + infinite scroll */}
      {!error && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="ms" style={{ color: 'var(--accent)' }}>local_fire_department</span>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Tất cả</h2>
            <select value={sort} onChange={e => setSort(e.target.value)}
              style={{ marginLeft: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 20, padding: '6px 12px', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
              <option value="updated">Mới cập nhật</option>
              <option value="newest">Mới thêm</option>
              <option value="title">Tên A-Z</option>
            </select>
          </div>

          {/* Two horizontal carousels per batch */}
          {loading ? <MangaGridSkeleton /> : (
            <>
              {(() => {
                // Split allMangas into chunks of 10, each chunk = 1 carousel row
                const rows: Manga[][] = []
                for (let i = 0; i < allMangas.length; i += 10) {
                  rows.push(allMangas.slice(i, i + 10))
                }
                return rows.map((row, idx) => (
                  <Swiper
                    key={idx}
                    modules={[Navigation]}
                    navigation
                    slidesPerView="auto"
                    spaceBetween={12}
                    className="card-swiper"
                    style={{ marginBottom: 16 }}
                  >
                    {row.map(m => (
                      <SwiperSlide key={m.id} style={{ width: 'auto' }}>
                        <Link to={`/manga/${m.id}`} className="carousel-card">
                          {syncingManga && syncingManga === m.id ? (
                          <BorderBeam color={[{ color: 'var(--accent)', percent: 0 }, { color: '#36cfc9', percent: 100 }]} duration={3} size={60} lineWidth={2}>
                          <div className="manga-card">
                            <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                              {m.coverImageFileId
                                ? <img src={imgUrl(m.coverImageFileId)} alt={m.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span></div>}
                              {m.isNSFW === true && (
                                <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--red, #e5484d)', color: '#fff' }}>NSFW</span>
                              )}
                              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '32px 10px 10px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
                                <p style={{ fontSize: 13, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)', marginBottom: 3 }}>{m.title}</p>
                                {(m.latestChapterNumber || m.latestChapter) && <p style={{ fontSize: 11, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.latestChapterNumber ? `Ch. ${m.latestChapterNumber}` : m.latestChapter}</p>}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{timeAgo(m.updatedAt)}</span>
                                  {m.viewCount > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 2 }}><span className="ms" style={{ fontSize: 12 }}>visibility</span>{m.viewCount}</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                          </BorderBeam>
                          ) : (
                          <div className="manga-card">
                            <div style={{ aspectRatio: '2/3', background: 'var(--bg-hover)', position: 'relative' }}>
                              {m.coverImageFileId
                                ? <img src={imgUrl(m.coverImageFileId)} alt={m.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="ms" style={{ fontSize: 40, color: 'var(--text-muted)' }}>auto_stories</span></div>}
                              {m.isNSFW === true && (
                                <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--red, #e5484d)', color: '#fff' }}>NSFW</span>
                              )}
                              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '32px 10px 10px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
                                <p style={{ fontSize: 13, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)', marginBottom: 3 }}>{m.title}</p>
                                {(m.latestChapterNumber || m.latestChapter) && <p style={{ fontSize: 11, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.latestChapterNumber ? `Ch. ${m.latestChapterNumber}` : m.latestChapter}</p>}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{timeAgo(m.updatedAt)}</span>
                                  {m.viewCount > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 2 }}><span className="ms" style={{ fontSize: 12 }}>visibility</span>{m.viewCount}</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                          )}
                        </Link>
                      </SwiperSlide>
                    ))}
                  </Swiper>
                ))
              })()}
              {/* Loading more indicator */}
              {loadingMore && (
                <div style={{ textAlign: 'center', padding: 20 }}>
                  <span className="ms spin" style={{ fontSize: 24, color: 'var(--accent)' }}>progress_activity</span>
                </div>
              )}
              {/* Intersection observer trigger */}
              <div ref={observerRef} style={{ height: 1 }} />
              {!hasMore && allMangas.length > 0 && (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Đã hiển thị tất cả</p>
              )}
            </>
          )}
        </section>
      )}

      </div>
    </AppLayout>
  )
}
