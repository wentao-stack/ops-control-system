import { useEffect, useState, useCallback } from 'react';
import { api } from '../auth';

interface TreeItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeItem[];
}

interface TreeResponse {
  tree: TreeItem[];
  total_files: number;
  total_dirs: number;
}

interface FileResponse {
  path: string;
  content: string;
  language: string;
  line_count: number;
}

/* ── Icon helpers ─────────────────────────────────────────────────────── */
function fileIcon(name: string): string {
  if (name.endsWith('.tsx') || name.endsWith('.jsx')) return '⚛️';
  if (name.endsWith('.ts')) return '🔷';
  if (name.endsWith('.py')) return '🐍';
  if (name.endsWith('.js')) return '📜';
  if (name.endsWith('.css')) return '🎨';
  if (name.endsWith('.html')) return '🌐';
  if (name.endsWith('.json')) return '📦';
  if (name.endsWith('.md')) return '📝';
  if (name.endsWith('.toml') || name.endsWith('.yaml') || name.endsWith('.yml')) return '⚙️';
  if (name.endsWith('.sh') || name.endsWith('.bash')) return '🚀';
  if (name.endsWith('.sql')) return '🗄️';
  if (name.endsWith('.conf')) return '⚙️';
  return '📄';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

/* ── Recursive Tree Node ──────────────────────────────────────────────── */
function TreeNode({
  item,
  depth,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggle,
}: {
  item: TreeItem;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(item.path);
  const isSelected = selectedPath === item.path;

  return (
    <div>
      <div
        className={`tree-node ${isSelected ? 'tree-node--selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (item.type === 'dir') onToggle(item.path);
          else onSelect(item.path);
        }}
      >
        <span className="tree-arrow">
          {item.type === 'dir'
            ? isExpanded
              ? '▼'
              : '▶'
            : '\u00A0'}
        </span>
        <span className="tree-icon">
          {item.type === 'dir' ? (isExpanded ? '📂' : '📁') : fileIcon(item.name)}
        </span>
        <span className="tree-name">{item.name}</span>
        {item.type === 'file' && item.size !== undefined && (
          <span className="tree-size">{formatSize(item.size)}</span>
        )}
      </div>
      {item.type === 'dir' && isExpanded &&
        item.children?.map((child) => (
          <TreeNode
            key={child.path}
            item={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

/* ── Main Page ────────────────────────────────────────────────────────── */
export function CodeBrowsePage() {
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [stats, setStats] = useState({ files: 0, dirs: 0 });
  const [selectedFile, setSelectedFile] = useState<FileResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  /* Load tree */
  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<TreeResponse>('/api/v1/code/tree');
      setTree(data.tree);
      setStats({ files: data.total_files, dirs: data.total_dirs });
      // Auto-expand top-level dirs
      const initialExpanded = new Set<string>();
      for (const item of data.tree) {
        if (item.type === 'dir') initialExpanded.add(item.path);
      }
      setExpandedPaths(initialExpanded);
    } catch (e: any) {
      setError(e.message || 'Failed to load file tree');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  /* Load file content */
  const loadFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setFileLoading(true);
      try {
        const data = await api<FileResponse>(`/api/v1/code/file/${encodeURIComponent(path)}`);
        setSelectedFile(data);
      } catch (e: any) {
        setError(e.message || 'Failed to load file');
        setSelectedFile(null);
      } finally {
        setFileLoading(false);
      }
    },
    []
  );

  /* Toggle directory expand/collapse */
  const toggleDir = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /* Filter tree based on search */
  function filterTree(items: TreeItem[], query: string): TreeItem[] {
    if (!query) return items;
    const q = query.toLowerCase();
    return items
      .map((item) => {
        if (item.type === 'dir' && item.children) {
          const filtered = filterTree(item.children, q);
          return filtered.length > 0
            ? { ...item, children: filtered }
            : null;
        }
        return item.name.toLowerCase().includes(q) ? item : null;
      })
      .filter(Boolean) as TreeItem[];
  }

  const filteredTree = filterTree(tree, searchQuery);

  /* Line numbers for code display */
  const lines = selectedFile?.content.split('\n') ?? [];

  return (
    <div className="code-browse">
      {/* Header */}
      <div className="code-browse__header">
        <h2>📂 Source Code Browser</h2>
        <div className="code-browse__stats">
          <span>{stats.dirs} directories</span>
          <span>·</span>
          <span>{stats.files} files</span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="alert alert--error" onClick={() => setError(null)}>
          ❌ {error}
        </div>
      )}

      {/* Search */}
      <div className="code-browse__search">
        <input
          type="text"
          placeholder="🔍 Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input"
        />
        <button className="btn btn--sm" onClick={() => { loadTree(); }}>
          🔄 Refresh
        </button>
      </div>

      {/* Two-column layout */}
      <div className="code-browse__layout">
        {/* Left: File tree */}
        <div className="code-browse__tree">
          {loading ? (
            <div className="loading">Loading file tree...</div>
          ) : (
            filteredTree.map((item) => (
              <TreeNode
                key={item.path}
                item={item}
                depth={0}
                selectedPath={selectedPath}
                onSelect={loadFile}
                expandedPaths={expandedPaths}
                onToggle={toggleDir}
              />
            ))
          )}
        </div>

        {/* Right: Code viewer */}
        <div className="code-browse__viewer">
          {fileLoading ? (
            <div className="loading">Loading file...</div>
          ) : selectedFile ? (
            <div className="code-browse__file">
              <div className="code-browse__file-header">
                <span className="code-browse__file-path">
                  {fileIcon(selectedFile.path)} {selectedFile.path}
                </span>
                <div className="code-browse__file-meta">
                  <span>{selectedFile.language}</span>
                  <span>·</span>
                  <span>{selectedFile.line_count} lines</span>
                </div>
              </div>
              <div className="code-browse__code">
                <pre>
                  {lines.map((line, i) => (
                    <div key={i} className="code-line">
                      <span className="code-line-num">{i + 1}</span>
                      <span className="code-line-text">{line}</span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          ) : (
            <div className="code-browse__empty">
              <div className="code-browse__empty-icon">📄</div>
              <p>Select a file from the tree to view its contents</p>
            </div>
          )}
        </div>
      </div>

      {/* Inline styles */}
      <style>{`
        .code-browse {
          height: 100%;
          display: flex;
          flex-direction: column;
        }

        .code-browse__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--border);
        }

        .code-browse__header h2 {
          font-size: 18px;
          margin: 0;
        }

        .code-browse__stats {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .code-browse__search {
          display: flex;
          gap: 8px;
          padding: 12px 0;
        }

        .code-browse__search .input {
          flex: 1;
        }

        .code-browse__layout {
          display: flex;
          flex: 1;
          min-height: 0;
          gap: 0;
        }

        /* ── Tree Panel ───────────────────────────────────────────── */
        .code-browse__tree {
          width: 320px;
          min-width: 240px;
          border-right: 1px solid var(--border);
          overflow-y: auto;
          padding-bottom: 16px;
        }

        .tree-node {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          cursor: pointer;
          font-size: 13px;
          white-space: nowrap;
          user-select: none;
        }

        .tree-node:hover {
          background: #f1f5f9;
        }

        .tree-node--selected {
          background: #dbeafe;
          font-weight: 500;
        }

        .tree-arrow {
          width: 14px;
          text-align: center;
          font-size: 10px;
          color: var(--text-secondary);
          flex-shrink: 0;
        }

        .tree-icon {
          flex-shrink: 0;
          font-size: 14px;
        }

        .tree-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tree-size {
          font-size: 11px;
          color: var(--text-secondary);
          flex-shrink: 0;
        }

        /* ── Viewer Panel ─────────────────────────────────────────── */
        .code-browse__viewer {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }

        .code-browse__file {
          display: flex;
          flex-direction: column;
          flex: 1;
        }

        .code-browse__file-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 16px;
          background: #f8fafc;
          border-bottom: 1px solid var(--border);
          font-size: 13px;
        }

        .code-browse__file-path {
          font-weight: 500;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
        }

        .code-browse__file-meta {
          color: var(--text-secondary);
          font-size: 12px;
        }

        .code-browse__code {
          flex: 1;
          overflow: auto;
          background: #fafbfc;
        }

        .code-browse__code pre {
          margin: 0;
          padding: 12px 0;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
          font-size: 13px;
          line-height: 1.6;
          tab-size: 4;
        }

        .code-line {
          display: flex;
        }

        .code-line-num {
          display: inline-block;
          width: 48px;
          text-align: right;
          padding-right: 16px;
          color: #94a3b8;
          user-select: none;
          flex-shrink: 0;
          font-size: 12px;
        }

        .code-line-text {
          white-space: pre;
        }

        .code-browse__empty {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          gap: 8px;
        }

        .code-browse__empty-icon {
          font-size: 48px;
          opacity: 0.4;
        }

        .alert {
          padding: 8px 12px;
          border-radius: var(--radius);
          margin: 8px 0;
          font-size: 13px;
          cursor: pointer;
        }

        .alert--error {
          background: #fef2f2;
          color: #dc2626;
          border: 1px solid #fecaca;
        }

        .loading {
          padding: 24px;
          text-align: center;
          color: var(--text-secondary);
        }

        .btn--sm {
          padding: 6px 12px;
          font-size: 13px;
        }

        @media (max-width: 768px) {
          .code-browse__layout {
            flex-direction: column;
          }
          .code-browse__tree {
            width: 100%;
            max-height: 200px;
            border-right: none;
            border-bottom: 1px solid var(--border);
          }
        }
      `}</style>
    </div>
  );
}
