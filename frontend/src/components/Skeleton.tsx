import './Skeleton.css'

export function SkeletonBox({ width, height, radius = 8, style }: { width?: string | number; height?: string | number; radius?: number; style?: React.CSSProperties }) {
  return <div className="skeleton-pulse" style={{ width, height, borderRadius: radius, ...style }} />
}

/**
 * CarouselSkeleton: Simulates the banner Swiper with slidesPerView=1.15 + centeredSlides
 * The center slide is full opacity, side slides are dimmed (like the real .banner-swiper)
 */
export function CarouselSkeleton() {
  return (
    <div style={{ overflow: 'hidden', marginBottom: 24 }}>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center' }}>
        {/* Left partial slide (dimmed) */}
        <div style={{ flex: '0 0 7.5%', maxWidth: '7.5%', opacity: 0.5 }}>
          <div className="banner-slide" style={{ borderRadius: 12, overflow: 'hidden', position: 'relative', background: 'var(--bg-elevated)' }}>
            <SkeletonBox width="100%" height="100%" radius={0} />
          </div>
        </div>
        {/* Center slide (main) */}
        <div style={{ flex: '0 0 85%', maxWidth: '85%' }}>
          <div className="banner-slide" style={{ borderRadius: 12, overflow: 'hidden', position: 'relative', background: 'var(--bg-elevated)' }}>
            <SkeletonBox width="100%" height="100%" radius={0} />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, transparent 100%)' }}>
              <SkeletonBox width="55%" height={18} radius={6} style={{ background: 'rgba(255,255,255,0.12)' }} />
              <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
                <SkeletonBox width={90} height={14} radius={4} style={{ background: 'rgba(255,255,255,0.1)' }} />
                <SkeletonBox width={60} height={14} radius={4} style={{ background: 'rgba(255,255,255,0.08)' }} />
              </div>
            </div>
          </div>
        </div>
        {/* Right partial slide (dimmed) */}
        <div style={{ flex: '0 0 7.5%', maxWidth: '7.5%', opacity: 0.5 }}>
          <div className="banner-slide" style={{ borderRadius: 12, overflow: 'hidden', position: 'relative', background: 'var(--bg-elevated)' }}>
            <SkeletonBox width="100%" height="100%" radius={0} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * MangaCardSkeleton: Matches .carousel-card (140px width responsive)
 * with aspect-ratio 2/3 and bottom gradient overlay with title + chapter text
 */
export function MangaCardSkeleton() {
  return (
    <div className="carousel-card" style={{ flexShrink: 0 }}>
      <div className="manga-card">
        <div style={{ aspectRatio: '2/3', position: 'relative' }}>
          <SkeletonBox width="100%" height="100%" radius={0} />
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '32px 10px 10px', background: 'linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%)' }}>
            <SkeletonBox width="80%" height={13} radius={4} style={{ background: 'rgba(255,255,255,0.12)' }} />
            <SkeletonBox width="50%" height={10} radius={4} style={{ marginTop: 6, background: 'rgba(255,255,255,0.08)' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * MangaGridSkeleton: Simulates the horizontal Swiper card rows in MangaList "Tất cả" section.
 * Uses horizontal scrolling row of cards (matching card-swiper look) instead of grid.
 */
export function MangaGridSkeleton({ rows = 2, cardsPerRow = 6 }: { rows?: number; cardsPerRow?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} style={{ display: 'flex', gap: 12, overflow: 'hidden' }}>
          {Array.from({ length: cardsPerRow }).map((_, i) => <MangaCardSkeleton key={i} />)}
        </div>
      ))}
    </div>
  )
}

/**
 * MangaListSkeleton: Full page skeleton for MangaList page.
 * Includes: banner carousel + section header + card rows
 */
