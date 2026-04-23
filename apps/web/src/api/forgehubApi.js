/**
 * Read-path client for @forgehub/api. Base URL from Vite env or localhost default.
 */

export function getApiBaseUrl() {
  const raw = import.meta.env.VITE_API_URL
  if (raw != null && String(raw).trim() !== '') {
    return String(raw).replace(/\/$/, '')
  }
  return 'http://localhost:3001'
}

async function parseBody(res) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function apiFetch(path, options = {}) {
  const url = `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const data = await parseBody(res)
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data?.error?.message
        ? data.error.message
        : typeof data === 'string'
          ? data
          : res.statusText
    const err = new Error(msg || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function getHealth() {
  return apiFetch('/health')
}

export function listProjectSnapshots(projectId) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/snapshots`)
}

export function compareSnapshots(body) {
  return apiFetch('/diffs/compare', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
