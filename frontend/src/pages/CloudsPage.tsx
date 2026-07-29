import { useState } from "react"

/* ── Cloud Platform Dashboard ────────────────────────────────────────────────
   Static reference page for Vultr & ConoHa VPS 3.0 accounts.
   All sensitive values are stored server-side; this page shows structure only.
   ─────────────────────────────────────────────────────────────────────────── */

interface Instance {
  id: string
  name: string
  ip: string
  status: string
  region: string
  os: string
  created: string
  plan?: string
}

interface CloudAccount {
  provider: string
  icon: string
  color: string
  account: string
  balance?: string
  instances: Instance[]
  apiBase: string
  apiDoc: string
  endpoints: { method: string; path: string; desc: string }[]
}

const CLOUDS: CloudAccount[] = [
  {
    provider: "Vultr",
    icon: "🟠",
    color: "#6b21a3",
    account: "Linux Wen (cwt1196811479@163.com)",
    balance: "$6.22",
    instances: [
      {
        id: "vultr-149-28-44-218",
        name: "Vultr Alpine",
        ip: "149.28.44.218",
        status: "active",
        region: "ewr (New Jersey)",
        os: "Alpine Linux",
        created: "2018-05-31",
        plan: "$2.5/mo",
      },
    ],
    apiBase: "https://api.vultr.com/v2",
    apiDoc: "https://www.vultr.com/api/",
    endpoints: [
      { method: "GET", path: "/account", desc: "Account info & balance" },
      { method: "GET", path: "/instances", desc: "List all instances" },
      { method: "GET", path: "/instances/{id}", desc: "Instance details" },
      { method: "POST", path: "/instances/{id}/reboot", desc: "Reboot instance" },
      { method: "POST", path: "/instances/{id}/action", desc: "Start / Stop / Halt" },
      { method: "POST", path: "/instances", desc: "Create instance" },
      { method: "DELETE", path: "/instances/{id}", desc: "Delete instance" },
      { method: "GET", path: "/plans", desc: "Available plans" },
      { method: "GET", path: "/regions", desc: "Available regions" },
    ],
  },
  {
    provider: "ConoHa VPS 3.0",
    icon: "🔵",
    color: "#1d4ed8",
    account: "gnct58663219 (gncu58663219)",
    instances: [
      {
        id: "6a3f90c8-07af-4594-a2c7-991237d77ecd",
        name: "vm-6d4d176a-a5",
        ip: "163.44.124.142",
        status: "ACTIVE",
        region: "c3j1 (Japan)",
        os: "Arch Linux",
        created: "2026-06-26",
      },
    ],
    apiBase: "https://compute.c3j1.conoha.io/v2.1",
    apiDoc: "https://doc.conoha.jp/reference/api-vps3/",
    endpoints: [
      { method: "POST", path: "/v3/auth/tokens", desc: "Get auth token (identity)" },
      { method: "GET", path: "/v2.1/servers/detail", desc: "List all servers" },
      { method: "GET", path: "/v2.1/servers/{id}", desc: "Server details" },
      { method: "POST", path: "/v2.1/servers/{id}/os-server-actions", desc: "Reboot / Hard reboot" },
      { method: "POST", path: "/v2.1/servers", desc: "Create server" },
      { method: "DELETE", path: "/v2.1/servers/{id}", desc: "Delete server" },
      { method: "GET", path: "/v2.1/flavors", desc: "Available flavors" },
      { method: "GET", path: "/v2.1/images", desc: "Available images" },
    ],
  },
]

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const statusColor = (s: string) => {
  const lower = s.toLowerCase()
  if (lower === "active") return "var(--success)"
  if (lower === "stopped" || lower === "suspended") return "var(--danger)"
  return "var(--warning)"
}

/* ── Sub-components ────────────────────────────────────────────────────────── */

