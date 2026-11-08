import { useCallback, useEffect, useState } from "react"

const KEY = "crm-token"

export function getToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? ""
  } catch {
    return ""
  }
}

export function setToken(token: string) {
  try {
    if (token) sessionStorage.setItem(KEY, token)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* private mode: the token lives only for this page */
  }
  window.dispatchEvent(new Event("crm-auth"))
}

export class ApiFailure extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (response.status === 401) {
    throw new ApiFailure(401, "Sign in with the CRM token to change data.")
  }
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new ApiFailure(response.status, body?.message ?? `The server answered ${response.status}.`)
  return body as T
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    if (!path) return
    let alive = true
    setLoading(true)
    setError(null)
    api<T>(path)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [path, nonce])
  return { data, error, loading, reload }
}
