export function SettingsPage() {
  return (
    <>
      <div className="page-header">
        <div><h1>系統設定</h1><p>OPS Control System v0.1.0</p></div>
      </div>
      <div className="card">
        <div className="card-body" style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.8 }}>
          <p><strong style={{ color: "var(--text)" }}>OPS Control System</strong> — 基礎設施運維管理控制台</p>
          <p style={{ marginTop: 8 }}>後端: FastAPI + SQLite · 前端: React + Vite + React Router</p>
          <p style={{ marginTop: 8 }}>功能模組: 資產管理 / 主機監控 / 遠程終端控制</p>
        </div>
      </div>
    </>
  )
}