function InstanceCard({ inst }: { inst: Instance }) {
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
      <span className="tag" style={{ marginLeft: "auto" }}>
        {inst.plan ?? ""}
      </span>
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

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <>
      <div className="page-header">
        <div>
          <h1>雲平台管理</h1>
          <p>Vultr · ConoHa VPS 3.0 · Namecheap DNS</p>
        </div>
      </div>

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">雲平台數</div>
          <div className="stat-value">{CLOUDS.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">總實例數</div>
          <div className="stat-value">
            {CLOUDS.reduce((sum, c) => sum + c.instances.length, 0)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">運行中</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>
            {CLOUDS.reduce(
              (sum, c) =>
                sum +
                c.instances.filter((i) => i.status.toLowerCase() === "active").length,
              0
            )}
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
        {CLOUDS.map((cloud) => (
          <div key={cloud.provider} className="card">
            {/* Header */}
            <div
              className="card-header"
              style={{ cursor: "pointer" }}
              onClick={() => toggle(cloud.provider)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>{cloud.icon}</span>
                <div>
                  <h2 style={{ margin: 0 }}>{cloud.provider}</h2>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {cloud.account}
                    {cloud.balance ? ` · 餘額 ${cloud.balance}` : ""}
                  </span>
                </div>
              </div>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  transition: "transform 0.2s",
                  transform: expanded[cloud.provider] ? "rotate(180deg)" : "rotate(0deg)",
                }}
              >
                ▼
              </span>
            </div>

            {/* Body */}
            <div className="card-body">
              {/* Instances */}
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  實例 ({cloud.instances.length})
                </h3>
                {cloud.instances.map((inst) => (
                  <InstanceCard key={inst.id} inst={inst} />
                ))}
              </div>

              {/* API Quick Reference */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <h3 style={{ fontSize: 13, fontWeight: 600 }}>
                    API 端點速查
                  </h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    <a
                      href={cloud.apiDoc}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-sm"
                      style={{ textDecoration: "none" }}
                    >
                      📖 文件
                    </a>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "var(--text-secondary)",
                        background: "#f1f5f9",
                        padding: "3px 8px",
                        borderRadius: 4,
                      }}
                    >
                      {cloud.apiBase}
                    </span>
                  </div>
                </div>
                <ApiTable endpoints={cloud.endpoints} />
              </div>

              {/* SSH Info */}
              <div
                style={{
                  background: "#1a1b26",
                  borderRadius: 6,
                  padding: "12px 16px",
                  fontFamily: "monospace",
                  fontSize: 12,
                  color: "#c0caf5",
                  lineHeight: 1.8,
                }}
              >
                <div style={{ color: "#7aa2f7", marginBottom: 4 }}>
                  SSH 連接方式
                </div>
                {cloud.provider === "Vultr" && (
                  <div>
                    <span style={{ color: "#9ece6a" }}>ssh root@{cloud.instances[0]?.ip}</span>
                    <span style={{ color: "#565f89" }}> # 密碼認證</span>
                  </div>
                )}
                {cloud.provider === "ConoHa VPS 3.0" && (
                  <div>
                    <span style={{ color: "#9ece6a" }}>
                      ssh root@{cloud.instances[0]?.ip}
                    </span>
                    <span style={{ color: "#565f89" }}>
                      {" "}
                      # Arch Linux · Nginx + FRP
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: 16,
            }}
          >
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                已配置域名
              </h3>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  background: "#f8fafc",
                  padding: "8px 12px",
                  borderRadius: 6,
                  lineHeight: 2,
                }}
              >
                <div>
                  <span style={{ color: "var(--primary)" }}>ops</span>
                  .sanbunto.online → 163.44.124.142
                </div>
                <div>
                  <span style={{ color: "var(--primary)" }}>comfy</span>
                  .sanbunto.online → 163.44.124.142
                </div>
                <div>
                  <span style={{ color: "var(--primary)" }}>nexus</span>
                  .sanbunto.online → 163.44.124.142
                </div>
                <div>
                  <span style={{ color: "var(--primary)" }}>llama</span>
                  .sanbunto.online → 163.44.124.142
                </div>
                <div>
                  <span style={{ color: "var(--primary)" }}>audio</span>
                  .sanbunto.online → 163.44.124.142
                </div>
                <div>
                  <span style={{ color: "var(--primary)" }}>ollama</span>
                  .sanbunto.online → 163.44.124.142
                </div>
              </div>
            </div>
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                API 限制
              </h3>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8 }}>
                <p>
                  ⚠️ 個人帳號，API 功能有限
                </p>
                <p>
                  主要支援 DNS 操作（AddHosts / DeleteHosts / GetHosts）
                </p>
                <p>
                  受 Cloudflare 保護，瀏覽器自動化不穩定
                </p>
                <p>
                  驗證郵箱: caiwentao2823703@gmail.com
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
