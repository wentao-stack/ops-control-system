import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AuthProvider, useAuth } from "./AuthProvider"
import { LoginPage } from "./LoginPage"
import { AdminLayout, RequireAuthOutlet } from "./AdminLayout"
import { ShareHomePage } from "./pages/ShareHomePage"
import { SharePostPage } from "./pages/SharePostPage"
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
import { AgentChatPage } from "./pages/AgentChatPage"
import { CodeBrowsePage } from "./pages/CodeBrowsePage"
import { ComfyUIPage } from "./pages/ComfyUIPage"
import { SequenceStudioPage } from "./pages/SequenceStudioPage"
import WorkflowPage from "./pages/WorkflowPage"
import "./i18n"
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

  return (
    <Routes>
      {/* Public routes — no login required */}
      <Route path="/" element={<ShareHomePage />} />
      <Route path="/p/:postId" element={<SharePostPage />} />
      <Route path="/login" element={user ? <Navigate to="/admin/overview" replace /> : <LoginPage />} />

      {/* Admin routes — require login */}
      <Route element={<RequireAuthOutlet />}>
        <Route element={<AdminLayout />}>
          <Route path="/admin/overview" element={<OverviewPage />} />
          <Route path="/admin/assets" element={<AssetsPage />} />
          <Route path="/admin/assets/:assetId" element={<AssetDetailPage />} />
          <Route path="/admin/monitoring" element={<MonitoringPage />} />
          <Route path="/admin/remote" element={<RemotePage />} />
          <Route path="/admin/services" element={<ServicesPage />} />
          <Route path="/admin/settings" element={<SettingsPage />} />
          <Route path="/admin/clouds" element={<CloudsPage />} />
          <Route path="/admin/notes" element={<NotesPage />} />
          <Route path="/admin/notes/:noteId" element={<NoteDetailPage />} />
          <Route path="/admin/agent" element={<AgentChatPage />} />
          <Route path="/admin/workflow" element={<WorkflowPage />} />
          <Route path="/admin/code" element={<CodeBrowsePage />} />
          <Route path="/admin/comfyui" element={<ComfyUIPage />} />
          <Route path="/admin/sequence-studio" element={<SequenceStudioPage />} />
          <Route path="*" element={<Navigate to="/admin/overview" replace />} />
        </Route>
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
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
