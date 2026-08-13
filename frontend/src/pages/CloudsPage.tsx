import { useState, useEffect } from "react"
import { api } from "../auth"
import { useTranslation } from "react-i18next"

/* ── Cloud Platform Dashboard ────────────────────────────────────────────────
   Fetches Vultr account balance & instances from API.
   ConoHa VPS 3.0 remains static (no API key configured yet).
   ─────────────────────────────────────────────────────────────────────────── */

interface VultrAccount {
  name: string
  email: string
  org_name: string
  country: string
  balance: string
  pending_charges: string
  prepayment_remaining: string
  last_payment_date: string
  last_payment_amount: string
  remaining_credit: string
  fetched_at: string
}

interface VultrInstance {
  id: string
  default_ip: string
  region: string
  plan: string
  status: string
  label: string
  hostname: string
  os: string
  vcpu_count: number
  memory: number
  disk: number
  created: string
  current_price: string
}

interface VultrInstancesData {
  instances: VultrInstance[]
  fetched_at: string
}

interface VultrBillingItem {
  id: number
  date: string
  type: string
  description: string
  amount: number
  balance: number
  status: string
}

interface VultrBillingHistoryData {
  billing_history: VultrBillingItem[]
}

/* ── ConoHa data (fetched from API) ─────────────────────────────────────────── */

interface ConoHaInstance {
  id: string
  name: string
  ip: string
  status: string
  region: string
  os: string
  created: string
  plan: string
  label: string
  hostname: string
  vcpu_count: number
  memory: number
  disk: number
  current_price: string
}

const VULTR_ENDPOINTS = [
  { method: "GET", path: "/account", desc: "Account info & balance" },
  { method: "GET", path: "/instances", desc: "List all instances" },
  { method: "GET", path: "/instances/{id}", desc: "Instance details" },
  { method: "POST", path: "/instances/{id}/reboot", desc: "Reboot instance" },
  { method: "POST", path: "/instances/{id}/action", desc: "Start / Stop / Halt" },
  { method: "POST", path: "/instances", desc: "Create instance" },
  { method: "DELETE", path: "/instances/{id}", desc: "Delete instance" },
  { method: "GET", path: "/plans", desc: "Available plans" },
  { method: "GET", path: "/regions", desc: "Available regions" },
]

const CONOHA_ENDPOINTS = [
  { method: "POST", path: "/v3/auth/tokens", desc: "Get auth token (identity)" },
  { method: "GET", path: "/v2.1/servers/detail", desc: "List all servers" },
  { method: "GET", path: "/v2.1/servers/{id}", desc: "Server details" },
  { method: "POST", path: "/v2.1/servers/{id}/os-server-actions", desc: "Reboot / Hard reboot" },
  { method: "POST", path: "/v2.1/servers", desc: "Create server" },
  { method: "DELETE", path: "/v2.1/servers/{id}", desc: "Delete server" },
  { method: "GET", path: "/v2.1/flavors", desc: "Available flavors" },
  { method: "GET", path: "/v2.1/images", desc: "Available images" },
]

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const statusColor = (s: string) => {
  const lower = s.toLowerCase()
  if (lower === "active") return "var(--success)"
  if (lower === "stopped" || lower === "suspended") return "var(--danger)"
  return "var(--warning)"
}

/* ── Sub-components ────────────────────────────────────────────────────────── */

function VultrInstanceCard({ inst }: { inst: VultrInstance }) {
  const name = inst.label || inst.hostname || inst.id
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: statusColor(inst.status),
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{name}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {inst.default_ip} · {inst.region} · {inst.os}
        </div>
      </div>
      {inst.current_price && (
        <span className="tag" style={{ marginLeft: "auto" }}>
          {inst.current_price}/mo
        </span>
      )}
      <span
        className="status"
        style={{
          background: statusColor(inst.status) + "18",
          color: statusColor(inst.status),
        }}
      >
        <i style={{ background: statusColor(inst.status) }} />
        {inst.status}
      </span>
    </div>
  )
}

