import { useRef, useEffect, useState } from 'react'
import { generateInversePermutation } from '../lib/scramble'

interface ScrambleConfig {
  key: string
  grid: number
}

interface UnscrambleImageProps {
  src: string
  alt: string
  scrambleConfig: ScrambleConfig
}

// Cache permutation globally — same key+grid always produces same result
const permCache = new Map<string, number[]>()
function getCachedInversePerm(key: string, grid: number): number[] {
  const cacheKey = `${key}_${grid}`
  if (!permCache.has(cacheKey)) {
    permCache.set(cacheKey, generateInversePermutation(key, grid))
  }
  return permCache.get(cacheKey)!
}

export default function UnscrambleImage({ src, alt, scrambleConfig }: UnscrambleImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [inView, setInView] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const { key, grid } = scrambleConfig

  // Lazy load: only start fetching when element enters viewport
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '500px' } // Start loading 500px before visible
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setLoaded(false)
    setError(null)
  }, [src, key, grid])

  useEffect(() => {
    if (!inView) return
    let cancelled = false
    let objectUrl: string | null = null

    const loadAndUnscramble = async () => {
      try {
        const response = await fetch(src, { credentials: 'include' })
        if (cancelled) return
        if (!response.ok) { setError(`Không tải được ảnh (${response.status})`); return }

        const blob = await response.blob()
        if (cancelled) return

        objectUrl = URL.createObjectURL(blob)
        const img = new Image()

        img.onload = () => {
          if (cancelled) return
          try {
            const canvas = canvasRef.current
            if (!canvas) { setError('Không khởi tạo được canvas'); return }

            if (!key || !Number.isInteger(grid) || grid < 2) { setError('Cấu hình giải mã không hợp lệ'); return }

            const tileWidth = Math.floor(img.width / grid)
            const tileHeight = Math.floor(img.height / grid)
            if (tileWidth <= 0 || tileHeight <= 0) { setError('Ảnh quá nhỏ so với grid giải mã'); return }

            canvas.width = img.width
            canvas.height = img.height

            const ctx = canvas.getContext('2d')
            if (!ctx) { setError('Không khởi tạo được canvas 2D'); return }

            const inversePerm = getCachedInversePerm(key, grid)

            for (let destIdx = 0; destIdx < inversePerm.length; destIdx++) {
              const srcIdx = inversePerm[destIdx]
              const srcCol = srcIdx % grid
              const srcRow = Math.floor(srcIdx / grid)
              const destCol = destIdx % grid
              const destRow = Math.floor(destIdx / grid)

              ctx.drawImage(
                img,
                srcCol * tileWidth, srcRow * tileHeight, tileWidth, tileHeight,
                destCol * tileWidth, destRow * tileHeight, tileWidth, tileHeight
              )
            }

            setLoaded(true)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Lỗi giải mã ảnh')
          } finally {
            if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
          }
        }

        img.onerror = () => {
          if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
          if (!cancelled) setError('Không đọc được dữ liệu ảnh')
        }
        img.src = objectUrl
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Lỗi tải ảnh')
      }
    }

    loadAndUnscramble()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, key, grid, inView, retryVersion])

  const blockDefault = (e: React.SyntheticEvent) => e.preventDefault()
  const retry = () => { setError(null); setRetryVersion(v => v + 1) }

  return (
    <div ref={containerRef} style={{ position: 'relative', minHeight: loaded ? 'auto' : 400, background: loaded ? 'transparent' : '#111' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: 'auto',
          display: loaded ? 'block' : 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          pointerEvents: 'none'
        }}
        aria-label={alt}
        role="img"
      />
      {/* The canvas shows the unscrambled pixels, but "Save image as…" / drag would
          otherwise hand out that clean image. Overlay the raw (scrambled) source at
          opacity 0 so a right-click or drag targets THIS element — the saved file is
          the scrambled one from the server. (Screenshots / DevTools can't be stopped.) */}
      {loaded && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onDragStart={blockDefault}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: 0
          }}
        />
      )}
      {!loaded && error && inView && (
        <div style={{ height: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
          <span className="ms" style={{ fontSize: 28, color: 'var(--text-muted)' }}>broken_image</span>
          <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>{error}</p>
          <button
            type="button"
            onClick={retry}
            style={{ border: '1px solid rgba(255,255,255,0.22)', borderRadius: 18, padding: '7px 14px', background: 'rgba(255,255,255,0.08)', color: '#fff', cursor: 'pointer' }}
          >
            Thử lại
          </button>
        </div>
      )}
      {!loaded && !error && inView && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <span className="ms spin" style={{ fontSize: 24, color: 'var(--text-muted)' }}>progress_activity</span>
        </div>
      )}
    </div>
  )
}
