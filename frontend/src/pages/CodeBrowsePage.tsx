/**
 * CodeBrowsePage — Code browser page
 *
 * Features: Left file tree + right code viewer
 * Data flow: Load file tree on mount → Click file to load content → Display line numbers
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../auth';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, coy } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-gist.css';

/** Tree node: file or directory */
interface TreeItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeItem[];
}

/** File tree API response */
interface TreeResponse {
  tree: TreeItem[];
  total_files: number;
  total_dirs: number;
}

/** Single file API response */
interface FileResponse {
  path: string;
  content: string;
  language: string;
  line_count: number;
}

/**
 * Returns the corresponding emoji icon based on file extension
 * Used for visual identification in file tree and file headers
 */
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

/** Convert bytes to human-readable file size string (B/KB/MB) */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

/**
 * TreeNode — Recursive file tree node component
 *
 * Each node displays icon, name, and size (for files).
 * Directories can be expanded/collapsed, files can be clicked to load content.
 * Uses depth parameter to control indentation level.
 */
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

/**
 * CodeBrowsePage — Main page component
 *
 * State management:
 *   - tree: Complete file tree data
 *   - selectedFile/selectedPath: Currently selected file
 *   - expandedPaths: Set of expanded directory paths
 *   - searchQuery: Search filter string
 */
