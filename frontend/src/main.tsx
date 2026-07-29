import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AuthProvider, useAuth } from "./AuthProvider"
import { LoginPage } from "./LoginPage"
import { Layout } from "./Layout"
import { OverviewPage } from "./pages/OverviewPage"
import { AssetsPage } from "./pages/AssetsPage"
import { AssetDetailPage } from "./pages/AssetDetailPage"
import { MonitoringPage } from "./pages/MonitoringPage"
import { RemotePage } from "./pages/RemotePage"
import { SettingsPage } from "./pages/SettingsPage"
import { ServicesPage } from "./pages/ServicesPage"
import { CloudsPage } from "./pages/CloudsPage"
import { NotesPage } from "./pages/NotesPage"
import { NoteDetailPage } from "./pages/NoteDetailPage"
import "./styles.css"

function AppRoutes() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-brand"><span className="brand-mark">◆</span><span>OPS<span>CONTROL</span></span></div>
          <p className="login-subtitle">載入中…</p>
        </div>
      </div>
    )
  }

  if (!user) return <LoginPage />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:assetId" element={<AssetDetailPage />} />
        <Route path="/monitoring" element={<MonitoringPage />} />
        <Route path="/remote" element={<RemotePage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/clouds" element={<CloudsPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/notes/:noteId" element={<NoteDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