export function MangaListSkeleton() {
  return (
    <div>
      {/* Banner carousel */}
      <CarouselSkeleton />

      {/* "Mới cập nhật" section */}
      <section style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <SkeletonBox width={18} height={18} radius={4} />
          <SkeletonBox width={110} height={16} radius={4} />
        </div>
        <div style={{ display: 'flex', gap: 12, overflow: 'hidden' }}>
          {Array.from({ length: 6 }).map((_, i) => <MangaCardSkeleton key={i} />)}
        </div>
      </section>

      {/* "Tất cả" section */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <SkeletonBox width={18} height={18} radius={4} />
          <SkeletonBox width={60} height={16} radius={4} />
          <div style={{ marginLeft: 'auto' }}>
            <SkeletonBox width={100} height={30} radius={20} />
          </div>
        </div>
        <MangaGridSkeleton rows={2} cardsPerRow={6} />
      </section>
    </div>
  )
}

/**
 * MangaDetailSkeleton: Matches the actual MangaDetail layout
 * - Banner (260px)
 * - Mobile fixed top bar
 * - Profile header overlapping banner (cover + title + buttons)
 * - Genres + Status
 * - Stats
 * - Two-column layout (sidebar + chapters)
 */
export function MangaDetailSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      {/* Banner */}
      <div style={{ position: 'relative', height: 260, overflow: 'hidden' }}>
        <SkeletonBox width="100%" height="100%" radius={0} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, var(--bg-base) 100%)' }} />
      </div>

      {/* Mobile fixed top bar */}
      <div className="mobile-only" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, background: 'rgba(13,13,13,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <SkeletonBox width={30} height={30} radius={15} />
        <SkeletonBox width="55%" height={14} radius={4} />
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 16px' }}>
        {/* Profile header overlapping banner */}
        <div style={{ marginTop: -140, position: 'relative', zIndex: 2, display: 'flex', gap: 20, alignItems: 'flex-end', marginBottom: 16 }}>
          {/* Cover */}
          <SkeletonBox width={140} height={210} radius={8} style={{ flexShrink: 0, border: '3px solid var(--bg-base)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }} />
          {/* Title + author + buttons */}
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
            <SkeletonBox width="75%" height={26} radius={5} />
            <SkeletonBox width="35%" height={14} radius={4} style={{ marginTop: 10 }} />
            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <SkeletonBox width={130} height={40} radius={8} />
              <SkeletonBox width={40} height={40} radius={8} />
            </div>
          </div>
        </div>

        {/* Genres + Status */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <SkeletonBox width={50} height={22} radius={4} />
          <SkeletonBox width={65} height={22} radius={4} />
          <SkeletonBox width={55} height={22} radius={4} />
          <SkeletonBox width={72} height={22} radius={4} />
        </div>

        {/* Stats line */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <SkeletonBox width={45} height={14} radius={4} />
          <SkeletonBox width={45} height={14} radius={4} />
        </div>

        {/* Two-column layout */}
        <div className="manga-detail-columns">
          {/* Sidebar: description + other titles */}
          <aside className="manga-detail-sidebar">
            <SkeletonBox width={50} height={12} radius={4} style={{ marginBottom: 10 }} />
            <SkeletonBox width="100%" height={14} radius={4} style={{ marginBottom: 6 }} />
            <SkeletonBox width="100%" height={14} radius={4} style={{ marginBottom: 6 }} />
            <SkeletonBox width="70%" height={14} radius={4} style={{ marginBottom: 20 }} />
            <SkeletonBox width={60} height={12} radius={4} style={{ marginBottom: 10 }} />
            <SkeletonBox width="90%" height={13} radius={4} style={{ marginBottom: 6 }} />
            <SkeletonBox width="80%" height={13} radius={4} />
          </aside>

          {/* Main: chapters */}
          <div className="manga-detail-main">
            {/* Chapters header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <SkeletonBox width={18} height={18} radius={4} />
              <SkeletonBox width={100} height={15} radius={4} />
            </div>

            {/* Chapter list */}
            <div style={{ borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '14px 14px', gap: 10, borderBottom: '1px solid var(--border)' }}>
                  <SkeletonBox width={18} height={18} radius={4} />
                  <SkeletonBox width={`${40 + (i % 3) * 15}%`} height={14} radius={4} style={{ flex: 1 }} />
                  <SkeletonBox width={28} height={12} radius={4} />
                  <SkeletonBox width={18} height={18} radius={4} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * ChapterReaderSkeleton: Matches the actual reader layout
 * - Dark background
 * - Fixed top bar with back button + chapter name
 * - Image placeholders (full width, aspect-ratio 2/3)
 * - Fixed bottom nav pill (liquid glass)
 */
export function ChapterReaderSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 48, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, background: 'rgba(20,20,20,0.5)', backdropFilter: 'blur(40px)', zIndex: 10, borderBottom: '0.5px solid rgba(255,255,255,0.1)' }}>
        <SkeletonBox width={32} height={32} radius={8} style={{ background: 'rgba(255,255,255,0.08)' }} />
        <SkeletonBox width="40%" height={14} radius={4} style={{ background: 'rgba(255,255,255,0.08)' }} />
      </div>

      {/* Image placeholders */}
      <div style={{ maxWidth: 820, width: '100%', margin: '48px auto 80px', display: 'flex', flexDirection: 'column' }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ width: '100%', aspectRatio: '2/3', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="ms spin" style={{ fontSize: 24, color: '#333' }}>progress_activity</span>
          </div>
        ))}
      </div>

      {/* Bottom bar — matches the full-width BottomNavBar shell (Prev / List / Next) */}
      <div className="lg-bottom-nav-container" style={{ zIndex: 50 }}>
        <nav className="lg-bottom-nav">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="lg-nav-item" style={{ pointerEvents: 'none' }}>
              <SkeletonBox width={24} height={24} radius={6} />
              <SkeletonBox width={i === 1 ? 28 : 36} height={10} radius={4} style={{ marginTop: 3 }} />
            </div>
          ))}
        </nav>
      </div>
    </div>
  )
}