export function CodeBrowsePage() {
  const { t } = useTranslation()

  const [tree, setTree] = useState<TreeItem[]>([]);
  const [stats, setStats] = useState({ files: 0, dirs: 0 });
  const [selectedFile, setSelectedFile] = useState<FileResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [copyFeedback, setCopyFeedback] = useState(false);

  /** Recursively collect all directory paths — used for "expand all" feature */
  const getAllDirPaths = useCallback((items: TreeItem[]): string[] => {
    const dirs: string[] = [];
    for (const item of items) {
      if (item.type === 'dir') {
        dirs.push(item.path);
        if (item.children) dirs.push(...getAllDirPaths(item.children));
      }
    }
    return dirs;
  }, []);

  /** Expand all folders */
  const expandAll = useCallback(() => {
    const allDirs = getAllDirPaths(tree);
    setExpandedPaths(new Set(allDirs));
  }, [tree, getAllDirPaths]);

  /** Collapse all folders */
  const collapseAll = useCallback(() => {
    setExpandedPaths(new Set());
  }, []);

  /** Load full file tree from backend — runs automatically on mount */
  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<TreeResponse>('/api/v1/code/tree');
      setTree(data.tree);
      setStats({ files: data.total_files, dirs: data.total_dirs });
      // Expand first-level folders by default for quick browsing
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

  /** Called when clicking a file: load file content from backend */
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

  /** Toggle folder expand/collapse state — uses Set to manage expanded paths */
  const toggleDir = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Recursively filter file tree — filter files and folders by search string */
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

  /** Split file content into line array for displaying line numbers */
  const lines = selectedFile?.content.split('\n') ?? [];

  /** Detect system dark mode preference + manual toggle */
  const [isDark, setIsDark] = useState(() => {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  /** Copy to clipboard */
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Check if file is Markdown */
  const isMarkdown = selectedFile?.language === 'markdown';

  /** Syntax highlighting language mapping — backend language to Prism-supported language */
  const highlightLang = useMemo(() => {
    if (!selectedFile) return undefined;
    const lang = selectedFile.language.toLowerCase();
    const map: Record<string, string> = {
      typescript: 'typescript',
      javascript: 'javascript',
      python: 'python',
      bash: 'bash',
      html: 'html',
      css: 'css',
      json: 'json',
      yaml: 'yaml',
      toml: 'toml',
      sql: 'sql',
      xml: 'xml',
      ini: 'ini',
      csv: 'csv',
      markdown: 'markdown',
      text: 'text',
      rust: 'rust',
      go: 'go',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      ruby: 'ruby',
      php: 'php',
      swift: 'swift',
      kotlin: 'kotlin',
      dockerfile: 'docker',
      nginx: 'nginx',
      lua: 'lua',
    };
    return map[lang] || lang;
  }, [selectedFile]);

  return (
    <div className="code-browse">
      {/* Page title + stats */}
      <div className="code-browse__header">
        <h2>{t("code.title")}</h2>
        <div className="code-browse__stats">
          <span>{stats.dirs} {t("code.dirs")}</span>
          <span>·</span>
          <span>{stats.files} {t("code.files")}</span>
        </div>
      </div>

      {/* Error alert — click to dismiss */}
      {error && (
        <div className="alert alert--error" onClick={() => setError(null)}>
          ❌ {t("common.error")}: {error}
        </div>
      )}

      {/* Search bar + refresh button */}
      <div className="code-browse__search">
        <input
          type="text"
          placeholder={`🔍 ${t("code.search")}...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input"
        />
        <button className="btn btn--sm" onClick={() => { loadTree(); }} title={t("code.refresh")}>
          🔄
        </button>
      </div>

      {/* Two-column layout: left file tree + right code viewer */}
      <div className="code-browse__layout">
        {/* Left column: file tree */}
        <div className="code-browse__tree">
          <div className="code-browse__tree-header">
            <span className="code-browse__tree-title">📁 {t("code.fileTree")}</span>
            <div className="code-browse__tree-actions">
              <button className="btn btn--sm" onClick={expandAll} title={t("code.expandAll")}>
                🔽
              </button>
              <button className="btn btn--sm" onClick={collapseAll} title={t("code.collapseAll")}>
                🔼
              </button>
            </div>
          </div>
          <div className="code-browse__tree-content">
          {loading ? (
            <div className="loading">{t("common.loading")}</div>
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
        </div>

        {/* Right column: code viewer */}
        <div className="code-browse__viewer">
          {fileLoading ? (
            <div className="loading">{t("code.loadingFile")}</div>
          ) : selectedFile ? (
            <div className="code-browse__file">
              <div className={`code-browse__file-header ${isDark && !isMarkdown ? 'code-browse__file-header--dark' : ''}`}>
                <span className="code-browse__file-path">
                  {fileIcon(selectedFile.path)} {selectedFile.path}
                </span>
                <div className="code-browse__file-actions">
                  <div className="code-browse__file-meta">
                    <span>{selectedFile.language}</span>
                    <span>·</span>
                    <span>{selectedFile.line_count} {t("code.lines")}</span>
                  </div>
                  <button
                    className={`btn btn--sm code-browse__copy-btn ${copyFeedback ? 'code-browse__copy-btn--active' : ''}`}
                    onClick={() => copyToClipboard(selectedFile.content)}
                    title={t("code.copy")}
                  >
                    {copyFeedback ? "✅ " + t("code.copied") : "📋 " + t("code.copy")}
                  </button>
                  {!isMarkdown && (
                    <button
                      className="btn btn--sm code-browse__theme-btn"
                      onClick={() => setIsDark(d => !d)}
                      title={isDark ? t("code.switchLight") : t("code.switchDark")}
                    >
                      {isDark ? '☀️' : '🌙'}
                    </button>
                  )}
                </div>
              </div>
              {isMarkdown ? (
                /* Markdown file: render as formatted HTML */
                <div className="code-browse__markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                  >
                    {selectedFile.content}
                  </ReactMarkdown>
                </div>
              ) : (
                /* Code file: syntax highlighting */
                <div className={`code-browse__code ${isDark ? 'code-browse__code--dark' : 'code-browse__code--light'}`}>
                  <SyntaxHighlighter
                    language={highlightLang}
                    style={isDark ? vscDarkPlus : coy}
                    showLineNumbers
                    wrapLines
                    wrapLongLines
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      borderRadius: 0,
                      background: isDark ? '#1e1e2e' : '#fafbfc',
                      fontSize: '13px',
                      lineHeight: '1.6',
                    }}
                    lineNumberStyle={{
                      minWidth: '48px',
                      paddingRight: '16px',
                      userSelect: 'none',
                      fontSize: '12px',
                    }}
                  >
                    {selectedFile.content}
                  </SyntaxHighlighter>
                </div>
              )}
            </div>
          ) : (
            <div className="code-browse__empty">
              <div className="code-browse__empty-icon">📄</div>
              <p>{t("code.selectFile")}</p>
            </div>
          )}
        </div>
      </div>

      {/* Inline styles */}
      <style>{`
        .code-browse {
          height: calc(100vh - var(--topbar-h) - 48px);
          display: flex;
          flex-direction: column;
          min-height: 400px;
        }

        .code-browse__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
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
          flex-shrink: 0;
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
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .code-browse__tree-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background: #f8fafc;
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
        }

        .code-browse__tree-title {
          font-size: 13px;
          font-weight: 600;
        }

        .code-browse__tree-actions {
          display: flex;
          gap: 4px;
        }

        .code-browse__tree-content {
          flex: 1;
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
          border-left: 2px solid transparent;
          transition: background 0.1s, border-color 0.1s;
        }

        .tree-node:hover {
          background: #f1f5f9;
          border-left-color: var(--primary);
        }

        .tree-node--selected {
          background: #dbeafe;
          font-weight: 500;
          border-left-color: var(--primary);
        }

        .tree-arrow {
          width: 20px;
          text-align: center;
          font-size: 12px;
          color: var(--text-secondary);
          flex-shrink: 0;
          transition: transform 0.15s;
          cursor: pointer;
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

        .code-browse__file-header--dark {
          background: #181825;
        }

        .code-browse__file-path {
          font-weight: 500;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
        }

        .code-browse__file-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .code-browse__file-meta {
          color: var(--text-secondary);
          font-size: 12px;
        }

        .code-browse__copy-btn {
          opacity: 0.7;
          transition: opacity 0.2s;
        }

        .code-browse__copy-btn:hover {
          opacity: 1;
        }

        .code-browse__copy-btn--active {
          background: #dcfce7;
          color: #166534;
          border-color: #86efac;
          opacity: 1;
        }

        .code-browse__theme-btn {
          opacity: 0.7;
          transition: opacity 0.2s;
        }

        .code-browse__theme-btn:hover {
          opacity: 1;
        }

        .code-browse__code {
          flex: 1;
          overflow: auto;
        }

        .code-browse__code--dark {
          background: #1e1e2e;
        }

        .code-browse__code--light {
          background: #fafbfc;
        }

        /* ── Markdown Rendering ─────────────────────────────────────── */
        .code-browse__markdown {
          flex: 1;
          overflow: auto;
          padding: 24px 32px;
          font-size: 14px;
          line-height: 1.7;
          color: var(--text);
        }

        .code-browse__markdown h1 {
          font-size: 24px;
          font-weight: 700;
          margin: 24px 0 12px;
          padding-bottom: 8px;
          border-bottom: 2px solid var(--border);
        }

        .code-browse__markdown h2 {
          font-size: 20px;
          font-weight: 600;
          margin: 20px 0 10px;
          padding-bottom: 6px;
          border-bottom: 1px solid var(--border);
        }

        .code-browse__markdown h3 {
          font-size: 17px;
          font-weight: 600;
          margin: 16px 0 8px;
        }

        .code-browse__markdown h4 {
          font-size: 15px;
          font-weight: 600;
          margin: 14px 0 6px;
        }

        .code-browse__markdown h5,
        .code-browse__markdown h6 {
          font-size: 14px;
          font-weight: 600;
          margin: 12px 0 6px;
          color: var(--text-secondary);
        }

        .code-browse__markdown p {
          margin: 12px 0;
        }

        .code-browse__markdown a {
          color: var(--primary);
          text-decoration: none;
          border-bottom: 1px solid transparent;
          transition: border-color 0.2s;
        }

        .code-browse__markdown a:hover {
          border-bottom-color: var(--primary);
        }

        .code-browse__markdown strong {
          font-weight: 600;
        }

        .code-browse__markdown em {
          font-style: italic;
        }

        .code-browse__markdown ul,
        .code-browse__markdown ol {
          margin: 12px 0;
          padding-left: 24px;
        }

        .code-browse__markdown li {
          margin: 4px 0;
        }

        .code-browse__markdown li > ul,
        .code-browse__markdown li > ol {
          margin: 4px 0;
        }

        .code-browse__markdown blockquote {
          margin: 12px 0;
          padding: 8px 16px;
          border-left: 4px solid var(--primary);
          background: #f1f5f9;
          border-radius: 0 6px 6px 0;
          color: var(--text-secondary);
        }

        .code-browse__markdown blockquote p {
          margin: 4px 0;
        }

        .code-browse__markdown table {
          width: 100%;
          border-collapse: collapse;
          margin: 16px 0;
          font-size: 13px;
        }

        .code-browse__markdown th {
          background: #f1f5f9;
          font-weight: 600;
          text-align: left;
          padding: 8px 12px;
          border: 1px solid var(--border);
        }

        .code-browse__markdown td {
          padding: 8px 12px;
          border: 1px solid var(--border);
        }

        .code-browse__markdown tr:nth-child(even) {
          background: #f8fafc;
        }

        .code-browse__markdown hr {
          border: none;
          border-top: 2px solid var(--border);
          margin: 24px 0;
        }

        .code-browse__markdown img {
          max-width: 100%;
          border-radius: 6px;
          margin: 12px 0;
        }

        /* Inline code */
        .code-browse__markdown code:not(pre code) {
          background: #f1f5f9;
          color: #e11d48;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 13px;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
        }

        /* Code blocks with syntax highlighting */
        .code-browse__markdown pre {
          margin: 16px 0;
          border-radius: 8px;
          overflow: hidden;
          border: 1px solid var(--border);
        }

        .code-browse__markdown pre code {
          padding: 16px;
          font-size: 13px;
          line-height: 1.6;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
        }

        /* Task lists */
        .code-browse__markdown input[type="checkbox"] {
          margin-right: 6px;
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
          .code-browse {
            height: auto;
            min-height: unset;
          }
          .code-browse__layout {
            flex-direction: column;
          }
          .code-browse__tree {
            width: 100%;
            max-height: 300px;
            border-right: none;
            border-bottom: 1px solid var(--border);
          }
        }
      `}</style>
    </div>
  );
}