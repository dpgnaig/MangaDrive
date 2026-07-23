// Browser-side Google Drive uploader.
//
// The admin scrambles images locally, then this module pushes the scrambled
// output straight to the admin's *personal* Google Drive (Google One 5TB),
// using the Google Identity Services (GIS) token flow with the drive scope.
// The backend service account stays read-only: after upload we grant it
// reader permission on the folder so /api/images can keep proxying the tiles.
//
// Account switching is manual: connect() with forceSelect shows Google's
// account chooser so the admin can pick which Drive to upload into.

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const GAPI_SRC = 'https://apis.google.com/js/api.js'
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
// Developer key for the Google Picker. Separate from the OAuth client id — create
// an API key in the same Google Cloud project and restrict it to the Picker API.
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string
// Full drive scope, not drive.file: drive.file only grants access to files/folders
// this app itself created (or that the admin explicitly picked via the Picker), so
// createDriveFolder(name, existingMangaFolderId) on a manga folder from an EARLIER
// browser session — reused via findOrCreateMangaRootFolder/findChildByName without
// ever going through the Picker — fails with 403 appNotAuthorizedToChild: the token
// has no record of being granted access to that folder's children. The full drive
// scope removes that per-file ACL entirely, so appending chapters into a
// previously-created "Manga" root/manga folder works across sessions without
// re-picking it every time.
const SCOPE = 'https://www.googleapis.com/auth/drive'

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void
  callback: (resp: { access_token?: string; error?: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string
            scope: string
            prompt?: string
            callback: (resp: { access_token?: string; error?: string }) => void
          }) => TokenClient
          revoke: (token: string, done?: () => void) => void
        }
      }
      // Loaded on demand via gapi.load('picker'); only the bits we use are typed.
      picker?: any
    }
    gapi?: {
      load: (name: string, cb: () => void) => void
    }
  }
}

let gisPromise: Promise<void> | null = null

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gisPromise) return gisPromise
  gisPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => { gisPromise = null; reject(new Error('Không tải được Google Identity Services')) }
    document.head.appendChild(s)
  })
  return gisPromise
}

let gapiPromise: Promise<void> | null = null

// Load gapi + the Picker module. The Picker lets the admin browse their own Drive
// and pick an existing manga folder from a previous run (drive.file only grants
// the app access to files it created, so without the Picker the app can't "find"
// a prior folder to append chapters to — picking one re-grants that access).
function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve()
  if (gapiPromise) return gapiPromise
  gapiPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GAPI_SRC
    s.async = true
    s.defer = true
    s.onload = () => window.gapi!.load('picker', () => resolve())
    s.onerror = () => { gapiPromise = null; reject(new Error('Không tải được Google Picker')) }
    document.head.appendChild(s)
  })
  return gapiPromise
}

// In-memory only — never persisted. A Drive access token is short-lived (~1h)
// and re-requestable silently, so keeping it out of storage limits exposure.
let accessToken: string | null = null
let tokenExpiry = 0
let connectedEmail: string | null = null

// Default timeout for a single Drive fetch. Without this, a stalled request
// (dropped connection, silent Google throttling) never resolves or rejects,
// hanging every caller — runPool, the preflight loop, everything — with no
// console output at all. uploadDriveFile/updateDriveFileContent pass a longer
// timeout since their payloads (scrambled page images) are much larger.
const DEFAULT_TIMEOUT_MS = 20_000
// Uploads carry scrambled page images / manifest bodies, much larger than a
// metadata call — give them more room before treating the connection as stuck.
const UPLOAD_TIMEOUT_MS = 60_000

// In-flight request controllers, tracked so the UI's cancel button can abort
// a request that's already stuck — cancelledRef checks between awaits can't
// reach a fetch that never settles. driveFetch adds/removes its own controller.
const activeControllers = new Set<AbortController>()

export function abortAllDriveRequests(): void {
  for (const c of activeControllers) c.abort()
}

export function getConnectedEmail(): string | null {
  return connectedEmail
}

export function isDriveConnected(): boolean {
  return !!accessToken && Date.now() < tokenExpiry
}

