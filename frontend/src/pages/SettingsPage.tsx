import { useTranslation } from "react-i18next"
export function SettingsPage() {
  const { t } = useTranslation()
return (
    <>
      <div className="page-header">
        <div><h1>{t("settings.title")}</h1><p>OPS Control System v0.1.0</p></div>
      </div>
      <div className="card">
        <div className="card-body" style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.8 }}>
          <p><strong style={{ color: "var(--text)" }}>OPS Control System</strong> — {t("settings.subtitle")}</p>
          <p style={{ marginTop: 8 }}>{t("settings.backend")}: FastAPI + SQLite · {t("settings.frontend")}: React + Vite + React Router</p>
          <p style={{ marginTop: 8 }}>{t("settings.modules")}</p>
        </div>
      </div>
    </>
  )
}