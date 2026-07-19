// Browser-side Google Drive uploader.
//
// The admin scrambles images locally, then this module pushes the scrambled
// output straight to the admin's *personal* Google Drive (Google One 5TB),
// using the Google Identity Services (GIS) token flow with the drive.file
// scope. The backend service account stays read-only: after upload we grant it
// reader permission on the folder so /api/images can keep proxying the tiles.
//
// Account switching is manual: connect() with forceSelect shows Google's
// account chooser so the admin can pick which Drive to upload into.

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
// drive.file: create + manage only files this app creates. Narrowest scope that
// still lets us upload folders/images and share them with the service account.
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

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

// In-memory only — never persisted. A Drive access token is short-lived (~1h)
// and re-requestable silently, so keeping it out of storage limits exposure.
let accessToken: string | null = null
let tokenExpiry = 0
let connectedEmail: string | null = null

export function getConnectedEmail(): string | null {
  return connectedEmail
}

export function isDriveConnected(): boolean {
  return !!accessToken && Date.now() < tokenExpiry
}

// Request an access token. forceSelect shows the account chooser (manual account
// switch); otherwise Google may reuse the last-consented account silently.
async function requestToken(forceSelect: boolean): Promise<string> {
  await loadGis()
  const oauth2 = window.google!.accounts.oauth2
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
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
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    const data = await r.json()
    return data?.user?.emailAddress ?? null
  } catch {
    return null
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
// silently re-requests a token once and retries before giving up.
async function driveFetch(
  makeRequest: (token: string) => Promise<Response>,
  errLabel: string,
): Promise<Response> {
  let token = await ensureToken()
  let r = await makeRequest(token)
  if (r.status === 401) {
    token = await ensureToken(true)
    r = await makeRequest(token)
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`${errLabel} (${r.status})${detail ? `: ${detail}` : ''}`)
  }
  return r
}

// Create a folder and return its id. parentId omitted → created in Drive root.
export async function createDriveFolder(name: string, parentId?: string): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  }
  if (parentId) body.parents = [parentId]
  const r = await driveFetch(
    token => fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'Tạo folder Drive thất bại',
  )
  return (await r.json()).id
}

// Multipart upload of a blob into parentId. Returns the new file id.
export async function uploadDriveFile(name: string, blob: Blob, parentId: string): Promise<string> {
  const metadata = { name, parents: [parentId] }
  const r = await driveFetch(
    token => {
      const form = new FormData()
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
      form.append('file', blob)
      return fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        },
      )
    },
    'Upload ảnh lên Drive thất bại',
  )
  return (await r.json()).id
}

// Grant the backend service account reader access on a file/folder so the
// existing read-only /api/images proxy can serve the uploaded tiles. Folder
// permissions cascade to children, so sharing the run's root folder is enough.
export async function shareWithServiceAccount(fileId: string, serviceEmail: string): Promise<void> {
  await driveFetch(
    token => fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: serviceEmail }),
      },
    ),
    'Chia sẻ folder cho service account thất bại',
  )
}