/**
 * AdminSourcesSkeleton: Matches AdminRootFoldersTab layout
 * - Header with title + add button
 * - List of root folder cards (icon + name + description + action buttons)
 */
export function AdminSourcesSkeleton() {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SkeletonBox width={120} height={20} radius={4} />
        <SkeletonBox width={80} height={36} radius={20} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SkeletonBox width={20} height={20} radius={4} />
              <SkeletonBox width={20} height={20} radius={4} />
              <div style={{ flex: 1 }}>
                <SkeletonBox width="40%" height={14} radius={4} />
                <SkeletonBox width="60%" height={11} radius={4} style={{ marginTop: 8 }} />
              </div>
              <SkeletonBox width={30} height={30} radius={15} />
              <SkeletonBox width={30} height={30} radius={15} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * AdminUsersSkeleton: Matches AdminUsersTab layout
 * - Title
 * - User rows (avatar + name/email + action buttons)
 */
export function AdminUsersSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)' }}>
          <SkeletonBox width={38} height={38} radius={19} />
          <div style={{ flex: 1 }}>
            <SkeletonBox width="30%" height={14} radius={4} />
            <SkeletonBox width="50%" height={12} radius={4} style={{ marginTop: 6 }} />
          </div>
          <SkeletonBox width={30} height={30} radius={15} />
          <SkeletonBox width={30} height={30} radius={15} />
        </div>
      ))}
    </div>
  )
}

/**
 * FavoritesSkeleton: Matches Favorites page — grid of cover cards only.
 * (The page keeps its header static above the loading conditional.)
 */
export function FavoritesSkeleton() {
  return (
    <div className="manga-grid">
      {Array.from({ length: 12 }).map((_, i) => <MangaCardSkeleton key={i} />)}
    </div>
  )
}

/**
 * AdminSettingsSkeleton: Matches AdminSettingsTab — config card only.
 * (The page keeps its title static above the loading conditional.)
 */
