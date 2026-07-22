import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { clearToken, fetchMe, getToken, getUser } from "./auth"

interface AuthUser {
  id: number
  username: string
  display_name: string
  role: string
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  loading: boolean
  logout: () => void
}

const AuthContext = createContext<AuthState>({ user: null, token: null, loading: true, logout: () => {} })

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)

  const initAuth = useCallback(async () => {
    const t = getToken()
    setToken(t)
    if (!t) {
      setLoading(false)
      return
    }
    // Try to restore from cache first
    const cached = getUser()
    if (cached) {
      setUser(cached)
      setLoading(false)
    }
    // Validate token by fetching /me
    try {
      await fetchMe()
      setUser(getUser())
    } catch {
      clearToken()
      setToken(null)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void initAuth()
  }, [initAuth])

  const logout = useCallback(() => {
    clearToken()
    setToken(null)
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, token, loading, logout }), [user, token, loading, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
