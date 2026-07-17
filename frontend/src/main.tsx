import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Health = "healthy" | "warning" | "critical" | "unknown";
type Asset = { id: string; name: string; asset_type: string; environment: string; owner: string; criticality: string; health_status: Health; health_summary: string | null; last_seen_at: string | null };
type Service = { id: string; name: string; service_type: string; status: Health; status_summary: string | null; observed_at: string | null };
type AssetDetail = Asset & { services: Service[] };
type Summary = { total: number; by_health: Record<Health, number>; by_environment: Record<string, number>; generated_at: string };

const healthLabels: Record<Health, string> = { healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "Unknown" };
const api = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
};
const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value)) : "No observation";

function StatusPill({ status }: { status: Health }) {
  return <span className={`status status-${status}`}><i />{healthLabels[status]}</span>;
}

function MetricCard({ label, count, status }: { label: string; count: number; status: Health | "total" }) {
  return <article className="metric-card"><span className={`metric-icon ${status}`}><i /></span><div><p>{label}</p><strong>{count}</strong></div></article>;
}

function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [query, setQuery] = useState("");
  const [environment, setEnvironment] = useState("");
  const [health, setHealth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = async () => {
    setLoading(true); setError(false);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (environment) params.set("environment", environment);
      if (health) params.set("health", health);
      const [nextSummary, result] = await Promise.all([api<Summary>("/api/v1/inventory/summary"), api<{ items: Asset[] }>(`/api/v1/assets?${params}`)]);
      setSummary(nextSummary); setAssets(result.items);
    } catch { setError(true); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [query, environment, health]);
  const distribution = useMemo(() => summary ? (Object.entries(summary.by_health) as [Health, number][]).filter(([, count]) => count > 0) : [], [summary]);
  const openAsset = async (asset: Asset) => { try { setSelected(await api<AssetDetail>(`/api/v1/assets/${asset.id}`)); } catch { setError(true); } };

  return <main className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">◈</span><span>OPS<span>CONTROL</span></span></div><nav><a className="active" href="#overview">Overview</a><a href="#assets">Assets <b>{summary?.total ?? "–"}</b></a><a className="disabled" href="#alerts">Alerts <em>Soon</em></a><a className="disabled" href="#changes">Changes <em>Soon</em></a><a className="disabled" href="#runbooks">Runbooks <em>Soon</em></a></nav><div className="sidebar-note"><span>●</span> Development only<br /><small>Sanitized local inventory</small></div></aside>
    <section className="content">
      <header><div><p className="eyebrow">INVENTORY / OVERVIEW</p><h1>Infrastructure at a glance.</h1><p className="subhead">A read-only view of your development inventory. No live hosts are contacted.</p></div><button className="refresh" onClick={() => void load()} aria-label="Refresh inventory">↻ <span>Refresh</span></button></header>
      {error && <div className="notice error">Could not load inventory data. Confirm the local API is running, then refresh.</div>}
      <section id="overview" className="metrics">
        <MetricCard label="Total assets" count={summary?.total ?? 0} status="total" />
        <MetricCard label="Healthy" count={summary?.by_health.healthy ?? 0} status="healthy" />
        <MetricCard label="Needs attention" count={(summary?.by_health.warning ?? 0) + (summary?.by_health.critical ?? 0)} status="warning" />
        <MetricCard label="Unknown" count={summary?.by_health.unknown ?? 0} status="unknown" />
      </section>
      <section className="overview-grid"><article className="panel health-panel"><div className="panel-heading"><div><p className="eyebrow">HEALTH DISTRIBUTION</p><h2>Current state</h2></div><span className="live-dot">Fixture data</span></div><div className="distribution">{distribution.map(([key, count]) => <div className="distribution-row" key={key}><div><StatusPill status={key} /><strong>{count}</strong></div><div className="track"><span className={key} style={{ width: `${summary ? (count / summary.total) * 100 : 0}%` }} /></div></div>)}</div></article>
      <article className="panel environment-panel"><p className="eyebrow">ENVIRONMENTS</p><h2>Coverage</h2><div className="environment-list">{Object.entries(summary?.by_environment ?? {}).map(([name, count]) => <div key={name}><span className={`env-dot ${name}`} /><p>{name}</p><strong>{count}</strong></div>)}</div></article></section>
      <section id="assets" className="panel assets-panel"><div className="panel-heading asset-title"><div><p className="eyebrow">ASSET DIRECTORY</p><h2>Inventory assets <span>{assets.length} shown</span></h2></div><div className="updated">Updated {summary ? formatTime(summary.generated_at) : "…"}</div></div><div className="filters"><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" /></label><select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="">All environments</option><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select><select value={health} onChange={(event) => setHealth(event.target.value)}><option value="">All health states</option>{Object.entries(healthLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{(query || environment || health) && <button className="clear" onClick={() => { setQuery(""); setEnvironment(""); setHealth(""); }}>Clear filters</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>Asset</th><th>Environment</th><th>Owner</th><th>Criticality</th><th>Health</th><th>Last observed</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="empty">Loading inventory…</td></tr> : assets.length === 0 ? <tr><td colSpan={7} className="empty">No assets match the current filters.</td></tr> : assets.map((asset) => <tr key={asset.id} onClick={() => void openAsset(asset)}><td><strong>{asset.name}</strong><small>{asset.asset_type}</small></td><td><span className="environment-tag">{asset.environment}</span></td><td>{asset.owner}</td><td><span className={`criticality ${asset.criticality}`}>{asset.criticality}</span></td><td><StatusPill status={asset.health_status} /></td><td>{formatTime(asset.last_seen_at)}</td><td className="chevron">›</td></tr>)}</tbody></table></div></section>
    </section>
    {selected && <aside className="drawer"><button className="close" onClick={() => setSelected(null)}>×</button><p className="eyebrow">ASSET DETAIL</p><h2>{selected.name}</h2><div className="drawer-meta"><span>{selected.asset_type}</span><span>{selected.environment}</span><span>{selected.criticality} criticality</span></div><StatusPill status={selected.health_status} /><p className="summary-copy">{selected.health_summary}</p><dl><div><dt>Owner</dt><dd>{selected.owner}</dd></div><div><dt>Last observed</dt><dd>{formatTime(selected.last_seen_at)}</dd></div></dl><h3>Associated services</h3>{selected.services.length ? selected.services.map((service) => <article className="service" key={service.id}><div><strong>{service.name}</strong><small>{service.service_type}</small></div><StatusPill status={service.status} /><p>{service.status_summary}</p></article>) : <p className="empty-copy">No services recorded for this asset.</p>}<p className="privacy-note">This view deliberately excludes network addresses, credentials, ports, and raw logs.</p></aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
