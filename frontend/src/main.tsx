import { createRoot } from "react-dom/client"
import { AuthProvider, useAuth } from "./AuthProvider"
import { Dashboard } from "./Dashboard"
import { LoginPage } from "./LoginPage"
import "./styles.css"

function AppRouter() {
  const { user, loading } = useAuth()

  if (loading) {
    return <div className="login-shell"><div className="login-card"><div className="login-brand"><span className="brand-mark">◈</span><span>OPS<span>CONTROL</span></span></div><p className="login-subtitle">Loading…</p></div></div>
  }

  if (!user) {
    return <LoginPage />
  }

  return <Dashboard />
}

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <AppRouter />
  </AuthProvider>,
)
