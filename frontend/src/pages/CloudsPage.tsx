import { useState, useEffect } from "react"
import { api } from "../auth"

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

/* ── Static ConoHa data ────────────────────────────────────────────────────── */

interface StaticInstance {
  id: string
  name: string
  ip: string
  status: string
  region: string
  os: string
  created: string
}

const CONOHA_INSTANCES: StaticInstance[] = [
  {
    id: "6a3f90c8-07af-4594-a2c7-991237d77ecd",
    name: "vm-6d4d176a-a5",
    ip: "163.44.124.142",
    status: "ACTIVE",
    region: "c3j1 (Japan)",
    os: "Arch Linux",
    created: "2026-06-26",
  },
]

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

function StaticInstanceCard({ inst }: { inst: StaticInstance }) {
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
        <div style={{ fontWeight: 600, fontSize: 13 }}>{inst.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {inst.ip} · {inst.region} · {inst.os}
        </div>
      </div>
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [vultrAccount, setVultrAccount] = useState<VultrAccount | null>(null)
  const [vultrInstances, setVultrInstances] = useState<VultrInstance[]>([])
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
        const [account, instances] = await Promise.all([
          api<VultrAccount>("/api/v1/clouds/vultr/account").catch((e: Error) => {
            if (!cancelled) setError(`Vultr API: ${e.message}`)
            return null
          }),
          api<VultrInstancesData>("/api/v1/clouds/vultr/instances").catch((e: Error) => {
            if (!cancelled) setError(`Vultr API: ${e.message}`)
            return null
          }),
        ])
        if (!cancelled) {
          if (account) setVultrAccount(account)
          if (instances) setVultrInstances(instances.instances ?? [])
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

  const totalInstances = vultrInstances.length + CONOHA_INSTANCES.length
  const activeInstances =
    vultrInstances.filter((i) => i.status.toLowerCase() === "active").length +
    CONOHA_INSTANCES.filter((i) => i.status.toLowerCase() === "active").length

  return (
    <>
      <div className="page-header">
        <div>
          <h1>雲平台管理</h1>
          <p>Vultr · ConoHa VPS 3.0 · Namecheap DNS</p>
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
          ⚠️ {error}
        </div>
      )}

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">雲平台數</div>
          <div className="stat-value">2</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">總實例數</div>
          <div className="stat-value">{loading ? "—" : totalInstances}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">運行中</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>
            {loading ? "—" : activeInstances}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Namecheap 域名</div>
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
                  {loading && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}> (載入中…)</span>}
                </h2>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {vultrAccount
                    ? `${vultrAccount.name} (${vultrAccount.email}) · 餘額 $${vultrAccount.balance} · 更新 ${new Date(vultrAccount.fetched_at).toLocaleTimeString("zh-TW")}`
                    : "API 連接失敗，請檢查 VULTR_API_KEY"}
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
                <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>帳號資訊</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>當前餘額</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(vultrAccount.balance) < 0 ? "var(--danger)" : "var(--success)" }}>${vultrAccount.balance}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>下期待扣</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>${vultrAccount.pending_charges}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>上次付款</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>${vultrAccount.last_payment_amount}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{vultrAccount.last_payment_date?.split("T")[0] ?? ""}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 6, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>組織</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{vultrAccount.org_name}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Instances */}
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                實例 ({vultrInstances.length})
              </h3>
              {vultrInstances.length === 0 && (loading ? <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>載入中…</p> : <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>無實例或 API 連接失敗</p>)}
              {vultrInstances.map((inst) => (
                <VultrInstanceCard key={inst.id} inst={inst} />
              ))}
            </div>

            {/* API Quick Reference */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600 }}>API 端點速查</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <a href="https://www.vultr.com/api/" target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: "none" }}>
                    📖 文件
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
              <div style={{ color: "#7aa2f7", marginBottom: 4 }}>SSH 連接方式</div>
              {vultrInstances.map((inst) => (
                <div key={inst.id}>
                  <span style={{ color: "#9ece6a" }}>ssh root@{inst.default_ip}</span>
                  <span style={{ color: "#565f89" }}> # {inst.label || inst.hostname}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── ConoHa VPS 3.0 (static) ── */}
        <div className="card">
          <div
            className="card-header"
            style={{ cursor: "pointer" }}
            onClick={() => toggle("ConoHa")}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔵</span>
              <div>
                <h2 style={{ margin: 0 }}>ConoHa VPS 3.0</h2>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  gnct58663219 (gncu58663219)
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
                實例 ({CONOHA_INSTANCES.length})
              </h3>
              {CONOHA_INSTANCES.map((inst) => (
                <StaticInstanceCard key={inst.id} inst={inst} />
              ))}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600 }}>API 端點速查</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <a href="https://doc.conoha.jp/reference/api-vps3/" target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: "none" }}>
                    📖 文件
                  </a>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)", background: "#f1f5f9", padding: "3px 8px", borderRadius: 4 }}>
                    https://compute.c3j1.conoha.io/v2.1
                  </span>
                </div>
              </div>
              <ApiTable endpoints={CONOHA_ENDPOINTS} />
            </div>

            <div style={{ background: "#1a1b26", borderRadius: 6, padding: "12px 16px", fontFamily: "monospace", fontSize: 12, color: "#c0caf5", lineHeight: 1.8 }}>
              <div style={{ color: "#7aa2f7", marginBottom: 4 }}>SSH 連接方式</div>
              <div>
                <span style={{ color: "#9ece6a" }}>ssh root@{CONOHA_INSTANCES[0]?.ip}</span>
                <span style={{ color: "#565f89" }}> # Arch Linux · Nginx + FRP</span>
              </div>
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
                <p>⚠️ 個人帳號，API 功能有限</p>
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
