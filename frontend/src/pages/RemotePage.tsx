import { useEffect, useState } from "react"
import { api } from "../auth"
import { RemoteAsset, RemoteExecResult, RemotePingResult } from "../types"

export function RemotePage() {
  const [remoteAssets, setRemoteAssets] = useState<RemoteAsset[]>([])
  const [remotePing, setRemotePing] = useState<RemotePingResult[]>([])
  const [selectedRemote, setSelectedRemote] = useState("")
  const [remoteCmd, setRemoteCmd] = useState("")
  const [remoteResult, setRemoteResult] = useState<RemoteExecResult | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteHistory, setRemoteHistory] = useState<{ cmd: string; result: RemoteExecResult }[]>([])

  const loadAssets = async () => {
    try {
      const r = await api<{ items: any[] }>(`/api/v1/assets?asset_type=host`)
      setRemoteAssets(r.items.filter(a => a.ssh_host) as RemoteAsset[])
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
      const r = await api<RemoteExecResult>("/api/v1/remote/exec", {
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

  return (
    <>
      <div className="page-header">
        <div>
          <h1>遠程終端</h1>
          <p>SSH 遠程命令執行 · {remoteAssets.length} 台主機</p>
        </div>
        <button className="btn btn-sm" onClick={() => { void pingAll(); void loadAssets() }}>↻ Ping 全部</button>
      </div>

      <div className="remote-hosts-row">
        {remotePing.map(p => (
          <div className={`remote-host-chip ${p.reachable ? "online" : "offline"}`} key={p.asset_id}>
            <span className={`host-dot ${p.reachable ? "online" : "offline"}`} />
            {p.name}
          </div>
        ))}
      </div>

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
  )
}
