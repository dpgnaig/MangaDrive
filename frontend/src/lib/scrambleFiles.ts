// Shared, side-effect-free helpers for the scramble/unscramble tool. Used by
// both AdminScrambleTab.tsx (local scramble/unscramble/preview) and
// scrambleDriveRun.ts (the Drive upload orchestration) — kept here instead of
// in either of those to avoid a circular import between them.
import api from './api'

export interface ChapterManifestEntry {
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

export type ScrambleChapterFiles = { name: string; handle: FileSystemDirectoryHandle; files: { name: string; handle: FileSystemFileHandle }[] }

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i

// Minimal async mutex: runExclusive(fn) queues fn behind whatever is already
// running through this mutex, so calls never interleave. Used to serialize
// slug assignment and the manifest checkpoint write across concurrently
// uploading chapters — see scrambleDriveRun.ts's processChapter for why both
// need this.
export type Mutex = <T>(fn: () => T | Promise<T>) => Promise<T>
export function createMutex(): Mutex {
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
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
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

export function newSlug(usedSlugs: Set<string>): string {
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

export async function deriveChapterKey(slug: string): Promise<string> {
  const { data } = await api.post('/admin/scramble/derive-key', { slug })
  return data.key
}

// Rearrange tiles of `bitmap` onto `ctx` using `perm`: output tile destIdx = source
// tile perm[destIdx]. Same math for scramble (forward perm) and unscramble (inverse
// perm) — only the permutation differs. Mirrors ImageProcessor.cs RearrangeTiles.
export function drawTiles(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, perm: number[], grid: number) {
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

export async function processToBlob(bitmap: ImageBitmap, perm: number[], grid: number): Promise<Blob> {
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
export async function readImageFiles(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
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
export async function readSubDirs(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemDirectoryHandle }[]> {
  const dirs: { name: string; handle: FileSystemDirectoryHandle }[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      dirs.push({ name, handle: handle as FileSystemDirectoryHandle })
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return dirs
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

export function parseManifestStrict(text: string): ChapterManifestEntry[] {
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

// Read + parse manifest.json at the root of a directory handle.
export async function readManifest(dir: FileSystemDirectoryHandle): Promise<ChapterManifestEntry[]> {
  const handle = await dir.getFileHandle('manifest.json')
  const text = await (await handle.getFile()).text()
  return parseManifestStrict(text)
}

// Determine chapters under `inputDir`: direct subfolders that contain images,
// or the input folder itself if it holds images directly (no subfolders).
// Shared by the local scramble path and the Drive scramble path.
export async function scanChapters(inputDir: FileSystemDirectoryHandle): Promise<ScrambleChapterFiles[]> {
  const subDirs = await readSubDirs(inputDir)
  const chapters: { name: string; handle: FileSystemDirectoryHandle }[] =
    subDirs.length > 0 ? subDirs : [{ name: inputDir.name, handle: inputDir }]

  const chapterFiles: ScrambleChapterFiles[] = []
  for (const ch of chapters) {
    const files = await readImageFiles(ch.handle)
    if (files.length === 0) continue
    chapterFiles.push({ ...ch, files })
  }
  return chapterFiles
}
