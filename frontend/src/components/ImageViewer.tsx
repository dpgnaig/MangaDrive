import { useRef, useEffect, useState, useCallback } from 'react'

interface ImageViewerProps {
  src: string
  alt: string
  onClose: () => void
}

/**
 * Full-screen image viewer with pinch-to-zoom and pan.
 * Opens as an overlay when user taps an image in ChapterReader.
 */
export default function ImageViewer({ src, alt, onClose }: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [isZoomed, setIsZoomed] = useState(false)

  // Touch state
  const touchState = useRef({
    lastDist: 0,
    lastCenter: { x: 0, y: 0 },
    isPinching: false,
    startTranslate: { x: 0, y: 0 },
    startTouch: { x: 0, y: 0 },
    isPanning: false,
  })

  const resetZoom = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setIsZoomed(false)
  }, [])

  // Double tap to zoom/reset
  const lastTap = useRef(0)
  const handleTap = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      // Double tap
      if (isZoomed) {
        resetZoom()
      } else {
        setScale(2.5)
        setIsZoomed(true)
      }
      e.preventDefault()
    } else if (!isZoomed && scale <= 1) {
      // Single tap on non-zoomed → close after short delay (to not conflict with double tap)
      const tapTimeout = setTimeout(() => {
        if (Date.now() - lastTap.current >= 280) onClose()
      }, 300)
      lastTap.current = now
      return () => clearTimeout(tapTimeout)
    }
    lastTap.current = now
  }, [isZoomed, scale, onClose, resetZoom])

  // Touch handlers for pinch-zoom and pan
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      touchState.current.lastDist = Math.hypot(dx, dy)
      touchState.current.lastCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      }
      touchState.current.isPinching = true
    } else if (e.touches.length === 1 && scale > 1) {
      touchState.current.isPanning = true
      touchState.current.startTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      touchState.current.startTranslate = { ...translate }
    }
  }, [scale, translate])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchState.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.hypot(dx, dy)
      const ratio = dist / touchState.current.lastDist
      const newScale = Math.min(5, Math.max(1, scale * ratio))
      setScale(newScale)
      setIsZoomed(newScale > 1)
      touchState.current.lastDist = dist
    } else if (e.touches.length === 1 && touchState.current.isPanning && scale > 1) {
      e.preventDefault()
      const dx = e.touches[0].clientX - touchState.current.startTouch.x
      const dy = e.touches[0].clientY - touchState.current.startTouch.y
      setTranslate({
        x: touchState.current.startTranslate.x + dx,
        y: touchState.current.startTranslate.y + dy,
      })
    }
  }, [scale])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    touchState.current.isPinching = false
    touchState.current.isPanning = false
    if (scale <= 1) {
      resetZoom()
    }
  }, [scale, resetZoom])

  // Prevent body scroll while viewer is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      ref={containerRef}
      onClick={e => { if (e.target === containerRef.current && !isZoomed) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.95)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        touchAction: 'none',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Close button */}
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        style={{
          position: 'absolute', top: 12, right: 12, zIndex: 10,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)', border: 'none',
          color: '#fff', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(8px)',
        }}
      >
        <span className="ms" style={{ fontSize: 20 }}>close</span>
      </button>

      {/* Zoom indicator */}
      {isZoomed && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          padding: '4px 12px', borderRadius: 20,
          background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, fontWeight: 500,
          backdropFilter: 'blur(4px)',
        }}>
          {Math.round(scale * 100)}%
        </div>
      )}

      {/* Image */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onTouchEnd={handleTap as any}
        style={{
          maxWidth: '100%',
          maxHeight: '100vh',
          objectFit: 'contain',
          transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
          transition: touchState.current.isPinching || touchState.current.isPanning ? 'none' : 'transform 0.2s ease-out',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
        draggable={false}
      />
    </div>
  )
}
