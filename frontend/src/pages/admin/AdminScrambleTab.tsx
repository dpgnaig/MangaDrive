import { memo, useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import { Button, Progress, Select, Segmented, message } from 'antd'
import { generatePermutation, generateInversePermutation } from '../../lib/scramble'
import api from '../../lib/api'
import { connectDrive, disconnectDrive, createDriveFolder, findOrCreateMangaRootFolder, uploadDriveFile, shareWithServiceAccount, pickDriveFolder, findChildByName, downloadDriveFileText, updateDriveFileContent, trashDriveFile, abortAllDriveRequests, DRIVE_FOLDER_MIME } from '../../lib/googleDrive'

type Dest = 'local' | 'drive'

interface ChapterManifestEntry {
  original: string
  slug: string
  grid: number
  fileCount: number
  // Position of this chapter among ALL chapters in the input folder's natural
  // sort order (assigned once, at plan time — see chapterOrderRef). Chapters
  // upload concurrently on the Drive path, so array push order is completion
  // order, not natural order — sync must use this field instead of manifest
  // array index to get chapter ordering right. Optional so manifests written
  // before this field existed still parse; missing values fall back to
  // parsing a number out of the chapter name (see backend ExtractNumber).
  order?: number
}

type Mode = 'scramble' | 'unscramble'

// Per-chapter row state for the Drive upload progress list. Keyed by `name`
// (the original chapter folder name — stable across retries, unlike `slug`
// which is only assigned once upload actually starts).
type ChapterRunStatus = 'pending' | 'skipped' | 'uploading' | 'done' | 'error' | 'cancelled'

interface ChapterRunState {
  name: string
  fileCount: number
  status: ChapterRunStatus
  doneCount: number
  slug?: string
  error?: string
  // True while the row is playing its fade-out transition, just before it's
  // removed from chapterRuns — see scheduleAutoHide.
  fadingOut?: boolean
}

type ScrambleChapterFiles = { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }

// Run-scoped context shared across every chapter worker, kept alive in a ref so
// Retry can reuse it even after the initial runScrambleDrive() call has resolved.
interface DriveRunContext {
  driveMangaId: string
  manifestFileId: string
  manifestEntries: ChapterManifestEntry[]
  usedSlugs: Set<string>
  shareThisId: string
  // Natural-sort position of every chapter in the current input folder, keyed by
  // original folder name — written into each manifest entry's `order` field.
  chapterOrder: Map<string, number>
  slugMutex: Mutex
  manifestMutex: Mutex
}

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i

// How many images within a chapter upload concurrently. Total concurrent Drive
// requests ≈ chapterConcurrency (admin-selectable, see CHAPTER_CONCURRENCY_OPTIONS
// below) × IMAGE_CONCURRENCY.
const IMAGE_CONCURRENCY = 2

// Bounds for the admin-selectable "chapters upload concurrently" setting —
// replaces the old fixed CHAPTER_CONCURRENCY=2 ceiling so admins can trade
// off upload speed against how hard the run leans on Drive's rate limits.
const CHAPTER_CONCURRENCY_OPTIONS = [2, 3, 4, 5]
const DEFAULT_CHAPTER_CONCURRENCY = 2

// A handful of isolated chapter failures (bad image, transient hiccup)
// shouldn't stop the run. But failures in a row usually mean something
// systemic — server unavailable, network down, Drive quota exhausted — and
// blindly ploughing through the rest just repeats the same failure. Instead of
// aborting, the pool auto-pauses and waits for the admin to hit "Tiếp tục".
const MAX_CONSECUTIVE_FAILURES = 3

// The Drive upload list only needs to show what's actively in flight (plus
// pending/error rows the admin still needs to act on) — done/skipped/cancelled
// rows fade out and are removed after a short delay instead of piling up.
const AUTO_HIDE_DELAY_MS = 1500
const AUTO_HIDE_FADE_MS = 350

// Chapter row list virtualization: only mount rows near the visible scroll
// window instead of every chapter, so admin runs with hundreds/thousands of
// chapters don't force React to reconcile the whole list on every progress
// tick (each uploaded image patches one row's doneCount). ROW_SLOT bakes in
// the visual gap between rows so absolute-positioned rows still look spaced.
const CHAPTER_ROW_HEIGHT = 56
const CHAPTER_ROW_SLOT = 62
const CHAPTER_LIST_MAX_HEIGHT = 360
const CHAPTER_LIST_OVERSCAN = 4

// Minimal async mutex: runExclusive(fn) queues fn behind whatever is already
// running through this mutex, so calls never interleave. Used to serialize
// slug assignment and the manifest checkpoint write across concurrently
// uploading chapters — see processChapter below for why both need this.
type Mutex = <T>(fn: () => T | Promise<T>) => Promise<T>
function createMutex(): Mutex {
  let chain: Promise<void> = Promise.resolve()
  return function runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void
    const wait = chain
    chain = new Promise<void>(res => { release = res })
    return wait.then(fn).finally(release)
  }
}

// Run `worker` over `items` with at most `limit` in flight at once. Resolves
// when every item finishes. Once any worker throws, no runner picks up a new
// item, but items already in flight are allowed to finish first — this keeps
// other uploads from racing a chapter-folder trash triggered by the error.
// The first error is re-thrown once every runner has settled.
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  let firstError: unknown = null
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const i = next++
      try {
        await worker(items[i])
      } catch (e) {
        failed = true
        if (firstError === null) firstError = e
      }
    }
  })
  await Promise.all(runners)
  if (failed) throw firstError
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function newSlug(usedSlugs: Set<string>): string {
  while (true) {
    const bytes = new Uint8Array(6)
    crypto.getRandomValues(bytes)
    const slug = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    if (!usedSlugs.has(slug)) {
      usedSlugs.add(slug)
      return slug
    }
  }
}

async function deriveChapterKey(slug: string): Promise<string> {
  const { data } = await api.post('/admin/scramble/derive-key', { slug })
  return data.key
}

// Rearrange tiles of `bitmap` onto `ctx` using `perm`: output tile destIdx = source
// tile perm[destIdx]. Same math for scramble (forward perm) and unscramble (inverse
// perm) — only the permutation differs. Mirrors ImageProcessor.cs RearrangeTiles.
function drawTiles(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, perm: number[], grid: number) {
  const tileW = Math.floor(bitmap.width / grid)
  const tileH = Math.floor(bitmap.height / grid)
  for (let destIdx = 0; destIdx < perm.length; destIdx++) {
    const srcIdx = perm[destIdx]
    const srcCol = srcIdx % grid
    const srcRow = Math.floor(srcIdx / grid)
    const destCol = destIdx % grid
    const destRow = Math.floor(destIdx / grid)
    ctx.drawImage(
      bitmap,
      srcCol * tileW, srcRow * tileH, tileW, tileH,
      destCol * tileW, destRow * tileH, tileW, tileH
    )
  }
}

async function processToBlob(bitmap: ImageBitmap, perm: number[], grid: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  drawTiles(ctx, bitmap, perm, grid)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/png'
    )
  })
}