function ConoHaInstanceCard({ inst }: { inst: ConoHaInstance }) {
  const name = inst.name || inst.hostname || inst.id
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: statusColor(inst.status),
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{name}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {inst.ip} · {inst.region} · {inst.os}
        </div>
      </div>
      {inst.current_price && (
        <span className="tag" style={{ marginLeft: "auto" }}>
          {inst.current_price}/mo
        </span>
      )}
      <span
        className="status"
        style={{
          background: statusColor(inst.status) + "18",
          color: statusColor(inst.status),
        }}
      >
        <i style={{ background: statusColor(inst.status) }} />
        {inst.status}
      </span>
    </div>
  )
}

function ApiTable({ endpoints }: { endpoints: { method: string; path: string; desc: string }[] }) {
  const methodColor = (m: string) => {
    if (m === "GET") return "#166534"
    if (m === "POST") return "#7c3aed"
    if (m === "DELETE") return "#dc2626"
    return "#0369a1"
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 70 }}>Method</th>
            <th>Endpoint</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e, i) => (
            <tr key={i}>
              <td>
                <span
                  style={{
                    display: "inline-block",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: methodColor(e.method) + "18",
                    color: methodColor(e.method),
                    fontWeight: 700,
                    fontSize: 11,
                    fontFamily: "monospace",
                  }}
                >
                  {e.method}
                </span>
              </td>
              <td style={{ fontFamily: "monospace", fontSize: 12 }}>{e.path}</td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{e.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export function CloudsPage() {
  const { t } = useTranslation()

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [vultrAccount, setVultrAccount] = useState<VultrAccount | null>(null)
  const [vultrInstances, setVultrInstances] = useState<VultrInstance[]>([])
  const [billingHistory, setBillingHistory] = useState<VultrBillingItem[]>([])
  const [conohaInstances, setConoHaInstances] = useState<ConoHaInstance[]>([])
  const [conohaLoading, setConoHaLoading] = useState(true)
  const [conohaError, setConoHaError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  // Fetch Vultr data on mount
  useEffect(() => {
    let cancelled = false
    const fetchAll = async () => {
      setLoading(true)
      setError(null)
      try {
        const [account, instances, billing] = await Promise.all([
          api<VultrAccount>("/api/v1/clouds/vultr/account").catch((e: Error) => {
            if (!cancelled) setError(e.message.includes("白名單") ? e.message : `Vultr API: ${e.message}`)
            return null
          }),
          api<VultrInstancesData>("/api/v1/clouds/vultr/instances").catch((e: Error) => {
            if (!cancelled) setError(e.message.includes("白名單") ? e.message : `Vultr API: ${e.message}`)
            return null
          }),
          api<VultrBillingHistoryData>("/api/v1/clouds/vultr/billing-history").catch((e: Error) => {
            if (!cancelled) setError(e.message.includes("白名單") ? e.message : `Vultr API: ${e.message}`)
            return null
          }),
        ])
        if (!cancelled) {
          if (account) setVultrAccount(account)
          if (instances) setVultrInstances(instances.instances ?? [])
          if (billing) setBillingHistory(billing.billing_history ?? [])
          setLoading(false)
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || "Unknown error")
          setLoading(false)
        }
      }
    }
    fetchAll()
    return () => { cancelled = true }
  }, [])

  // Fetch ConoHa data on mount
  useEffect(() => {
    let cancelled = false
    const fetchConoHa = async () => {
      setConoHaLoading(true)
      setConoHaError(null)
      try {
        const data = await api<VultrInstancesData>("/api/v1/clouds/conoha/instances").catch((e: Error) => {
          if (!cancelled) setConoHaError(`ConoHa API: ${e.message}`)
          return null
        })
        if (!cancelled) {
          if (data) {
            // Map VultrInstancesData shape to ConoHaInstance
            const mapped: ConoHaInstance[] = (data.instances ?? []).map((i) => ({
              id: i.id,
              name: i.label || i.hostname || i.id,
              ip: i.default_ip,
              status: i.status,
              region: i.region,
              os: i.os,
              created: i.created?.split("T")[0] ?? "",
              plan: i.plan,
              label: i.label,
              hostname: i.hostname,
              vcpu_count: i.vcpu_count,
              memory: i.memory,
              disk: i.disk,
              current_price: i.current_price,
            }))
            setConoHaInstances(mapped)
          }
          setConoHaLoading(false)
        }
      } catch (e: any) {
        if (!cancelled) {
          setConoHaError(e.message || "Unknown error")
          setConoHaLoading(false)
        }
      }
    }
    fetchConoHa()
    return () => { cancelled = true }
  }, [])

  const totalInstances = vultrInstances.length + conohaInstances.length
  const activeInstances =
    vultrInstances.filter((i) => i.status.toLowerCase() === "active").length +
    conohaInstances.filter((i) => i.status.toLowerCase() === "active").length

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t("clouds.title")}</h1>
          <p>{t("clouds.subtitle")}</p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: "10px 16px",
            marginBottom: 16,
            fontSize: 13,
            color: "#991b1b",
          }}
        >
          ⚠️  {error}
        </div>
      )}

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">{t("clouds.stats.platforms")}</div>
          <div className="stat-value">2</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t("clouds.stats.total")}</div>
          <div className="stat-value">{loading ? "—" : totalInstances}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t("clouds.stats.running")}</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>
            {loading ? "—" : activeInstances}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t("clouds.stats.domains")}</div>
          <div className="stat-value" style={{ color: "var(--info)" }}>
            1
          </div>
        </div>
      </div>

      {/* Cloud provider cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* ── Vultr (live data) ── */}
        <div className="card">
          <div
            className="card-header"
            style={{ cursor: "pointer" }}
            onClick={() => toggle("Vultr")}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🟠</span>
              <div>
                <h2 style={{ margin: 0 }}>
                  Vultr
                  {loading && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}> {t("common.loading")}</span>}
                </h2>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {vultrAccount ? `${vultrAccount.name} (${vultrAccount.email}) · ${t("clouds.account.remaining")} $${vultrAccount.remaining_credit} · 更新 ${new Date(vultrAccount.fetched_at).toLocaleTimeString("zh-TW")}` : t("clouds.apiKeyError")}
                </span>
              </div>
            </div>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                transition: "transform 0.2s",
                transform: expanded["Vultr"] ? "rotate(180deg)" : "rotate(0deg)",
              }}
            >
              ▼
            </span>
          </div>

          <div className="card-body">
            {/* Balance detail */}
            {vultrAccount && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("clouds.account.info")}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t("clouds.account.remaining")}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(vultrAccount.remaining_credit) > 0 ? "var(--success)" : "var(--danger)" }}>
                      ${vultrAccount.remaining_credit}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                      = |{vultrAccount.balance}| - {vultrAccount.pending_charges}
                    </div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t("clouds.account.balance")}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(vultrAccount.balance) < 0 ? "var(--danger)" : "var(--success)" }}>${vultrAccount.balance}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t("clouds.account.pending")}</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>${vultrAccount.pending_charges}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t("clouds.account.lastPayment")}</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>${vultrAccount.last_payment_amount}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{vultrAccount.last_payment_date?.split("T")[0] ?? ""}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Instances */}
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {t("clouds.instances.label")} ({vultrInstances.length})
              </h3>
              {vultrInstances.length === 0 && (loading ? <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("common.loading")}</p> : <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("clouds.noInstances")}</p>)}
              {vultrInstances.map((inst) => (
                <VultrInstanceCard key={inst.id} inst={inst} />
              ))}
            </div>

            {/* API Quick Reference */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600 }}>{t("clouds.api.ref")}</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <a href="https://www.vultr.com/api/" target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: "none" }}>
                    📖 t("common.docs")
                  </a>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)", background: "#f1f5f9", padding: "3px 8px", borderRadius: 4 }}>
                    https://api.vultr.com/v2
                  </span>
                </div>
              </div>
              <ApiTable endpoints={VULTR_ENDPOINTS} />
            </div>

            {/* SSH Info */}
            <div style={{ background: "#1a1b26", borderRadius: 6, padding: "12px 16px", fontFamily: "monospace", fontSize: 12, color: "#c0caf5", lineHeight: 1.8 }}>
              <div style={{ color: "#7aa2f7", marginBottom: 4 }}>{t("clouds.ssh.title")}</div>
              {vultrInstances.map((inst) => (
                <div key={inst.id}>
                  <span style={{ color: "#9ece6a" }}>ssh root@{inst.default_ip}</span>
                  <span style={{ color: "#565f89" }}> # {inst.label || inst.hostname}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── ConoHa VPS 3.0 (live data) ── */}
        <div className="card">
          <div
            className="card-header"
            style={{ cursor: "pointer" }}
            onClick={() => toggle("ConoHa")}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔵</span>
              <div>
                <h2 style={{ margin: 0 }}>
                  ConoHa VPS 3.0
                  {conohaLoading && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}> {t("common.loading")}</span>}
                </h2>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {conohaError
                    ? `API 連接失敗：${conohaError}`
                    : conohaInstances.length > 0
                      ? `${conohaInstances.length} 個實例 · 更新 ${new Date().toLocaleTimeString("zh-TW")}`
                      : "gnct58663219 (gncu58663219)"}
                </span>
              </div>
            </div>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                transition: "transform 0.2s",
                transform: expanded["ConoHa"] ? "rotate(180deg)" : "rotate(0deg)",
              }}
            >
              ▼
            </span>
          </div>

          <div className="card-body">
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {t("clouds.instances.label")} ({conohaInstances.length})
              </h3>
              {conohaInstances.length === 0 && (conohaLoading ? <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("common.loading")}</p> : <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("clouds.noInstances")}</p>)}
              {conohaInstances.map((inst) => (
                <ConoHaInstanceCard key={inst.id} inst={inst} />
              ))}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600 }}>{t("clouds.api.ref")}</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <a href="https://doc.conoha.jp/reference/api-vps3/" target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: "none" }}>
                    📖 t("common.docs")
                  </a>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)", background: "#f1f5f9", padding: "3px 8px", borderRadius: 4 }}>
                    https://compute.c3j1.conoha.io/v2.1
                  </span>
                </div>
              </div>
              <ApiTable endpoints={CONOHA_ENDPOINTS} />
            </div>

            <div style={{ background: "#1a1b26", borderRadius: 6, padding: "12px 16px", fontFamily: "monospace", fontSize: 12, color: "#c0caf5", lineHeight: 1.8 }}>
              <div style={{ color: "#7aa2f7", marginBottom: 4 }}>{t("clouds.ssh.title")}</div>
              {conohaInstances.map((inst) => (
                <div key={inst.id}>
                  <span style={{ color: "#9ece6a" }}>ssh root@{inst.ip}</span>
                  <span style={{ color: "#565f89" }}> # {inst.name} · {inst.os}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Namecheap DNS section */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>🌐</span>
            <div>
              <h2 style={{ margin: 0 }}>Namecheap DNS</h2>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                caiwentao · DNS 管理
              </span>
            </div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 16 }}>
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>已配置域名</h3>
              <div style={{ fontFamily: "monospace", fontSize: 12, background: "#f8fafc", padding: "8px 12px", borderRadius: 6, lineHeight: 2 }}>
                <div><span style={{ color: "var(--primary)" }}>ops</span>.sanbunto.online → 163.44.124.142</div>
                <div><span style={{ color: "var(--primary)" }}>comfy</span>.sanbunto.online → 163.44.124.142</div>
                <div><span style={{ color: "var(--primary)" }}>nexus</span>.sanbunto.online → 163.44.124.142</div>
                <div><span style={{ color: "var(--primary)" }}>llama</span>.sanbunto.online → 163.44.124.142</div>
                <div><span style={{ color: "var(--primary)" }}>audio</span>.sanbunto.online → 163.44.124.142</div>
                <div><span style={{ color: "var(--primary)" }}>ollama</span>.sanbunto.online → 163.44.124.142</div>
              </div>
            </div>
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>API 限制</h3>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8 }}>
                <p>⚠️  個人帳號，API 功能有限</p>
                <p>主要支援 DNS 操作（AddHosts / DeleteHosts / GetHosts）</p>
                <p>受 Cloudflare 保護，瀏覽器自動化不穩定</p>
                <p>驗證郵箱: caiwentao2823703@gmail.com</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}