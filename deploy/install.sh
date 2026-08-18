#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUN_USER=${H3_RUN_USER:-$(id -un)}
RUNTIME_ROOT=${H3_RUNTIME_ROOT:-"${XDG_DATA_HOME:-$HOME/.local/share}/h3-studio"}
H3_PORT_VALUE=${H3_PORT:-12233}
COMFY_PORT_VALUE=${COMFYUI_PORT:-12234}
INSTALL_COMFY=${H3_INSTALL_COMFYUI:-1}
INSTALL_H3_MODELS=${H3_INSTALL_H3_MODELS:-auto}

say() { printf '[H3] %s\n' "$*"; }
fail() { printf '[H3] %s\n' "$*" >&2; exit 1; }

install_packages() {
  missing=''
  command -v git >/dev/null 2>&1 || missing="$missing git"
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v python3 >/dev/null 2>&1 || missing="$missing python3 python3-venv"
  [ -z "$missing" ] && return
  if [ "$(id -u)" -ne 0 ]; then fail "缺少依赖:$missing；请用 root 运行，或先安装这些软件"; fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates $missing
  elif command -v dnf >/dev/null 2>&1; then dnf install -y $missing
  elif command -v yum >/dev/null 2>&1; then yum install -y $missing
  else fail "无法识别系统包管理器，请先安装:$missing"; fi
}

install_optional_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 && return
  available_kb=$(df -Pk /var/cache/apt 2>/dev/null | awk 'NR==2 {print $4}' || true)
  if [ -n "$available_kb" ] && [ "$available_kb" -lt 614400 ]; then
    say '系统盘可用空间不足 600 MB，暂不安装可选的 FFmpeg；网页和 ComfyUI 可继续运行'
    return
  fi
  if [ "$(id -u)" -ne 0 ]; then say '未安装可选的 FFmpeg；稍后可由管理员补装'; return; fi
  say '尝试安装可选的 FFmpeg'
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg) || say 'FFmpeg 安装失败，继续部署核心服务'
  elif command -v dnf >/dev/null 2>&1; then dnf install -y ffmpeg || say 'FFmpeg 安装失败，继续部署核心服务'
  elif command -v yum >/dev/null 2>&1; then yum install -y ffmpeg || say 'FFmpeg 安装失败，继续部署核心服务'
  else say '无法自动安装 FFmpeg，继续部署核心服务'; fi
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    major=$(node -p "Number(process.versions.node.split('.')[0])")
    [ "$major" -ge 18 ] && command -v npm >/dev/null 2>&1 && return
  fi
  [ "$(id -u)" -eq 0 ] || fail '需要 Node.js 18+，请先安装后重试'
  if command -v apt-get >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || { apt-get update; apt-get install -y curl ca-certificates; }
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/h3-nodesource.sh
    bash /tmp/h3-nodesource.sh
    apt-get install -y nodejs
  else fail '需要 Node.js 18+；当前系统无法自动安装 Node.js'; fi
}

find_comfy_root() {
  [ -n "${COMFYUI_ROOT:-}" ] && [ -f "$COMFYUI_ROOT/main.py" ] && { printf '%s\n' "$COMFYUI_ROOT"; return; }
  for base in "$HOME" /opt /srv /workspace /app; do
    [ -d "$base" ] || continue
    candidate=$(find "$base" -maxdepth 5 -type f -name main.py -path '*/ComfyUI/main.py' -print -quit 2>/dev/null || true)
    [ -n "$candidate" ] && { dirname "$candidate"; return; }
  done
}

find_comfy_script() {
  [ -n "${COMFYUI_START_SCRIPT:-}" ] && [ -f "$COMFYUI_START_SCRIPT" ] && { printf '%s\n' "$COMFYUI_START_SCRIPT"; return; }
  for base in "$HOME" /opt /srv /workspace /app; do
    [ -d "$base" ] || continue
    candidate=$(find "$base" -maxdepth 4 -type f \( -iname 'start_comfy*.sh' -o -iname 'start-comfy*.sh' \) -print -quit 2>/dev/null || true)
    [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return; }
  done
}

install_packages
install_node
install_optional_ffmpeg
mkdir -p "$RUNTIME_ROOT" "$RUNTIME_ROOT/data" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/storage"

runtime_free_kb=$(df -Pk "$RUNTIME_ROOT" | awk 'NR==2 {print $4}')
[ "$runtime_free_kb" -ge 1048576 ] || say "警告：运行数据盘剩余不足 1 GB，生成视频前请扩容或通过 H3_RUNTIME_ROOT 指向可写数据盘"

COMFY_ROOT_FOUND=$(find_comfy_root || true)
COMFY_SCRIPT_FOUND=$(find_comfy_script || true)
COMFY_NEW=0

if [ -z "$COMFY_ROOT_FOUND" ] && [ "$INSTALL_COMFY" = 1 ]; then
  COMFY_ROOT_FOUND="$RUNTIME_ROOT/ComfyUI"
  say "未发现 ComfyUI，安装到可迁移数据目录 $COMFY_ROOT_FOUND"
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY_ROOT_FOUND"
  python3 -m venv "$COMFY_ROOT_FOUND/.venv"
  "$COMFY_ROOT_FOUND/.venv/bin/python" -m pip install --upgrade pip
  "$COMFY_ROOT_FOUND/.venv/bin/python" -m pip install -r "$COMFY_ROOT_FOUND/requirements.txt"
  COMFY_NEW=1