// Collect image files directly inside a directory handle, sorted by name.
async function readImageFiles(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
  const files: { name: string; handle: FileSystemFileHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && IMAGE_EXT.test(name)) {
      files.push({ name, handle: handle as FileSystemFileHandle })
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return files
}

// Collect direct subdirectories, sorted by name. Each = one chapter.
async function readSubDirs(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemDirectoryHandle }[]> {
  const dirs: { name: string; handle: FileSystemDirectoryHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      dirs.push({ name, handle: handle as FileSystemDirectoryHandle })
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return dirs
}

// Read + parse manifest.json at the root of a directory handle.
async function readManifest(dir: FileSystemDirectoryHandle): Promise<ChapterManifestEntry[]> {
  const handle = await dir.getFileHandle('manifest.json')
  const text = await (await handle.getFile()).text()
  return parseManifestStrict(text)
}

function isValidManifestEntry(e: unknown): e is ChapterManifestEntry {
  if (typeof e !== 'object' || e === null) return false
  const r = e as Record<string, unknown>
  return typeof r.original === 'string' && r.original.trim().length > 0 &&
    typeof r.slug === 'string' && r.slug.trim().length > 0 &&
    typeof r.grid === 'number' && Number.isInteger(r.grid) && r.grid > 1 &&
    typeof r.fileCount === 'number' && Number.isInteger(r.fileCount) && r.fileCount >= 0 &&
    (r.order === undefined || (typeof r.order === 'number' && Number.isInteger(r.order)))
}

function parseManifestStrict(text: string): ChapterManifestEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('manifest.json không phải JSON hợp lệ')
  }
  if (!Array.isArray(data)) throw new Error('manifest.json phải là một JSON array')
  for (let i = 0; i < data.length; i++) {
    const entry = data[i]
    if (!isValidManifestEntry(entry)) {
      throw new Error(`manifest.json có entry #${i + 1} không hợp lệ: original/slug phải khác rỗng, grid phải là số nguyên > 1 và fileCount phải là số nguyên >= 0`)
    }
  }
  return data as ChapterManifestEntry[]
}

// Returns the first key that appears twice, or null if all keys are unique.
// Used to reject an append target whose manifest has ambiguous entries before
// touching Drive.
function findDuplicateKey(entries: ChapterManifestEntry[], keyFn: (e: ChapterManifestEntry) => string): string | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    const k = keyFn(entry)
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}

// Copy/update the non-image files sitting directly at the input root
// (metadata.json, cover/banner images referenced by it) into the Drive manga
// folder, so sync's ApplyMetadata keeps the manga's title/cover. Chapter pages
// live in slug subfolders; anything loose at the root is metadata to carry
// over. We upload the original bytes (no scramble) — cover/banner are served
// as-is by /api/images. Upserts by name: if the manga folder already has a
// same-named file (re-running "Manga mới" into a folder that already exists
// from an earlier interrupted run), its content is overwritten in place via
// updateDriveFileContent instead of uploading a duplicate alongside it.
async function copyRootFilesToDrive(inputDir: FileSystemDirectoryHandle, driveMangaId: string): Promise<void> {
  for await (const [name, handle] of inputDir.entries()) {
    if (handle.kind !== 'file' || name === 'manifest.json') continue
    const blob = await (handle as FileSystemFileHandle).getFile()
    const existingId = await findChildByName(driveMangaId, name)
    if (existingId) {
      await updateDriveFileContent(existingId, blob)
    } else {
      await uploadDriveFile(name, blob, driveMangaId)
    }
  }
}

// Read + validate an existing manifest.json inside a Drive manga folder, if
// present. Returns null if the folder has no manifest.json yet (e.g. a
// freshly created folder). Shared by "append to existing manga" and by
// "Manga mới" landing on a folder that already exists from an earlier
// interrupted run — both need the same duplicate-entry validation before
// trusting the manifest.
async function readExistingManifest(driveMangaId: string): Promise<{ manifestFileId: string; entries: ChapterManifestEntry[] } | null> {
  const existingId = await findChildByName(driveMangaId, 'manifest.json')
  if (!existingId) return null
  const entries = parseManifestStrict(await downloadDriveFileText(existingId))
  const dupOriginal = findDuplicateKey(entries, e => e.original)
  if (dupOriginal) throw new Error(`manifest.json trên Drive có nhiều entry cùng tên chapter "${dupOriginal}" — không rõ entry nào đúng, dừng lại để tránh ghi đè sai.`)
  const dupSlug = findDuplicateKey(entries, e => e.slug)
  if (dupSlug) throw new Error(`manifest.json trên Drive có nhiều entry cùng slug "${dupSlug}" — dừng lại để tránh ghi đè sai.`)
  return { manifestFileId: existingId, entries }
}

// One row in the Drive upload progress list. Memoized so that when one
// chapter's doneCount ticks up, only that row's component re-renders instead
// of the whole visible window — chapterRuns is rebuilt as a new array on every
// update (see updateChapterRun), but unaffected chapter objects keep their old
// reference, so memo's shallow prop check bails out on them as long as
// onRetry/onCancel are stable (see the useCallback wrapping below).
const ChapterRunRow = memo(function ChapterRunRow({ chapter: c, onRetry, onCancel }: {
  chapter: ChapterRunState
  onRetry: (name: string) => void
  onCancel: (name: string) => void
}) {
  const icon = c.status === 'done' ? 'check_circle'
    : c.status === 'skipped' ? 'check_circle'
    : c.status === 'uploading' ? 'progress_activity'
    : c.status === 'error' ? 'error'
    : c.status === 'cancelled' ? 'cancel'
    : 'schedule'
  const color = c.status === 'done' ? 'var(--green, #4caf50)'
    : c.status === 'skipped' ? 'var(--text-muted)'
    : c.status === 'uploading' ? 'var(--accent)'
    : c.status === 'error' ? 'var(--red, #e5484d)'
    : 'var(--text-muted)'
  const pct = c.fileCount > 0 ? Math.round((c.doneCount / c.fileCount) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border)', height: CHAPTER_ROW_HEIGHT, boxSizing: 'border-box', opacity: c.fadingOut ? 0 : 1, transition: `opacity ${AUTO_HIDE_FADE_MS}ms ease` }}>
      <span className={c.status === 'uploading' ? 'ms spin' : 'ms'} style={{ fontSize: 18, color }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 500, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.name}{c.slug ? ` → ${c.slug}` : ''}
        </p>
        {c.status === 'uploading' && (
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-hover)', marginTop: 4 }}>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--accent)', width: `${pct}%`, transition: 'width 0.3s' }} />
          </div>
        )}
        {c.status === 'error' && c.error && (
          <p style={{ fontSize: 11, color: 'var(--red, #e5484d)', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.error}</p>
        )}
        {c.status === 'skipped' && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Đã có trên Drive</p>
        )}
        {c.status === 'cancelled' && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Đã hủy</p>
        )}
      </div>
      {c.status === 'error' && (
        <button className="icon-btn icon-btn-sm" onClick={() => onRetry(c.name)} title="Thử lại" style={{ color: 'var(--accent)' }}>
          <span className="ms">refresh</span>
        </button>
      )}
      {c.status === 'uploading' && (
        <button className="icon-btn icon-btn-sm" onClick={() => onCancel(c.name)} title="Hủy chapter này" style={{ color: 'var(--text-muted)' }}>
          <span className="ms">close</span>
        </button>
      )}
    </div>
  )
})