// Request an access token. forceSelect shows the account chooser (manual account
// switch); otherwise Google may reuse the last-consented account silently.
// Guarded by a timeout: if the GIS consent UI never fires its callback (e.g. no
// user-gesture context left, mid-run auto-refresh), this would otherwise hang
// forever with no error — every Drive call routes through ensureToken() here.
async function requestToken(forceSelect: boolean, timeoutMs = 45_000): Promise<string> {
  await loadGis()
  const oauth2 = window.google!.accounts.oauth2
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Yêu cầu quyền truy cập Drive quá thời gian chờ (${timeoutMs / 1000}s) — có thể popup xin quyền bị chặn hoặc đã đóng`))
    }, timeoutMs)
    const client = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || 'Không lấy được quyền truy cập Drive'))
          return
        }
        accessToken = resp.access_token
        // GIS tokens last 3600s; refresh a minute early to avoid edge expiry.
        tokenExpiry = Date.now() + 3540_000
        resolve(resp.access_token)
      },
    })
    client.requestAccessToken({ prompt: forceSelect ? 'select_account consent' : '' })
  })
}

async function fetchConnectedEmail(token: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!r.ok) return null
    const data = await r.json()
    return data?.user?.emailAddress ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Connect to Drive (or switch account when forceSelect=true). Returns the
// connected account email so the UI can show which Drive uploads land in.
export async function connectDrive(forceSelect = false): Promise<string | null> {
  const token = await requestToken(forceSelect)
  connectedEmail = await fetchConnectedEmail(token)
  return connectedEmail
}

export function disconnectDrive(): void {
  if (accessToken) {
    try { window.google?.accounts.oauth2.revoke(accessToken) } catch { /* ignore */ }
  }
  accessToken = null
  tokenExpiry = 0
  connectedEmail = null
}

async function ensureToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && isDriveConnected()) return accessToken!
  accessToken = null
  tokenExpiry = 0
  return requestToken(false)
}

// Wrapper around fetch for Drive API calls. Surfaces Google's real error body
// (not just the status code) and, on 401 (token expired/invalidated mid-run),
// silently re-requests a token once and retries before giving up. Every
// request gets its own AbortController, tracked in activeControllers and
// bounded by timeoutMs — otherwise a stalled connection hangs the caller
// forever with no error, and the cancel button has nothing to abort.
async function driveFetch(
  makeRequest: (token: string, signal: AbortSignal) => Promise<Response>,
  errLabel: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const runOnce = async (token: string): Promise<Response> => {
    const controller = new AbortController()
    activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener('abort', onExternalAbort)
    try {
      return await makeRequest(token, controller.signal)
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`${errLabel} (quá thời gian chờ ${timeoutMs / 1000}s hoặc đã hủy)`)
      }
      throw e
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
      activeControllers.delete(controller)
    }
  }

  let token = await ensureToken()
  let r = await runOnce(token)
  if (r.status === 401) {
    token = await ensureToken(true)
    r = await runOnce(token)
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`${errLabel} (${r.status})${detail ? `: ${detail}` : ''}`)
  }
  return r
}

// Single shared root that every "manga mới" scramble run uploads into, instead
// of a fresh scramble-<timestamp> root per run — avoids littering the admin's
// Drive with one throw-away top-level folder for every upload.
const MANGA_ROOT_FOLDER_NAME = 'Manga'

// Find the shared "Manga" root at the top of Drive, creating it on first use.
// Safe to call every run: backend root-folder sync already treats one root as
// containing many manga subfolders, so reusing this folder across runs just
// means new manga land beside old ones under the same shared root.
export async function findOrCreateMangaRootFolder(): Promise<string> {
  const existing = await findChildByName('root', MANGA_ROOT_FOLDER_NAME, DRIVE_FOLDER_MIME)
  if (existing) return existing
  return createDriveFolder(MANGA_ROOT_FOLDER_NAME)
}

// Find a direct child folder of parentId by exact name, or create one if absent.
// Returns the folder id and whether it was newly created. Callers that reuse a
// per-manga folder across runs (e.g. re-running "Manga mới" after a failure, or
// by mistake instead of "Thêm chapter vào manga có sẵn") check `created` to
// decide whether to treat the folder as fresh or as a prior run's output to
// merge into instead of duplicating.
export async function findOrCreateChildFolder(parentId: string, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await findChildByName(parentId, name, DRIVE_FOLDER_MIME)
  if (existing) return { id: existing, created: false }
  return { id: await createDriveFolder(name, parentId), created: true }
}

// Create a folder and return its id. parentId omitted → created in Drive root.
// signal lets a per-chapter cancel abort this specific request without touching
// other chapters' in-flight uploads (see AdminScrambleTab's per-chapter Cancel).
export async function createDriveFolder(name: string, parentId?: string, signal?: AbortSignal): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  }
  if (parentId) body.parents = [parentId]
  const r = await driveFetch(
    (token, reqSignal) => fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: reqSignal,
    }),
    'Tạo folder Drive thất bại',
    DEFAULT_TIMEOUT_MS,
    signal,
  )
  return (await r.json()).id
}

// Multipart upload of a blob into parentId. Returns the new file id.
// signal: see createDriveFolder.
export async function uploadDriveFile(name: string, blob: Blob, parentId: string, signal?: AbortSignal): Promise<string> {
  const metadata = { name, parents: [parentId] }
  const r = await driveFetch(
    (token, reqSignal) => {
      const form = new FormData()
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
      form.append('file', blob)
      return fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
          signal: reqSignal,
        },
      )
    },
    'Upload ảnh lên Drive thất bại',
    UPLOAD_TIMEOUT_MS,
    signal,
  )
  return (await r.json()).id
}

// Grant the backend service account reader access on a file/folder so the
// existing read-only /api/images proxy can serve the uploaded tiles. Folder
// permissions cascade to children, so sharing the run's root folder is enough.
// Idempotent: checks for an existing permission for serviceEmail first, since
// this is called on every "Manga mới"/"Thêm chapter" run (so folders shared
// under an older code path, or interrupted before sharing, get picked up
// automatically) — without the check, Drive has no dedupe and would grow a
// new permission entry for the same email on every single run.
export async function shareWithServiceAccount(fileId: string, serviceEmail: string): Promise<void> {
  const listRes = await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(emailAddress,role)`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    ),
    'Kiểm tra quyền chia sẻ folder trên Drive thất bại',
  )
  const existing = (await listRes.json()).permissions as { emailAddress?: string; role: string }[] | undefined
  if (existing?.some(p => p.emailAddress === serviceEmail)) return

  await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: serviceEmail }),
        signal,
      },
    ),
    'Chia sẻ folder cho service account thất bại',
  )
}

