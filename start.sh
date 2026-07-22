#!/usr/bin/env bash
# ============================================================================
# Ops Control System — 一键启动脚本
# URL:     http://127.0.0.1:5173  (开发模式，Vite 代理 /api → :8000)
#         http://127.0.0.1:8000  (后端 API 直连)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

# ---------- 颜色 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERR]${NC}   $*"; }
header(){ echo -e "${CYAN}━━━ $* ━━━${NC}"; }

# ---------- 默认值 ----------
BACKEND_PORT=8000
FRONTEND_PORT=5173
MODE="dev"           # dev | prod
BACKGROUND=false
STOP=false
STATUS=false

# PID 文件
BACKEND_PIDFILE="$PID_DIR/backend.pid"
FRONTEND_PIDFILE="$PID_DIR/frontend.pid"

# ---------- 参数解析 ----------
usage() {
    cat <<EOF
用法: $0 [选项]

选项:
  -b, --background     后台启动（默认前台）
  -p, --port PORT      后端端口（默认 8000）
  -m, --mode MODE      模式: dev | prod（默认 dev）
                        dev  = 后端 :8000 + Vite 开发服务器 :5173
                        prod = 后端 :18080（serve 前端编译产物）
  -s, --stop           停止所有服务
  -S, --status         查看运行状态
  -h, --help           显示此帮助

示例:
  $0                          # 前台启动（开发模式）
  $0 -b                       # 后台启动
  $0 -b -p 18080              # 后台启动，后端端口 18080
  $0 -m prod                  # 生产模式启动（serve 编译产物）
  $0 -s                       # 停止所有
  $0 -S                       # 状态检查
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--background)  BACKGROUND=true; shift ;;
        -p|--port)        BACKEND_PORT="$2"; shift 2 ;;
        -m|--mode)        MODE="$2"; shift 2 ;;
        -s|--stop)        STOP=true; shift ;;
        -S|--status)      STATUS=true; shift ;;
        -h|--help)        usage ;;
        *)                error "未知参数: $1"; usage ;;
    esac
done

# ---------- 工具函数 ----------
cleanup_pid() {
    local pidfile="$1"
    if [[ -f "$pidfile" ]]; then
        rm -f "$pidfile"
    fi
}

is_running() {
    local pidfile="$1"
    local name="$2"
    if [[ ! -f "$pidfile" ]]; then
        return 1
    fi
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ -z "$pid" ]]; then
        return 1
    fi
    if kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    # stale PID
    cleanup_pid "$pidfile"
    return 1
}

stop_service() {
    local pidfile="$1"
    local name="$2"
    if is_running "$pidfile" "$name"; then
        local pid
        pid=$(cat "$pidfile")
        info "停止 $name (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        # 等进程退出
        for _ in $(seq 1 10); do
            if ! kill -0 "$pid" 2>/dev/null; then
                break
            fi
            sleep 0.3
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "$name 未优雅退出，强制终止..."
            kill -9 "$pid" 2>/dev/null || true
        fi
        cleanup_pid "$pidfile"
        info "${GREEN}✓${NC} $name 已停止"
    else
        warn "$name 未在运行"
    fi
}

print_status_line() {
    local pidfile="$1"
    local name="$2"
    local port="$3"
    if is_running "$pidfile" "$name"; then
        local pid
        pid=$(cat "$pidfile")
        echo -e "  ${GREEN}●${NC} $name  运行中  (PID $pid, 端口 $port)"
    else
        echo -e "  ${RED}○${NC} $name  未运行  (端口 $port)"
    fi
}

# ---------- STOP ----------
if $STOP; then
    header "停止所有服务"
    stop_service "$BACKEND_PIDFILE" "backend (API)"
    stop_service "$FRONTEND_PIDFILE" "frontend (Vite)"
    info "完成"
    exit 0
fi

# ---------- STATUS ----------
if $STATUS; then
    header "服务状态"
    print_status_line "$BACKEND_PIDFILE" "backend (API)"     "$BACKEND_PORT"
    if [[ "$MODE" == "dev" ]]; then
        print_status_line "$FRONTEND_PIDFILE" "frontend (Vite)" "5173"
    else
        echo -e "  ${YELLOW}○${NC} frontend (built)  静态文件（由后端 :$BACKEND_PORT 提供）"
    fi
    exit 0
fi

# ============================================================================
# 前置检查
# ============================================================================
if [[ ! -d "$VENV_DIR" ]]; then
    error "未找到 virtualenv: $VENV_DIR"
    echo "请先执行: cd $BACKEND_DIR && python3 -m venv .venv && pip install -e ."
    exit 1
fi