export function AdminSettingsSkeleton() {
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <SkeletonBox width={18} height={18} radius={4} />
        <SkeletonBox width={80} height={14} radius={4} />
      </div>
      <SkeletonBox width="70%" height={12} radius={4} style={{ marginBottom: 12 }} />
      <SkeletonBox width="100%" height={92} radius={8} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <SkeletonBox width={72} height={36} radius={20} />
      </div>
    </div>
  )
}

/**
 * NotificationsSkeleton: Matches Notifications page list items.
 * The page renders its own "Thông báo" header above the loading conditional,
 * so this skeleton only covers the item list (no duplicate header).
 */
export function NotificationsSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ padding: '14px 16px', borderRadius: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <SkeletonBox width={20} height={20} radius={4} style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <SkeletonBox width={`${50 + (i % 3) * 15}%`} height={14} radius={4} style={{ marginBottom: 6 }} />
            <SkeletonBox width="80%" height={12} radius={4} style={{ marginBottom: 6 }} />
            <SkeletonBox width={90} height={10} radius={4} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * LibrarySkeleton: Matches Library page layout
 * - Tab buttons
 * - List items (thumbnail + title/subtitle)
 */
export function LibrarySkeleton() {
  return (
    <div>
      {/* Tab buttons */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <SkeletonBox width={90} height={34} radius={20} />
        <SkeletonBox width={90} height={34} radius={20} />
        <SkeletonBox width={80} height={34} radius={20} />
      </div>
      {/* List items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: 12, background: 'var(--bg-elevated)', borderRadius: 12, alignItems: 'center' }}>
            <SkeletonBox width={48} height={64} radius={6} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <SkeletonBox width={`${50 + (i % 3) * 15}%`} height={14} radius={4} />
              <SkeletonBox width="40%" height={12} radius={4} style={{ marginTop: 6 }} />
            </div>
            <SkeletonBox width={20} height={20} radius={4} />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * RequestChatSkeleton: Matches the request chat thread (member + admin).
 * Alternating message bubbles; the page renders its header above the
 * loading conditional, so this covers only the message area.
 */
export function RequestChatSkeleton() {
  const rows = [
    { mine: false, w: '60%' },
    { mine: true, w: '45%' },
    { mine: false, w: '72%' },
    { mine: true, w: '38%' },
    { mine: false, w: '55%' },
  ]
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 4px' }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: r.mine ? 'flex-end' : 'flex-start' }}>
          <SkeletonBox width={r.w} height={38} radius={14} />
          <SkeletonBox width={70} height={9} radius={4} style={{ marginTop: 4 }} />
        </div>
      ))}
    </div>
  )
}

/**
 * AdminConversationsSkeleton: Matches the admin conversation list rows
 * (avatar + name/preview + unread/status). Header stays static above.
 */
export function AdminConversationsSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)' }}>
          <SkeletonBox width={40} height={40} radius={20} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <SkeletonBox width={`${35 + (i % 3) * 15}%`} height={14} radius={4} />
            <SkeletonBox width="65%" height={12} radius={4} style={{ marginTop: 6 }} />
          </div>
          <SkeletonBox width={54} height={18} radius={10} />
        </div>
      ))}
    </div>
  )
}

/**
 * ConversationListSkeleton: Matches the messenger conversation rows
 * (transparent, 44px avatar + name/preview + time/unread on the right).
 * Used by the desktop popover and the mobile Messages list.
 */
export function ConversationListSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px' }}>
          <SkeletonBox width={44} height={44} radius={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <SkeletonBox width={`${40 + (i % 3) * 15}%`} height={13} radius={4} />
            <SkeletonBox width={`${55 + (i % 4) * 10}%`} height={11} radius={4} style={{ marginTop: 7 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            <SkeletonBox width={28} height={9} radius={4} />
            {i % 3 === 0 && <SkeletonBox width={18} height={18} radius={9} />}
          </div>
        </div>
      ))}
    </div>
  )
}