export default function AdminScrambleTab() {
  const [mode, setMode] = useState<Mode>('scramble')
  const [grid, setGrid] = useState(6)
  const [inputDir, setInputDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [outputDir, setOutputDir] = useState<FileSystemDirectoryHandle | null>(null)
  // Where scrambled output goes: a local folder (original flow) or straight up to
  // the admin's personal Drive. Unscramble is always local.
  const [dest, setDest] = useState<Dest>('local')
  // Drive scramble target: a brand-new manga (create run root + manga folder) or
  // append new chapters into an EXISTING manga folder picked via Google Picker.
  const [driveMode, setDriveMode] = useState<'new' | 'append'>('new')
  const [driveTarget, setDriveTarget] = useState<{ id: string; name: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [driveEmail, setDriveEmail] = useState<string | null>(null)
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [serviceEmail, setServiceEmail] = useState('')
  // How many chapters upload concurrently during a Drive scramble run — admin-selectable
  // between CHAPTER_CONCURRENCY_OPTIONS so they can trade upload speed against how hard
  // the run leans on Drive's rate limits.
  const [chapterConcurrency, setChapterConcurrency] = useState(DEFAULT_CHAPTER_CONCURRENCY)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('')
  // Icon paired with currentLabel so each run phase (scan/check/process/restore)
  // reads as a distinct step instead of a plain string that happens to change.
  const [currentIcon, setCurrentIcon] = useState('sync')
  const [elapsed, setElapsed] = useState(0)
  const cancelledRef = useRef(false)
  const startedRef = useRef(0)

  // Preview: two canvases (original + processed) drawn from the first image.
  const origCanvasRef = useRef<HTMLCanvasElement>(null)
  const procCanvasRef = useRef<HTMLCanvasElement>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  // Per-chapter progress rows for the Drive upload path (see ChapterRunState).
  // Populated right after the preflight skip-check so the full chapter list —
  // including already-skipped ones — is visible before any upload starts.
  const [chapterRuns, setChapterRuns] = useState<ChapterRunState[]>([])
  // Auto-pause banner text; non-null while the pool is paused after too many
  // consecutive chapter failures. Cleared by resumeFromPause().
  const [pausedInfo, setPausedInfo] = useState<string | null>(null)
  // Run-scoped context (manga folder id, manifest state, slug set, mutexes) kept
  // alive after the initial run finishes so Retry can reuse it standalone.
  const driveRunCtxRef = useRef<DriveRunContext | null>(null)
  // The full chapter scan from the run that's currently loaded, kept alive so
  // Retry can look up a chapter's files by name after the run has "finished".
  const allChapterFilesRef = useRef<ScrambleChapterFiles[]>([])
  // Mirrors chapterRuns state, kept in sync by updateChapterRun. Needed because
  // state updates are batched/async — code that runs right after `await`ing the
  // chapter pool (the final summary message) needs the up-to-date array
  // synchronously, not whatever `chapterRuns` was closed over when the run started.
  const chapterRunsRef = useRef<ChapterRunState[]>([])
  // Per-chapter AbortControllers, keyed by chapter name, so a per-row Cancel can
  // abort just that chapter's in-flight requests without touching others.
  const chapterControllersRef = useRef<Map<string, AbortController>>(new Map())
  // Set by the chapter pool when MAX_CONSECUTIVE_FAILURES is hit; cleared by resume.
  const pausedRef = useRef(false)
  const resumeWaitersRef = useRef<(() => void)[]>([])
  // Consecutive chapter failures across the current pool run (reset on any
  // success). Shared across concurrent workers — see processChapter.
  const consecutiveFailuresRef = useRef(0)

  // Blocks the calling worker until resumeFromPause() is called.
  const waitForPauseResume = (): Promise<void> =>
    new Promise<void>(res => resumeWaitersRef.current.push(res))

  // Unblocks every worker parked on waitForPauseResume, clears the paused banner,
  // and auto-retries the chapters whose failures triggered the pause — without
  // this, resuming only lets the queue continue with chapters it hadn't reached
  // yet, leaving the ones that caused the pause sitting in 'error' until the
  // admin manually hits Retry on each row.
  const resumeFromPause = () => {
    pausedRef.current = false
    setPausedInfo(null)
    const waiters = resumeWaitersRef.current
    resumeWaitersRef.current = []
    waiters.forEach(w => w())
    consecutiveFailuresRef.current = 0
    chapterRunsRef.current
      .filter(c => c.status === 'error')
      .forEach(c => { retryChapter(c.name) })
  }

  // Patch one chapter row by name, keeping chapterRunsRef in sync with state so
  // synchronous readers (the final summary message) always see the latest data.
  // Wrapped in useCallback (stable identity, no reactive deps — setChapterRuns
  // and chapterRunsRef are both stable across renders) so processChapter below
  // can depend on it without picking up a new identity every render.
  const updateChapterRun = useCallback((name: string, patch: Partial<ChapterRunState> | ((c: ChapterRunState) => Partial<ChapterRunState>)) => {
    setChapterRuns(prev => {
      const next = prev.map(c => c.name === name ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)
      chapterRunsRef.current = next
      return next
    })
  }, [])

  // Pending auto-hide timers per chapter (fade start + remove), keyed by name.
  // A row that gets retried before its hide fires (e.g. a fast cancel→retry)
  // needs its timers cancelled so a stale removal doesn't wipe the retried row.
  const autoHideTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map())

  const clearAutoHide = useCallback((name: string) => {
    const timers = autoHideTimersRef.current.get(name)
    if (timers) {
      timers.forEach(clearTimeout)
      autoHideTimersRef.current.delete(name)
    }
  }, [])

  // Rows that no longer need admin attention (done/skipped/cancelled) fade out
  // and then disappear from the list instead of piling up — only pending,
  // uploading, and error rows stay put (error rows need the Retry button).
  const scheduleAutoHide = useCallback((name: string) => {
    clearAutoHide(name)
    const fadeTimer = setTimeout(() => {
      updateChapterRun(name, { fadingOut: true })
      const removeTimer = setTimeout(() => {
        autoHideTimersRef.current.delete(name)
        setChapterRuns(prev => {
          const next = prev.filter(c => c.name !== name)
          chapterRunsRef.current = next
          return next
        })
      }, AUTO_HIDE_FADE_MS)
      autoHideTimersRef.current.set(name, [removeTimer])
    }, AUTO_HIDE_DELAY_MS)
    autoHideTimersRef.current.set(name, [fadeTimer])
  }, [clearAutoHide, updateChapterRun])

  useEffect(() => () => {
    autoHideTimersRef.current.forEach(timers => timers.forEach(clearTimeout))
    autoHideTimersRef.current.clear()
  }, [])

  useEffect(() => {
    // Service account email is needed so uploaded folders can be shared back to
    // the read-only account that /api/images proxies through.
    api.get('/admin/drive/service-account')
      .then(r => setServiceEmail(r.data?.email ?? ''))
      .catch(() => {})
  }, [])

  // Tick a 1s timer while a run is in flight so elapsed time / ETA / speed stay
  // live in the progress panel. startedRef is set at the top of each run.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setElapsed(Date.now() - startedRef.current), 1000)
    return () => clearInterval(id)
  }, [running])

  // Chapter row list virtualization: track scroll position so the render below
  // can mount only the rows near the visible window (see CHAPTER_ROW_* consts
  // above) instead of every chapter — a run with hundreds/thousands of chapters
  // would otherwise force React to keep that many DOM nodes mounted and
  // reconciled on every progress tick (one per uploaded image). rAF-throttled
  // so a fast scroll doesn't flood setState calls.
  const [chapterListScrollTop, setChapterListScrollTop] = useState(0)
  const chapterListScrollRafRef = useRef<number | null>(null)
  const onChapterListScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop
    if (chapterListScrollRafRef.current !== null) return
    chapterListScrollRafRef.current = requestAnimationFrame(() => {
      chapterListScrollRafRef.current = null
      setChapterListScrollTop(top)
    })
  }, [])
  useEffect(() => () => {
    if (chapterListScrollRafRef.current !== null) cancelAnimationFrame(chapterListScrollRafRef.current)
  }, [])

  // Connect (or switch) the personal Drive that scrambled output uploads into.
  // forceSelect shows Google's account chooser for a manual account switch.
  const connectDriveAccount = async (forceSelect: boolean) => {
    setDriveConnecting(true)
    try {
      const email = await connectDrive(forceSelect)
      setDriveEmail(email)
      message.success(email ? `Đã kết nối Drive: ${email}` : 'Đã kết nối Drive')
    } catch (e: any) {
      message.error(e?.message || 'Kết nối Drive thất bại')
    }
    setDriveConnecting(false)
  }

  const disconnectDriveAccount = () => {
    disconnectDrive()
    setDriveEmail(null)
    setDriveTarget(null)
  }

  // Pick an existing manga folder (from a prior scramble run) to append new
  // chapters into. Requires a connected Drive first — the Picker reuses that token.
  const pickTargetFolder = async () => {
    if (!driveEmail) { message.warning('Vui lòng kết nối Google Drive trước'); return }
    setPicking(true)
    try {
      const picked = await pickDriveFolder()
      if (picked) {
        setDriveTarget(picked)
        message.success(`Đã chọn manga đích: ${picked.name}`)
      }
    } catch (e: any) {
      message.error(e?.message || 'Chọn folder thất bại')
    }
    setPicking(false)
  }

  const pickInput = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'scramble-input' })
      setInputDir(handle)
      setPreviewReady(false)
    } catch { /* user cancelled */ }
  }

  const pickOutput = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'scramble-output', mode: 'readwrite' })
      setOutputDir(handle)
    } catch { /* user cancelled */ }
  }

  // Draw the first image (original + processed) into the preview canvases.
  // Scramble mode derives an illustrative HMAC key from a fixed preview slug,
  // following the same Phase 2 pipeline as a real randomly generated slug.
  // Unscramble mode reads the real slug+grid from manifest.json and reverses
  // the first image of the first chapter — a genuine check that the key unlocks it.
  const doPreview = async () => {
    if (!inputDir) { message.warning('Vui lòng chọn folder input'); return }
    setPreviewing(true)
    try {
      let fileHandle: FileSystemFileHandle | null = null
      let perm: number[]
      let g = grid

      if (mode === 'scramble') {
        const subDirs = await readSubDirs(inputDir)
        const firstDir = subDirs.length > 0 ? subDirs[0].handle : inputDir
        const files = await readImageFiles(firstDir)
        if (files.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }
        fileHandle = files[0].handle
        perm = generatePermutation(await deriveChapterKey('000000000000'), g)
      } else {
        const manifest = await readManifest(inputDir)
        if (manifest.length === 0) { message.warning('manifest.json không có chapter'); return }
        const entry = manifest[0]
        g = entry.grid
        const chapterDir = await inputDir.getDirectoryHandle(entry.slug)
        const files = await readImageFiles(chapterDir)
        if (files.length === 0) { message.warning('Chapter đầu tiên không có ảnh'); return }
        fileHandle = files[0].handle
        perm = generateInversePermutation(await deriveChapterKey(entry.slug), g)
      }

      const blob = await fileHandle.getFile()
      const bitmap = await createImageBitmap(blob)
      try {
        const orig = origCanvasRef.current
        const proc = procCanvasRef.current
        if (!orig || !proc) return
        orig.width = proc.width = bitmap.width
        orig.height = proc.height = bitmap.height
        const octx = orig.getContext('2d')
        const pctx = proc.getContext('2d')
        if (!octx || !pctx) return
        octx.drawImage(bitmap, 0, 0)
        drawTiles(pctx, bitmap, perm, g)
        setPreviewReady(true)
      } finally {
        bitmap.close()
      }
    } catch (e) {
      message.error(`Lỗi preview: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPreviewing(false)
    }
  }

  const runScramble = async () => {
    // Determine chapters: direct subfolders, or the input folder itself if it holds images directly.
    const subDirs = await readSubDirs(inputDir!)
    const chapters: { name: string; handle: FileSystemDirectoryHandle }[] =
      subDirs.length > 0 ? subDirs : [{ name: inputDir!.name, handle: inputDir! }]

    // Collect chapters that actually contain images.
    const chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[] = []
    for (const ch of chapters) {
      const files = await readImageFiles(ch.handle)
      if (files.length === 0) continue
      chapterFiles.push({ ...ch, files })
    }
    if (chapterFiles.length === 0) { message.warning('Không tìm thấy ảnh trong folder'); return }

    if (dest === 'local') {
      await runScrambleLocal(chapterFiles)
      return
    }

    await runScrambleDrive(chapterFiles)
  }

  // Local scramble: unchanged from the original flow — process every chapter,
  // write manifest.json once at the end. No skip/resume logic; local runs are
  // fast enough that resuming a partial run isn't worth the complexity here.
  const runScrambleLocal = async (
    chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[],
  ) => {
    const grandTotal = chapterFiles.reduce((sum, ch) => sum + ch.files.length, 0)
    setTotal(grandTotal)

    const manifest: ChapterManifestEntry[] = []
    const usedSlugs = new Set<string>()
    let processed = 0
    startedRef.current = Date.now()

    for (const ch of chapterFiles) {
      if (cancelledRef.current) break
      const slug = newSlug(usedSlugs)
      const key = await deriveChapterKey(slug)
      setCurrentLabel(`${ch.name} → ${slug}`)

      const outChapterDir = await outputDir!.getDirectoryHandle(slug, { create: true })
      const numbered = ch.files.map((file, i) => ({ file, seq: i + 1 }))

      for (const { file, seq } of numbered) {
        if (cancelledRef.current) break
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generatePermutation(key, grid)
          const outBlob = await processToBlob(bitmap, perm, grid)
          const fileName = `${String(seq).padStart(3, '0')}.png`
          const fileHandle = await outChapterDir.getFileHandle(fileName, { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(outBlob)
          await writable.close()
        } finally {
          bitmap.close()
        }
        processed++
        setDone(processed)
      }
      manifest.push({ original: ch.name, slug, grid, fileCount: ch.files.length, order: manifest.length })
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }

    const manifestHandle = await outputDir!.getFileHandle('manifest.json', { create: true })
    const manifestWritable = await manifestHandle.createWritable()
    await manifestWritable.write(JSON.stringify(manifest, null, 2))
    await manifestWritable.close()

    message.success(`Hoàn thành! ${manifest.length} chapter, ${processed} ảnh đã xáo.`)
  }

  // Uploads one chapter end-to-end: assign slug, create its Drive folder, upload
  // every image (IMAGE_CONCURRENCY in parallel), checkpoint the manifest, then
  // mark the row done. Self-contained — the pool scheduler calls this from the
  // queue, and Retry calls it directly for a single chapter after the run has
  // "finished". Never throws: every failure path (error, cancel) is recorded on
  // the chapter's row instead, so one bad chapter can't reject Promise.all and
  // take down sibling workers still uploading other chapters.
  const processChapter = useCallback(async (ch: ScrambleChapterFiles, ctx: DriveRunContext) => {
    const controller = new AbortController()
    chapterControllersRef.current.set(ch.name, controller)
    // Retrying a chapter that was already scheduled to fade out (e.g. a fast
    // cancel→retry) must cancel that pending hide, otherwise it can remove
    // the row out from under this fresh attempt.
    clearAutoHide(ch.name)
    updateChapterRun(ch.name, { status: 'uploading', doneCount: 0, error: undefined, fadingOut: false })
    // How many of this chapter's images have been counted toward the aggregate
    // `done` counter so far. If the chapter ends up error/cancelled, its folder
    // gets trashed below and none of those images survive — rolled back in the
    // catch/cancel branches so `done` doesn't overshoot `total` once a retry
    // re-uploads the same images from scratch.
    let chapterDone = 0

    try {
      // Slug assignment must be serialized: two chapters finishing their preflight
      // at nearly the same time could otherwise draw the same random slug before
      // either has added it to usedSlugs.
      const slug = await ctx.slugMutex(() => newSlug(ctx.usedSlugs))
      updateChapterRun(ch.name, { slug })
      const key = await deriveChapterKey(slug)
      const driveChapterId = await createDriveFolder(slug, ctx.driveMangaId, controller.signal)

      // Pair each file with its 1-based sequence up front, so output names stay
      // stable (001.png, 002.png…) even when uploads finish out of order.
      const numbered = ch.files.map((file, i) => ({ file, seq: i + 1 }))
      const processOne = async ({ file, seq }: { file: { name: string; handle: FileSystemFileHandle }; seq: number }) => {
        if (controller.signal.aborted || cancelledRef.current) return
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generatePermutation(key, grid)
          const outBlob = await processToBlob(bitmap, perm, grid)
          const fileName = `${String(seq).padStart(3, '0')}.png`
          await uploadDriveFile(fileName, outBlob, driveChapterId, controller.signal)
        } finally {
          bitmap.close()
        }
        chapterDone++
        updateChapterRun(ch.name, { doneCount: chapterDone })
        setDone(d => d + 1)
      }

      try {
        await runPool(numbered, IMAGE_CONCURRENCY, processOne)
      } catch (e) {
        // Upload failed partway through — the folder is incomplete and has no
        // manifest entry. Trash it so a retry doesn't leave an orphan for sync
        // to pick up, and doesn't collide with the folder Retry creates next.
        await trashDriveFile(driveChapterId).catch(cleanupErr => {
          message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
        })
        throw e
      }

      if (controller.signal.aborted || cancelledRef.current) {
        await trashDriveFile(driveChapterId).catch(cleanupErr => {
          message.error(`Không tự xóa được folder dở "${slug}" trên Drive, cần xóa tay: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
        })
        setDone(d => d - chapterDone)
        updateChapterRun(ch.name, { status: 'cancelled' })
        scheduleAutoHide(ch.name)
        return
      }

      // Checkpoint: append + persist the manifest under the mutex so two chapters
      // finishing around the same time can't both read-modify-write and silently
      // drop one entry (lost update).
      await ctx.manifestMutex(async () => {
        // Remove any stale entry for this chapter first — a retry after a
        // prior failed/cancelled attempt could otherwise leave a duplicate
        // (this chapter never got an entry the first time, so normally
        // there's nothing to remove, but this keeps the checkpoint safe if
        // that ever changes).
        const idx = ctx.manifestEntries.findIndex(e => e.original === ch.name)
        const entry: ChapterManifestEntry = { original: ch.name, slug, grid, fileCount: ch.files.length, order: ctx.chapterOrder.get(ch.name) }
        if (idx >= 0) ctx.manifestEntries[idx] = entry
        else ctx.manifestEntries.push(entry)
        await updateDriveFileContent(ctx.manifestFileId, new Blob([JSON.stringify(ctx.manifestEntries, null, 2)], { type: 'application/json' }))
      })
      updateChapterRun(ch.name, { status: 'done', doneCount: ch.files.length })
      scheduleAutoHide(ch.name)
      consecutiveFailuresRef.current = 0
    } catch (e) {
      // The folder (if any got created) was trashed above — none of this
      // chapter's uploaded-so-far images survive, so undo their contribution
      // to `done` before recording the failure.
      setDone(d => d - chapterDone)
      if (controller.signal.aborted || cancelledRef.current) {
        updateChapterRun(ch.name, { status: 'cancelled' })
        scheduleAutoHide(ch.name)
      } else {
        const errMsg = e instanceof Error ? e.message : String(e)
        updateChapterRun(ch.name, { status: 'error', error: errMsg })
        consecutiveFailuresRef.current++
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES && !pausedRef.current) {
          pausedRef.current = true
          setPausedInfo(`Tạm dừng: ${MAX_CONSECUTIVE_FAILURES} chapter lỗi liên tiếp (có thể do mất kết nối server, mất mạng, hoặc hết quota Drive). Kiểm tra rồi bấm Tiếp tục.`)
        }
      }
    } finally {
      chapterControllersRef.current.delete(ch.name)
    }
  }, [grid, updateChapterRun])

  // Retry a single failed chapter, reusing the run context + original file scan
  // kept alive in refs — works even after the overall run has "finished", since
  // processChapter is fully self-contained. Guarded against double-click: the
  // Retry button only renders for 'error' rows, but two rapid clicks can both
  // fire before the first status update ('uploading') re-renders, which would
  // otherwise start two concurrent uploads for the same chapter (two Drive
  // folders, two manifest entries).
  const retryChapter = useCallback(async (name: string) => {
    const ctx = driveRunCtxRef.current
    const ch = allChapterFilesRef.current.find(c => c.name === name)
    if (!ctx || !ch) return
    if (chapterControllersRef.current.has(name)) return
    await processChapter(ch, ctx)
  }, [processChapter])

  // Abort just this chapter's in-flight Drive requests without touching other
  // chapters uploading concurrently.
  const cancelChapterRow = useCallback((name: string) => {
    chapterControllersRef.current.get(name)?.abort()
  }, [])

  // Drive scramble: checkpoints manifest.json after every chapter so a failed or
  // cancelled run can be safely re-run — chapters already checkpointed (same
  // `original` + `fileCount`, and their slug folder still present) are skipped
  // instead of being re-uploaded under a new slug.
  const runScrambleDrive = async (
    chapterFiles: { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }[],
  ) => {
    // Drive output must mirror the sync folder concept so sync ingests it with NO
    // code change.
    //  - 'new':    <run root>/<manga name>/<slug chapter>/NNN.png  (fresh manga)
    //  - 'append': <picked manga folder>/<slug chapter>/NNN.png    (existing manga)
    // In append mode the picked folder IS the manga folder (its DriveFileId is
    // already in the DB from the first sync), so new slug subfolders land beside the
    // old ones and sync picks them up as new chapters. shareThisId is what we grant
    // the service account: the run root ('new') cascades to children; in 'append'
    // the manga folder is already shared.
    const appendMode = driveMode === 'append'
    let driveMangaId: string
    let shareThisId: string

    if (appendMode) {
      driveMangaId = driveTarget!.id
      shareThisId = driveTarget!.id
    } else {
      // Reuse one shared "Manga" root across every run instead of a fresh
      // scramble-<timestamp> folder each time — the backend already treats a
      // root as containing many manga subfolders, so this just keeps every new
      // manga landing beside old ones under a single manageable root.
      const driveRootId = await findOrCreateMangaRootFolder()
      // Find-or-create by name too: without this, retrying "Manga mới" after a
      // setup/share failure (or simply running it twice for the same manga)
      // created a second same-named folder under Manga/, which the backend
      // then synced as a duplicate manga. Reusing an existing same-named
      // folder means a re-run continues the same manga instead.
      const existingMangaId = await findChildByName(driveRootId, inputDir!.name, DRIVE_FOLDER_MIME)
      driveMangaId = existingMangaId ?? await createDriveFolder(inputDir!.name, driveRootId)
      shareThisId = driveRootId
    }

    // Share as early as possible — right after the folder exists, before
    // touching the manifest or uploading a single chapter. The chapter pool
    // below can auto-pause after repeated failures and stay paused
    // indefinitely if the admin never clicks "Tiếp tục" (or just closes the
    // tab), in which case nothing further in this function ever runs. Sharing
    // upfront means the folder — and whatever chapters do get checkpointed —
    // stays visible to the backend's read-only service account even if the
    // run is abandoned, paused forever, or fails during setup right after this.
    if (serviceEmail) {
      await shareWithServiceAccount(shareThisId, serviceEmail)
      if (!appendMode) {
        // Brand-new top-level Drive folder the backend has never seen — without
        // this it stays invisible in Drive Source until AutoSyncService's
        // 30-minute timer (or a server restart) happens to run. Best-effort: a
        // failure here just means the admin waits for the timer instead.
        await api.post('/admin/root-folders/detect-new-shared').catch(() => {})
      }
    }

    // Read/create the manifest checkpoint. Append mode requires one to already
    // exist (its presence is what marks a folder as "created by this tool");
    // "Manga mới" creates one if this is truly a fresh folder, or reuses it if
    // retrying into a folder left over from an earlier interrupted run (see
    // find-or-create above).
    let manifestFileId: string
    let existingEntries: ChapterManifestEntry[] = []
    const existingManifest = await readExistingManifest(driveMangaId)
    if (existingManifest) {
      existingEntries = existingManifest.entries
      manifestFileId = existingManifest.manifestFileId
    } else if (appendMode) {
      throw new Error('Không tìm thấy manifest.json trong manga đích — chỉ có thể thêm chapter vào manga do chính tool này scramble trước đó.')
    } else {
      // Checkpoint file created up front (empty array) so every chapter update
      // below is a PATCH to a stable file id, never a fresh upload.
      manifestFileId = await uploadDriveFile('manifest.json', new Blob([JSON.stringify([], null, 2)], { type: 'application/json' }), driveMangaId)
    }
    // Copy the non-image root files (metadata.json, cover/banner) verbatim so the
    // synced manga keeps its title/cover. Chapter images live in slug subfolders,
    // so anything at the input root is metadata to carry over. Upserts by name,
    // so this is safe to repeat on every run, including retries into an
    // existing folder.
    await copyRootFilesToDrive(inputDir!, driveMangaId)

    const usedSlugs = new Set(existingEntries.map(entry => entry.slug))

    // Preflight: decide which chapters are already checkpointed vs. need upload.
    // A chapter is considered done only if the manifest entry's fileCount matches
    // the current input AND its slug folder is still actually present on Drive —
    // a stale entry pointing at a deleted folder must not be trusted as "done".
    const byOriginal = new Map(existingEntries.map(e => [e.original, e]))
    const plan: { ch: typeof chapterFiles[number]; skip: boolean }[] = []
    for (let i = 0; i < chapterFiles.length; i++) {
      const ch = chapterFiles[i]
      setCurrentLabel(`Đang kiểm tra chapter đã có trên Drive chưa (${i + 1}/${chapterFiles.length})`)
      const existing = byOriginal.get(ch.name)
      if (!existing) {
        plan.push({ ch, skip: false })
        continue
      }
      if (existing.fileCount !== ch.files.length) {
        throw new Error(`Chapter "${ch.name}" đã có trong manifest (${existing.fileCount} ảnh) nhưng folder input hiện có ${ch.files.length} ảnh. Chưa hỗ trợ thay thế chapter đã upload — cần xử lý thủ công.`)
      }
      const folderId = await findChildByName(driveMangaId, existing.slug, DRIVE_FOLDER_MIME)
      if (!folderId) {
        throw new Error(`Chapter "${ch.name}" có entry trong manifest (slug ${existing.slug}) nhưng folder đó không còn trên Drive. Dừng lại — cần kiểm tra thủ công.`)
      }
      plan.push({ ch, skip: true })
    }

    const skippedCount = plan.filter(p => p.skip).length
    const toUpload = plan.filter(p => !p.skip).map(p => p.ch)
    const grandTotal = toUpload.reduce((sum, ch) => sum + ch.files.length, 0)
    setTotal(grandTotal)

    // Populate the per-chapter row list right away — including skipped chapters —
    // so the full chapter list is visible before any upload starts.
    const initialRuns: ChapterRunState[] = plan.map(p => p.skip
      ? { name: p.ch.name, fileCount: p.ch.files.length, status: 'skipped', doneCount: p.ch.files.length }
      : { name: p.ch.name, fileCount: p.ch.files.length, status: 'pending', doneCount: 0 })
    setChapterRuns(initialRuns)
    chapterRunsRef.current = initialRuns
    allChapterFilesRef.current = chapterFiles
    pausedRef.current = false
    setPausedInfo(null)
    consecutiveFailuresRef.current = 0
    // Skipped chapters never go through processChapter (the only place that
    // otherwise schedules auto-hide), so schedule it here right away.
    initialRuns.filter(r => r.status === 'skipped').forEach(r => scheduleAutoHide(r.name))

    // Natural-sort position of every chapter in the CURRENT input scan (chapterFiles
    // is already natural-sorted — see readSubDirs/readImageFiles). Chapters upload
    // concurrently below, so the order manifest entries get pushed/checkpointed in
    // is completion order, not this order — every entry needs its `order` written
    // from this map instead of relying on push/array position.
    const chapterOrder = new Map(chapterFiles.map((ch, i) => [ch.name, i]))

    const ctx: DriveRunContext = {
      driveMangaId,
      manifestFileId,
      manifestEntries: [...existingEntries],
      usedSlugs,
      shareThisId,
      chapterOrder,
      slugMutex: createMutex(),
      manifestMutex: createMutex(),
    }
    driveRunCtxRef.current = ctx

    startedRef.current = Date.now()

    // Chapter-level worker pool: CHAPTER_CONCURRENCY chapters upload at once, each
    // internally uploading its images with IMAGE_CONCURRENCY in parallel (see
    // processChapter). A worker parks on waitForPauseResume() between chapters
    // (never mid-chapter) once the pool auto-pauses after too many consecutive
    // failures — chapters already in flight are left to finish normally.
    let queueIndex = 0
    const worker = async () => {
      while (true) {
        if (pausedRef.current) await waitForPauseResume()
        if (cancelledRef.current) return
        const i = queueIndex++
        if (i >= toUpload.length) return
        await processChapter(toUpload[i], ctx)
      }
    }
    await Promise.all(Array.from({ length: Math.min(chapterConcurrency, toUpload.length) }, worker))

    // Share the target even if every chapter was skipped, failed, or the run
    // was cancelled partway — whatever got checkpointed above must still be readable.
    if (serviceEmail) {
      await shareWithServiceAccount(shareThisId, serviceEmail)
      // For "manga mới" this is a brand-new top-level Drive folder the backend has
      // never seen — without this it stays invisible in Drive Source until
      // AutoSyncService's 30-minute timer (or a server restart) happens to run.
      // Best-effort: a failure here just means the admin waits for the timer instead.
      await api.post('/admin/root-folders/detect-new-shared').catch(() => {})
    }

    const finalRuns = chapterRunsRef.current
    const doneChapters = finalRuns.filter(c => c.status === 'done')
    const errorChapters = finalRuns.filter(c => c.status === 'error')
    const cancelledChapters = finalRuns.filter(c => c.status === 'cancelled')
    const uploadedImages = doneChapters.reduce((sum, c) => sum + c.fileCount, 0)

    // Clear the selected input folder once the run is done — allChapterFilesRef/
    // driveRunCtxRef (used by Retry) stay alive independent of this, so retrying
    // a failed chapter still works after the input picker resets.
    setInputDir(null)
    setPreviewReady(false)

    if (cancelledRef.current || cancelledChapters.length > 0) {
      message.info(`Đã hủy. ${doneChapters.length} chapter mới đã checkpoint (${uploadedImages} ảnh) — chạy lại hoặc bấm Thử lại trên từng dòng để tiếp tục.`)
      return
    }

    if (errorChapters.length > 0) {
      message.error(
        `Hoàn thành với lỗi. ${doneChapters.length} chapter mới (${uploadedImages} ảnh) đã upload thành công`
        + (skippedCount > 0 ? `, bỏ qua ${skippedCount} chapter đã có` : '')
        + `. ${errorChapters.length} chapter LỖI, bấm Thử lại trên từng dòng: `
        + errorChapters.map(c => `"${c.name}" (${c.error})`).join('; ')
      , 12)
      return
    }

    message.success(
      `Hoàn thành! ${doneChapters.length} chapter mới (${uploadedImages} ảnh) đã xáo & upload lên Drive.`
      + (skippedCount > 0 ? ` Bỏ qua ${skippedCount} chapter đã có.` : '')
    )
  }

  const runUnscramble = async () => {
    // Reads <input>/manifest.json; for each entry, requests its server-derived key
    // and restores <input>/<slug>/* back to <output>/<original>/NNN.png.
    const manifest = await readManifest(inputDir!)
    if (manifest.length === 0) {
      message.error('manifest.json không có chapter. Unscramble cần folder output do tool tạo ra.')
      return
    }

    const chapters: { entry: ChapterManifestEntry; files: { name: string; handle: FileSystemFileHandle }[] }[] = []
    let grandTotal = 0
    for (const entry of manifest) {
      const chapterDir = await inputDir!.getDirectoryHandle(entry.slug).catch(() => null)
      if (!chapterDir) continue
      const files = await readImageFiles(chapterDir)
      if (files.length === 0) continue
      chapters.push({ entry, files })
      grandTotal += files.length
    }
    setTotal(grandTotal)
    if (grandTotal === 0) { message.warning('Không tìm thấy ảnh theo manifest'); return }

    let processed = 0
    for (const { entry, files } of chapters) {
      if (cancelledRef.current) break
      const key = await deriveChapterKey(entry.slug)
      const outChapterDir = await outputDir!.getDirectoryHandle(entry.original, { create: true })

      let seq = 1
      for (const file of files) {
        if (cancelledRef.current) break
        setCurrentLabel(`${entry.slug} → ${entry.original}`)
        const blob = await file.handle.getFile()
        const bitmap = await createImageBitmap(blob)
        try {
          const perm = generateInversePermutation(key, entry.grid)
          const outBlob = await processToBlob(bitmap, perm, entry.grid)
          const fileHandle = await outChapterDir.getFileHandle(`${String(seq).padStart(3, '0')}.png`, { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(outBlob)
          await writable.close()
        } finally {
          bitmap.close()
        }
        seq++
        processed++
        setDone(processed)
      }
    }

    if (cancelledRef.current) { message.info('Đã hủy'); return }
    message.success(`Hoàn thành! ${chapters.length} chapter, ${processed} ảnh đã khôi phục.`)
  }

  const start = async () => {
    if (!inputDir) { message.warning('Vui lòng chọn folder input'); return }
    // Unscramble always writes local. Scramble writes local OR to Drive.
    const toDrive = mode === 'scramble' && dest === 'drive'
    if (!toDrive && !outputDir) { message.warning('Vui lòng chọn folder output'); return }
    if (toDrive && !driveEmail) { message.warning('Vui lòng kết nối Google Drive trước'); return }
    if (toDrive && !serviceEmail) { message.warning('Chưa lấy được service account email, thử lại sau'); return }
    if (toDrive && driveMode === 'append' && !driveTarget) { message.warning('Vui lòng chọn manga đích để thêm chapter'); return }

    cancelledRef.current = false
    setRunning(true)
    setDone(0)
    setTotal(0)
    setCurrentIcon('folder_open')
    setCurrentLabel('Đang quét folder...')

    try {
      if (mode === 'scramble') await runScramble()
      else await runUnscramble()
    } catch (e) {
      message.error(`Lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
      setCurrentLabel('')
    }
  }

  const cancel = () => {
    cancelledRef.current = true
    // A stalled Drive request never rejects on its own (see driveFetch), so
    // the cancel flag alone can't unstick a run that's frozen mid-await —
    // abort whatever's in flight so control actually returns to the loop.
    abortAllDriveRequests()
    // If the pool is auto-paused, workers are blocked on waitForPauseResume()
    // and only resumeFromPause() wakes them — abortAllDriveRequests() alone
    // can't reach them. Wake them here too so cancel works while paused,
    // otherwise Promise.all in runScrambleDrive never resolves and the run
    // hangs forever in the "running" state.
    if (pausedRef.current) {
      pausedRef.current = false
      setPausedInfo(null)
      const waiters = resumeWaitersRef.current
      resumeWaitersRef.current = []
      waiters.forEach(w => w())
    }
  }

  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Scramble ảnh</h2>
        <a href="/downloads/manga-download.zip" download style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--accent)' }}>
          <span className="ms ms-sm">download</span> Tải tool scramble (.zip)
        </a>
      </div>

      {!supported && (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, color: 'var(--text-muted)', fontSize: 13 }}>
          Trình duyệt không hỗ trợ File System Access API. Vui lòng dùng Chrome hoặc Edge trên desktop.
        </div>
      )}

      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <Segmented
          value={mode}
          onChange={v => { setMode(v as Mode); setPreviewReady(false) }}
          disabled={running}
          options={[
            { label: 'Scramble (xáo)', value: 'scramble' },
            { label: 'Unscramble (khôi phục)', value: 'unscramble' },
          ]}
          style={{ marginBottom: 12 }}
        />

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          {mode === 'scramble'
            ? 'Xáo ảnh local trước khi upload. Mỗi thư mục con = 1 chapter, dùng khóa riêng do server dẫn xuất theo slug. Kết quả ghi PNG kèm manifest.json.'
            : 'Khôi phục ảnh đã xáo bằng khóa riêng do server dẫn xuất. Folder input phải chứa manifest.json; kết quả ghi ra <output>/<tên chapter gốc>/NNN.png.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'scramble' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Grid</label>
              <Select
                value={grid}
                onChange={v => { setGrid(v); setPreviewReady(false) }}
                disabled={running}
                style={{ width: 120 }}
                options={[3, 4, 5, 6, 8].map(g => ({ value: g, label: `${g}x${g}` }))}
              />
            </div>
          )}

          {/* Scramble destination: local folder (original flow) or push straight
              to the admin's personal Google Drive. Unscramble is always local. */}
          {mode === 'scramble' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Đích ghi kết quả</label>
              <Segmented
                value={dest}
                onChange={v => setDest(v as Dest)}
                disabled={running}
                options={[
                  { label: 'Folder local', value: 'local' },
                  { label: 'Google Drive', value: 'drive' },
                ]}
              />
            </div>
          )}

          {/* Drive account: connect / switch / disconnect. Shows which personal
              Drive uploads land in; account switch re-opens Google's chooser. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="ms ms-sm" style={{ color: driveEmail ? 'var(--green, #4caf50)' : 'var(--text-muted)' }}>
                  {driveEmail ? 'cloud_done' : 'cloud_off'}
                </span>
                <span style={{ fontSize: 13, color: driveEmail ? 'var(--text)' : 'var(--text-muted)' }}>
                  {driveEmail ? `Drive: ${driveEmail}` : 'Chưa kết nối Google Drive'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => connectDriveAccount(false)} loading={driveConnecting} disabled={running} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">login</span> {driveEmail ? 'Kết nối lại' : 'Kết nối Drive'}
                </Button>
                <Button onClick={() => connectDriveAccount(true)} disabled={running || driveConnecting} style={{ borderRadius: 20, height: 34 }}>
                  <span className="ms ms-sm">switch_account</span> Đổi tài khoản
                </Button>
                {driveEmail && (
                  <Button onClick={disconnectDriveAccount} disabled={running} danger style={{ borderRadius: 20, height: 34 }}>
                    <span className="ms ms-sm">logout</span> Ngắt kết nối
                  </Button>
                )}
              </div>
              {serviceEmail && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                  Folder upload sẽ tự chia sẻ (chỉ đọc) tới service account <b>{serviceEmail}</b> để web đọc được ảnh.
                </p>
              )}
            </div>
          )}

          {/* Drive target: create a new manga folder, or append new chapters into an
              existing manga folder (picked via Google Picker). Append downloads the
              existing manifest and merges the new chapter entries so old chapters keep
              their slug/grid. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Đích trên Drive</label>
              <Segmented
                value={driveMode}
                onChange={v => { setDriveMode(v as 'new' | 'append'); setDriveTarget(null) }}
                disabled={running}
                options={[
                  { label: 'Manga mới', value: 'new' },
                  { label: 'Thêm chapter vào manga có sẵn', value: 'append' },
                ]}
                style={{ marginBottom: driveMode === 'append' ? 8 : 0 }}
              />
              {driveMode === 'append' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button onClick={pickTargetFolder} loading={picking} disabled={running || !driveEmail} style={{ borderRadius: 20, height: 34 }}>
                    <span className="ms ms-sm">folder_special</span> {driveTarget ? `Manga: ${driveTarget.name}` : 'Chọn manga đích'}
                  </Button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Chỉ chọn folder manga đã scramble trước đó (chứa manifest.json).
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Chapters upload concurrently during a Drive run — higher values upload
              faster but lean harder on Drive's rate limits. */}
          {mode === 'scramble' && dest === 'drive' && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>Số chapter upload đồng thời</label>
              <Select
                value={chapterConcurrency}
                onChange={setChapterConcurrency}
                disabled={running}
                style={{ width: 120 }}
                options={CHAPTER_CONCURRENCY_OPTIONS.map(n => ({ value: n, label: String(n) }))}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={pickInput} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
              <span className="ms ms-sm">folder_open</span> {inputDir ? `Input: ${inputDir.name}` : 'Chọn folder input'}
            </Button>
            {!(mode === 'scramble' && dest === 'drive') && (
              <Button onClick={pickOutput} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
                <span className="ms ms-sm">drive_folder_upload</span> {outputDir ? `Output: ${outputDir.name}` : 'Chọn folder output'}
              </Button>
            )}
            <Button onClick={doPreview} loading={previewing} disabled={running || !supported} style={{ borderRadius: 20, height: 36 }}>
              <span className="ms ms-sm">visibility</span> Preview
            </Button>
          </div>

          {/* Before / after preview of the first image. */}
          <div style={{ display: previewReady ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{mode === 'scramble' ? 'Gốc' : 'Đã xáo (input)'}</p>
              <canvas ref={origCanvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#111' }} />
            </div>
            <div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{mode === 'scramble' ? 'Đã xáo (minh hoạ)' : 'Khôi phục'}</p>
              <canvas ref={procCanvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#111' }} />
            </div>
          </div>
          {mode === 'scramble' && previewReady && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
              Preview dùng slug cố định "000000000000" và khóa do server dẫn xuất; slug thật sinh ngẫu nhiên khi chạy nên ảnh xáo thực tế sẽ khác.
            </p>
          )}

          {/* Drive path: per-chapter progress list (chapters upload concurrently, so a
              single flat progress bar can't show which chapter is stuck/failed). Local
              scramble and unscramble keep the original single aggregate bar below. */}
          {running && mode === 'scramble' && dest === 'drive' && (() => {
            const speed = elapsed > 0 ? done / (elapsed / 1000) : 0
            const remaining = speed > 0 && done < total ? Math.round(((total - done) / speed) * 1000) : 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
                    <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> ảnh</span>
                    <span>Thời gian: {formatDuration(elapsed)}</span>
                    {speed > 0 && <span>Tốc độ: {speed.toFixed(1)} ảnh/s</span>}
                    {speed > 0 && done < total && <span>Còn lại: ~{formatDuration(remaining)}</span>}
                  </div>
                  {currentLabel && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={currentIcon === 'sync' ? 'ms ms-xs spin' : 'ms ms-xs'} style={{ fontSize: 14 }}>{currentIcon}</span>
                      {currentLabel}
                    </p>
                  )}
                </div>

                {pausedInfo && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elevated)', border: '1px solid var(--red, #e5484d)', borderRadius: 10, padding: '10px 14px' }}>
                    <span className="ms" style={{ fontSize: 18, color: 'var(--red, #e5484d)' }}>error</span>
                    <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, flex: 1 }}>{pausedInfo}</p>
                    <Button size="small" onClick={resumeFromPause} style={{ borderRadius: 16 }}>Tiếp tục</Button>
                  </div>
                )}

                {chapterRuns.length > 0 && (() => {
                  // Only mount rows within [startIndex, endIndex) of the current scroll
                  // position (plus overscan on both sides) — chapterRuns can run into the
                  // hundreds/thousands, and reconciling every row's DOM node on each
                  // progress tick (one per uploaded image) is the FE cost this avoids.
                  const rowCount = chapterRuns.length
                  const visibleSlots = Math.ceil(CHAPTER_LIST_MAX_HEIGHT / CHAPTER_ROW_SLOT)
                  const startIndex = Math.max(0, Math.floor(chapterListScrollTop / CHAPTER_ROW_SLOT) - CHAPTER_LIST_OVERSCAN)
                  const endIndex = Math.min(rowCount, startIndex + visibleSlots + CHAPTER_LIST_OVERSCAN * 2)
                  const visible = chapterRuns.slice(startIndex, endIndex)
                  return (
                    <div onScroll={onChapterListScroll} style={{ maxHeight: CHAPTER_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
                      <div style={{ position: 'relative', height: rowCount * CHAPTER_ROW_SLOT }}>
                        {visible.map((c, i) => (
                          <div key={c.name} style={{ position: 'absolute', top: (startIndex + i) * CHAPTER_ROW_SLOT, left: 0, right: 0 }}>
                            <ChapterRunRow chapter={c} onRetry={retryChapter} onCancel={cancelChapterRow} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )
          })()}

          {/* Local scramble / unscramble: single aggregate progress bar (unchanged). */}
          {running && !(mode === 'scramble' && dest === 'drive') && (() => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            // Speed + ETA derive from elapsed wall time; guard the first tick
            // (elapsed 0) so we don't divide by zero or show Infinity.
            const speed = elapsed > 0 ? done / (elapsed / 1000) : 0
            const remaining = speed > 0 ? Math.round(((total - done) / speed) * 1000) : 0
            return (
              <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <Progress percent={pct} status="active" />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> ảnh</span>
                  <span>Thời gian: {formatDuration(elapsed)}</span>
                  {speed > 0 && <span>Tốc độ: {speed.toFixed(1)} ảnh/s</span>}
                  {speed > 0 && done < total && <span>Còn lại: ~{formatDuration(remaining)}</span>}
                </div>
                {currentLabel && (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>{currentLabel}</p>
                )}
              </div>
            )
          })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            {running && <Button onClick={cancel} danger style={{ borderRadius: 20, height: 36 }}>Hủy</Button>}
            <Button type="primary" onClick={start} loading={running} disabled={!supported} style={{ borderRadius: 20, height: 36 }}>
              {mode === 'scramble' ? 'Bắt đầu xáo' : 'Bắt đầu khôi phục'}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
