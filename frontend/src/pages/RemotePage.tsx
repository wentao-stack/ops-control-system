import { useEffect, useState } from "react"
import { api } from "../auth"
import { useAuth } from "../AuthProvider"
import { RemoteAsset, RemotePingResult } from "../types"
import { WebTerminal } from "../components/WebTerminal"

export function RemotePage() {
  const { token } = useAuth()
  const [remoteAssets, setRemoteAssets] = useState<RemoteAsset[]>([])
  const [remotePing, setRemotePing] = useState<RemotePingResult[]>([])
  const [selectedRemote, setSelectedRemote] = useState("")
  const [remoteCmd, setRemoteCmd] = useState("")
  const [remoteResult, setRemoteResult] = useState<{ stdout: string; stderr: string; exit_code: number; duration: number } | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteHistory, setRemoteHistory] = useState<{ cmd: string; result: { stdout: string; stderr: string; exit_code: number; duration: number } }[]>([])
  // WebSSH state
  const [activeTab, setActiveTab] = useState<"terminal" | "command">("terminal")
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null)
  const [openTerminals, setOpenTerminals] = useState<Set<string>>(new Set())

  const loadAssets = async () => {
    try {
      const r = await api<{ items: any[] }>(`/api/v1/assets?asset_type=host`)
      const assets = r.items.filter(a => a.ssh_host) as RemoteAsset[]
      setRemoteAssets(assets)
      // Auto-open first host
      if (assets.length > 0 && openTerminals.size === 0) {
        const first = assets[0].id
        setOpenTerminals(new Set([first]))
        setActiveTerminal(first)
      }
    } catch { /* silent */ }
  }

  const pingAll = async () => {
    try { setRemotePing(await api<RemotePingResult[]>("/api/v1/remote/ping", { method: "POST" })) }
    catch { /* silent */ }
  }

  useEffect(() => { void loadAssets(); void pingAll() }, [])

  const executeRemote = async () => {
    if (!selectedRemote || !remoteCmd.trim()) return
    setRemoteLoading(true)
    try {
      const r = await api<{ stdout: string; stderr: string; exit_code: number; duration: number }>("/api/v1/remote/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: selectedRemote, command: remoteCmd }),
      })
      setRemoteResult(r)
      setRemoteHistory(prev => [...prev, { cmd: remoteCmd, result: r }])
    } catch (e: any) {
      setRemoteResult({ stdout: "", stderr: String(e), exit_code: -1, duration: 0 })
    } finally { setRemoteLoading(false) }
  }

  const openTerminal = (assetId: string) => {
    setOpenTerminals(prev => new Set(prev).add(assetId))
    setActiveTerminal(assetId)
  }

  const closeTerminal = (assetId: string) => {
    setOpenTerminals(prev => {
      const next = new Set(prev)
      next.delete(assetId)
      return next
    })
    if (activeTerminal === assetId) {
      // Switch to another open terminal or null
      const remaining = [...openTerminals].filter(id => id !== assetId)
      setActiveTerminal(remaining.length > 0 ? remaining[remaining.length - 1] : null)
    }
  }

  const getAssetName = (assetId: string) => {
    return remoteAssets.find(a => a.id === assetId)?.name || assetId
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>終端</h1>
          <p>SSH 遠程管理 · {remoteAssets.length} 台主機</p>
        </div>
        <button className="btn btn-sm" onClick={() => { void pingAll(); void loadAssets() }}>↻ Ping 全部</button>
      </div>

      {/* Host status chips */}
      <div className="remote-hosts-row" style={{ marginBottom: 16 }}>
        {remotePing.map(p => (
          <div className={`remote-host-chip ${p.reachable ? "online" : "offline"}`} key={p.asset_id}>
            <span className={`host-dot ${p.reachable ? "online" : "offline"}`} />
            {p.name}
          </div>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        <button
          className={`tab-btn ${activeTab === "terminal" ? "active" : ""}`}
          onClick={() => setActiveTab("terminal")}
        >
          ⌨ 互動終端
        </button>
        <button
          className={`tab-btn ${activeTab === "command" ? "active" : ""}`}
          onClick={() => setActiveTab("command")}
        >
          ⚡ 快速命令
        </button>
      </div>

      {/* Terminal tab */}
      {activeTab === "terminal" && (
        <div className="terminal-page">
          {/* Terminal tabs */}
          <div className="terminal-tab-bar">
            {Array.from(openTerminals).map(id => (
              <div
                key={id}
                className={`terminal-tab ${activeTerminal === id ? "active" : ""}`}
                onClick={() => setActiveTerminal(id)}
              >
                <span className="terminal-tab-name">{getAssetName(id)}</span>
                <button
                  className="terminal-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeTerminal(id) }}
                  title="關閉"
                >
                  ×
                </button>
              </div>
            ))}
            {/* Open new terminal dropdown */}
            <select
              className="terminal-new-select"
              value=""
              onChange={(e) => { if (e.target.value) openTerminal(e.target.value) }}
              title="打開新終端"
            >
              <option value="">+ 新終端</option>
              {remoteAssets
                .filter(a => !openTerminals.has(a.id))
                .map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          {/* Active terminal — render ALL open terminals, show only active one */}
          {token ? (
            <div className="terminal-page">
              {Array.from(openTerminals).map(id => (
                <div
                  key={id}
                  style={{ display: activeTerminal === id ? "block" : "none" }}
                >
                  <WebTerminal
                    assetId={id}
                    assetName={getAssetName(id)}
                    token={token}
                    active={activeTerminal === id}
                    onDisconnect={() => {}}
                  />
                </div>
              ))}
              {openTerminals.size === 0 && (
                <div className="empty" style={{ minHeight: 400 }}>
                  {remoteAssets.length === 0 ? "沒有可連接的主機" : "選擇或打開一個終端"}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Command tab */}
      {activeTab === "command" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-body">
              <div className="remote-controls">
                <select value={selectedRemote} onChange={e => setSelectedRemote(e.target.value)}>
                  <option value="">選擇主機...</option>
                  {remoteAssets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <input className="remote-cmd-input" value={remoteCmd} onChange={e => setRemoteCmd(e.target.value)} placeholder="輸入命令 (例如: uptime, df -h, ls -la)" onKeyDown={e => { if (e.key === "Enter") void executeRemote() }} />
                <button className="remote-exec-btn" onClick={() => void executeRemote()} disabled={!selectedRemote || !remoteCmd.trim() || remoteLoading}>
                  {remoteLoading ? "⠋ 執行中..." : "▶ 執行"}
                </button>
              </div>
            </div>
          </div>

          {remoteResult && (
            <div className="remote-output">
              <div className="remote-output-header">
                <span className={`exit-code ${remoteResult.exit_code === 0 ? "success" : "fail"}`}>Exit: {remoteResult.exit_code}</span>
                <span className="remote-duration">{remoteResult.duration}s</span>
              </div>
              <pre className="remote-stdout">{remoteResult.stdout || "(no output)"}</pre>
              {remoteResult.stderr && <pre className="remote-stderr">{remoteResult.stderr}</pre>}
            </div>
          )}

          {remoteHistory.length > 0 && (
            <div className="remote-history">
              <h3>命令歷史</h3>
              {remoteHistory.map((h, i) => (
                <div className="history-item" key={i}>
                  <span className="history-cmd">$ {h.cmd}</span>
                  <pre className="history-output">{h.result.stdout || h.result.stderr || "(no output)"}</pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