UVICORN="$VENV_DIR/bin/uvicorn"
if [[ ! -x "$UVICORN" ]]; then
    error "未找到 uvicorn 可执行文件: $UVICORN"
    echo "请先执行: pip install -e '.[dev]'"
    exit 1
fi

if [[ "$MODE" == "dev" ]] && [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    error "前端依赖未安装"
    echo "请先执行: cd $FRONTEND_DIR && npm install"
    exit 1
fi

if $BACKGROUND; then
    # 后台模式：先干掉残留进程
    info "停止可能残留的旧进程..."
    stop_service "$BACKEND_PIDFILE" "backend (API)" || true
    stop_service "$FRONTEND_PIDFILE" "frontend (Vite)" || true
fi

# ============================================================================
# 启动后端
# ============================================================================
header "启动后端 API"

BACKEND_LOG="$LOG_DIR/backend.log"
BACKEND_CMD="$UVICORN app.main:app --host 127.0.0.1 --port $BACKEND_PORT"

if [[ "$MODE" == "dev" ]]; then
    BACKEND_CMD="$BACKEND_CMD --reload"
    info "模式: dev  (热重载, 端口 $BACKEND_PORT)"
else
    info "模式: prod (端口 $BACKEND_PORT, 提供前端编译产物)"
fi

if $BACKGROUND; then
    cd "$BACKEND_DIR"
    # shellcheck disable=SC2086
    nohup $BACKEND_CMD > "$BACKEND_LOG" 2>&1 &
    BACKEND_PID=$!
    echo "$BACKEND_PID" > "$BACKEND_PIDFILE"
    cd "$SCRIPT_DIR"
    info "后端已后台启动 (PID $BACKEND_PID), 日志: $BACKEND_LOG"
else
    cd "$BACKEND_DIR"
    # shellcheck disable=SC2086
    $BACKEND_CMD &
    BACKEND_PID=$!
    echo "$BACKEND_PID" > "$BACKEND_PIDFILE"
    cd "$SCRIPT_DIR"
    info "后端已启动 (PID $BACKEND_PID)"
fi

# ============================================================================
# 启动前端（仅 dev 模式）
# ============================================================================
if [[ "$MODE" == "dev" ]]; then
    header "启动前端开发服务器"

    FRONTEND_LOG="$LOG_DIR/frontend.log"

    if $BACKGROUND; then
        cd "$FRONTEND_DIR"
        nohup npm run dev > "$FRONTEND_LOG" 2>&1 &
        FRONTEND_PID=$!
        echo "$FRONTEND_PID" > "$FRONTEND_PIDFILE"
        cd "$SCRIPT_DIR"
        info "前端已后台启动 (PID $FRONTEND_PID), 日志: $FRONTEND_LOG"
    else
        cd "$FRONTEND_DIR"
        VITE_CORS_DISABLE=1 npm run dev &
        FRONTEND_PID=$!
        echo "$FRONTEND_PID" > "$FRONTEND_PIDFILE"
        cd "$SCRIPT_DIR"
        info "前端已启动 (PID $FRONTEND_PID)"
    fi
else
    info "生产模式: 前端由后端 :$BACKEND_PORT 提供静态文件"
fi

# ============================================================================
# 等待就绪 & 打印信息
# ============================================================================
# 给进程一点时间启动
sleep 1

# 检查后端是否真的起来了
if is_running "$BACKEND_PIDFILE" "backend"; then
    info "${GREEN}✓${NC} 后端 API: http://127.0.0.1:$BACKEND_PORT"
    info "   健康检查: http://127.0.0.1:$BACKEND_PORT/api/v1/health"
fi

if [[ "$MODE" == "dev" ]] && is_running "$FRONTEND_PIDFILE" "frontend"; then
    info "${GREEN}✓${NC} 前端 UI:  http://127.0.0.1:$FRONTEND_PORT"
    info "   (Vite 自动代理 /api → :$BACKEND_PORT)"
fi

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  停止:     ${YELLOW}$0 -s${NC}"
echo -e "  状态:     ${YELLOW}$0 -S${NC}"
echo -e "  后台启动: ${YELLOW}$0 -b${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if $BACKGROUND; then
    info "后台模式 — 进程在后台运行中。日志位置:"
    echo "  后端: $BACKEND_LOG"
    echo "  前端: $FRONTEND_LOG"
else
    info "前台模式 — 按 Ctrl+C 停止所有服务"
    # 前台模式下等待任一进程退出
    wait $BACKEND_PID 2>/dev/null || true
    if [[ "$MODE" == "dev" ]]; then
        wait $FRONTEND_PID 2>/dev/null || true
    fi
    info "服务已退出"
fi