fi

[ -n "$COMFY_ROOT_FOUND" ] || fail '没有发现 ComfyUI；请设置 COMFYUI_ROOT，或使用 H3_INSTALL_COMFYUI=1'

if [ "$INSTALL_H3_MODELS" = auto ]; then
  if [ "$COMFY_NEW" = 1 ] || ! find "$COMFY_ROOT_FOUND/models" -type f -iname '*minimax*h3*' -print -quit 2>/dev/null | grep -q .; then INSTALL_H3_MODELS=1
  else INSTALL_H3_MODELS=0; fi
fi

download_model() {
  relative_path=$1
  source_url=$2
  target="$COMFY_ROOT_FOUND/models/$relative_path"
  [ -s "$target" ] && { say "模型已存在：$(basename "$target")"; return; }
  mkdir -p "$(dirname "$target")"
  say "下载 H3 模型：$(basename "$target")"
  curl -fL --retry 3 --retry-delay 3 -C - -o "$target.part" "$source_url"
  mv "$target.part" "$target"
}

if [ "$INSTALL_H3_MODELS" = 1 ]; then
  model_free_kb=$(df -Pk "$COMFY_ROOT_FOUND" | awk 'NR==2 {print $4}')
  [ "$model_free_kb" -ge 67108864 ] || fail 'H3 本地模型需要约 55 GB；请确保模型盘至少有 64 GB 可用空间，或用 COMFYUI_ROOT 指向大容量可写盘'
  download_model 'vae/minimax_h3_video_vae_fp16.safetensors' 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors'
  download_model 'vae/minimax_h3_audio_vae_fp32.safetensors' 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors'
  download_model 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors' 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors'
  download_model 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
fi

COMFY_PYTHON_FOUND=''
for candidate in "${COMFYUI_PYTHON:-}" "$COMFY_ROOT_FOUND/.venv/bin/python" "$COMFY_ROOT_FOUND/venv/bin/python"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { COMFY_PYTHON_FOUND=$candidate; break; }
done

if [ -n "$COMFY_SCRIPT_FOUND" ]; then
  script_port=$(sed -nE 's/.*--port[= ]+([0-9]+).*/\1/p' "$COMFY_SCRIPT_FOUND" | tail -n 1)
  [ -n "$script_port" ] && COMFY_PORT_VALUE=$script_port
fi

say '安装网页依赖并构建'
cd "$PROJECT_DIR"
npm install --no-audit --no-fund
npm run build

quote_env() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
{
  printf 'NODE_ENV=production\n'
  printf 'H3_HOST=0.0.0.0\n'
  printf 'H3_PORT=%s\n' "$H3_PORT_VALUE"
  printf 'H3_AUTO_START_COMFYUI=1\n'
  printf 'H3_STORAGE_ROOT="%s"\n' "$(quote_env "$RUNTIME_ROOT/storage")"
  printf 'H3_DATA_ROOT="%s"\n' "$(quote_env "$RUNTIME_ROOT/data")"
  printf 'H3_LOG_ROOT="%s"\n' "$(quote_env "$RUNTIME_ROOT/logs")"
  printf 'H3_WORKFLOW_PATH="%s"\n' "$(quote_env "$PROJECT_DIR/workflows/h3-api.json")"
  printf 'COMFYUI_URL=http://127.0.0.1:%s\n' "$COMFY_PORT_VALUE"
  printf 'COMFYUI_ROOT="%s"\n' "$(quote_env "$COMFY_ROOT_FOUND")"
  [ -n "$COMFY_PYTHON_FOUND" ] && printf 'COMFYUI_PYTHON="%s"\n' "$(quote_env "$COMFY_PYTHON_FOUND")"
  [ -n "$COMFY_SCRIPT_FOUND" ] && printf 'COMFYUI_START_SCRIPT="%s"\n' "$(quote_env "$COMFY_SCRIPT_FOUND")"
} >"$PROJECT_DIR/.h3.env"
chmod 600 "$PROJECT_DIR/.h3.env"
chmod +x "$SCRIPT_DIR/h3ctl.sh" "$SCRIPT_DIR/h3-supervisor.sh" "$SCRIPT_DIR/install.sh"

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  NODE_BIN=$(command -v node)
  cat >/etc/systemd/system/h3-studio.service <<EOF
[Unit]
Description=H3 Studio
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.h3.env
ExecStart=$NODE_BIN $PROJECT_DIR/server.mjs
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now h3-studio.service
  say '已注册 systemd 守护服务'
else
  "$SCRIPT_DIR/h3ctl.sh" restart
  say '当前环境没有 systemd，已启用内置守护进程'
fi

say "部署完成：打开 http://服务器IP:$H3_PORT_VALUE"
say "ComfyUI 已识别：$COMFY_ROOT_FOUND（端口 $COMFY_PORT_VALUE）"
