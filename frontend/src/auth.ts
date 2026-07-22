// Token helpers
const TOKEN_KEY = "ops_token"
const USER_KEY = "ops_user"

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function setUser(user: Record<string, unknown>): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function getUser(): { id: number; username: string; display_name: string; role: string } | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// API client with auth header
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> || {} }
  const token = getToken()
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  const response = await fetch(url, { ...options, headers })
  if (!response.ok) {
    if (response.status === 401) {
      clearToken()
      window.location.reload()
    }
    throw new Error(`Request failed: ${response.status}`)
  }
  return response.json()
}

// Login API call
export interface LoginResult {
  access_token: string
  token_type: string
  expires_in: number
}

export async function loginApi(username: string, password: string): Promise<LoginResult> {
  const formData = new URLSearchParams()
  formData.set("username", username)
  formData.set("password", password)

  const response = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || "Login failed")
  }

  const data: LoginResult = await response.json()
  setToken(data.access_token)
  return data
}

// Get current user
export async function fetchMe(): Promise<void> {
  const data = await api<{ id: number; username: string; display_name: string; role: string }>("/api/v1/auth/me")
  setUser(data)
}
