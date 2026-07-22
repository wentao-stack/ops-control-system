import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "xterm"
import { FitAddon } from "xterm-addon-fit"
import "xterm/css/xterm.css"

interface WebTerminalProps {
  assetId: string
  assetName: string
  token: string
  onDisconnect?: () => void
}

export function WebTerminal({ assetId, assetName, token, onDisconnect }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<"connecting" | "ready" | "error" | "closed">("connecting")
  const [errorMsg, setErrorMsg] = useState("")

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
    }

    setStatus("connecting")
    setErrorMsg("")

    // Determine WS protocol
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    const host = window.location.host
    const cols = 80
    const rows = 24
    const url = `${proto}//${host}/ws/ssh/${assetId}?cols=${cols}&rows=${rows}&token=${encodeURIComponent(token)}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log("WebSSH connected")
    }

    ws.onmessage = (event) => {
      if (termRef.current) {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === "data") {
            // Decode base64 terminal output
            const binary = atob(msg.data)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i)
            }
            termRef.current.write(bytes)
          } else if (msg.type === "ready") {
            setStatus("ready")
          } else if (msg.type === "exit") {
            setStatus("closed")
            termRef.current.writeln(`\r\n[Session ended (exit code: ${msg.code})]`)
            onDisconnect?.()
          } else if (msg.type === "error") {
            setStatus("error")
            setErrorMsg(msg.message)
            termRef.current.writeln(`\r\n[Error: ${msg.message}]`)
          }
        } catch {
          // Raw data, write directly
          termRef.current.write(event.data)
        }
      }
    }

    ws.onerror = () => {
      setStatus("error")
      setErrorMsg("WebSocket connection error")
    }

    ws.onclose = () => {
      if (status !== "closed") {
        setStatus("closed")
      }
    }
  }, [assetId, token])

  useEffect(() => {
    // Initialize xterm
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', 'Consolas', monospace",
      fontSize: 14,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#3b3e51",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit

    if (containerRef.current) {
      term.open(containerRef.current)
      // Small delay to ensure container is rendered
      requestAnimationFrame(() => {
        fit.fit()
      })
    }

    // Send input to server
    term.onData((data) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "data", data }))
      }
    })

    // Handle resize
    term.onResize((cols, rows) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }))
      }
    })

    // Fit on window resize
    const resizeObserver = new ResizeObserver(() => {
      setTimeout(() => fit.fit(), 100)
    })
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    // Auto-connect
    connect()

    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect])

  return (
    <div className="terminal-wrapper">
      <div className="terminal-header">
        <span className="terminal-host">
          <span className={`terminal-dot ${status === "ready" ? "online" : status === "error" ? "error" : "connecting"}`} />
          {assetName}
        </span>
        <span className="terminal-status">
          {status === "connecting" && "连接中..."}
          {status === "ready" && "已连接"}
          {status === "error" && `错误: ${errorMsg}`}
          {status === "closed" && "已断开"}
        </span>
        <div className="terminal-actions">
          <button
            className="btn btn-sm terminal-btn"
            onClick={connect}
            title="重新连接"
          >
            ↻
          </button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-container" />
    </div>
  )
}
