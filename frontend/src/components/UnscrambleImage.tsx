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
    if (!inView) return
    let cancelled = false

    const loadAndUnscramble = async () => {
      try {
        const response = await fetch(src, { credentials: 'include' })
        if (!response.ok || cancelled) return

        const blob = await response.blob()
        if (cancelled) return

        const objectUrl = URL.createObjectURL(blob)
        const img = new Image()

        img.onload = () => {
          if (cancelled) { URL.revokeObjectURL(objectUrl); return }

          const canvas = canvasRef.current
          if (!canvas) { URL.revokeObjectURL(objectUrl); return }

          const { key, grid } = scrambleConfig
          const tileWidth = Math.floor(img.width / grid)
          const tileHeight = Math.floor(img.height / grid)

          canvas.width = img.width
          canvas.height = img.height

          const ctx = canvas.getContext('2d')
          if (!ctx) { URL.revokeObjectURL(objectUrl); return }

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
          URL.revokeObjectURL(objectUrl)
        }

        img.onerror = () => URL.revokeObjectURL(objectUrl)
        img.src = objectUrl
      } catch {
        // Network error
      }
    }

    loadAndUnscramble()
    return () => { cancelled = true }
  }, [src, scrambleConfig, inView])

  const blockDefault = (e: React.SyntheticEvent) => e.preventDefault()

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
      {!loaded && inView && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <span className="ms spin" style={{ fontSize: 24, color: 'var(--text-muted)' }}>progress_activity</span>
        </div>
      )}
    </div>
  )
}