// Open the Google Picker so the admin can browse their own Drive and pick an
// existing manga folder (from a prior scramble run) to append new chapters to.
// Returns {id, name} of the picked folder, or null if cancelled. Picking a folder
// re-grants the app drive.file access to it (drive.file otherwise only covers files
// this app created), so subsequent uploads/manifest edits into it succeed.
export async function pickDriveFolder(): Promise<{ id: string; name: string } | null> {
  const token = await ensureToken()
  await loadPicker()
  const picker = window.google!.picker

  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      reject(new Error('Thiếu VITE_GOOGLE_API_KEY — cần API key để dùng Google Picker'))
      return
    }
    const view = new picker.DocsView(picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder')
    const p = new picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .addView(view)
      .setCallback((data: any) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0]
          resolve(doc ? { id: doc.id, name: doc.name } : null)
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null)
        }
      })
      .build()
    p.setVisible(true)
  })
}

// Find a direct child of parentId by exact name. Returns the file/folder id, or
// null if absent. Used to locate the existing manifest.json (to append to) and to
// detect chapter-slug collisions on re-runs. Pass mimeType to disambiguate a
// folder from a same-named file (e.g. verifying a chapter slug folder survived).
export async function findChildByName(parentId: string, name: string, mimeType?: string): Promise<string | null> {
  let q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`
  if (mimeType) q += ` and mimeType = '${mimeType}'`
  const r = await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    ),
    'Tìm file trên Drive thất bại',
  )
  const files = (await r.json()).files as { id: string; name: string }[]
  return files?.[0]?.id ?? null
}

// Mime type Drive uses for folders — shared by findChildByName callers that need
// to confirm a chapter slug child is actually a folder, not a same-named file.
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

// Move a file/folder to trash (recoverable), rather than permanently deleting it.
// Used to best-effort clean up a chapter folder left partial by a failed/cancelled
// upload, so a re-run doesn't leave an orphan folder for sync to pick up.
export async function trashDriveFile(fileId: string): Promise<void> {
  await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
        signal,
      },
    ),
    'Xóa folder dở trên Drive thất bại',
  )
}

// Download a Drive file's raw text content (used to read the existing manifest.json).
export async function downloadDriveFileText(fileId: string): Promise<string> {
  const r = await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    ),
    'Đọc file trên Drive thất bại',
  )
  return r.text()
}

// Overwrite an existing Drive file's content in place (keeps the same file id, so
// sync sees the manifest update without treating it as a new file).
export async function updateDriveFileContent(fileId: string, blob: Blob): Promise<void> {
  await driveFetch(
    (token, signal) => fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: blob,
        signal,
      },
    ),
    'Cập nhật file trên Drive thất bại',
    UPLOAD_TIMEOUT_MS,
  )
}
