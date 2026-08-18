#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$PROJECT_DIR/.h3.env"

[ -f "$ENV_FILE" ] || { printf '请先运行 bash deploy/install.sh\n' >&2; exit 1; }

read_value() {
  variable_name=$1
  prompt=$2
  default_value=$3
  current_value=$(printenv "$variable_name" 2>/dev/null || true)
  if [ -n "$current_value" ]; then printf '%s' "$current_value"; return; fi
  if [ ! -t 0 ]; then printf '%s' "$default_value"; return; fi
  if [ -n "$default_value" ]; then read -r -p "$prompt [$default_value]: " entered
  else read -r -p "$prompt: " entered; fi
  printf '%s' "${entered:-$default_value}"
}

API_BASE=$(read_value H3_HARNESS_API_BASE 'API 基础地址，例如 https://api.example.com/v1' '')
MODEL=$(read_value H3_HARNESS_MODEL '模型名称' '')
[ -n "$API_BASE" ] || { printf 'API 地址不能为空\n' >&2; exit 1; }
[ -n "$MODEL" ] || { printf '模型名称不能为空\n' >&2; exit 1; }

API_KEY=${H3_HARNESS_API_KEY:-}
if [ -z "$API_KEY" ] && [ -t 0 ]; then
  read -r -s -p 'API Key（无鉴权的私有 API 可留空）: ' API_KEY
  printf '\n'
fi

ACCESS_TOKEN=${H3_HARNESS_ACCESS_TOKEN:-}
if [ -z "$ACCESS_TOKEN" ]; then
  if command -v openssl >/dev/null 2>&1; then ACCESS_TOKEN=$(openssl rand -hex 24)
  else ACCESS_TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"); fi
fi

quote_env() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g'; }
temporary=$(mktemp "$PROJECT_DIR/.h3.env.XXXXXX")
chmod 600 "$temporary"
awk '!/^H3_HARNESS_/' "$ENV_FILE" >"$temporary"
{
  printf 'H3_HARNESS_API_BASE="%s"\n' "$(quote_env "$API_BASE")"
  printf 'H3_HARNESS_MODEL="%s"\n' "$(quote_env "$MODEL")"
  printf 'H3_HARNESS_API_KEY="%s"\n' "$(quote_env "$API_KEY")"
  printf 'H3_HARNESS_ACCESS_TOKEN="%s"\n' "$(quote_env "$ACCESS_TOKEN")"
} >>"$temporary"
mv "$temporary" "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ "${H3_HARNESS_NO_RESTART:-0}" != 1 ]; then "$SCRIPT_DIR/h3ctl.sh" restart; fi

printf '服务器助手已配置。\n'
printf '网页访问令牌（请妥善保存）：%s\n' "$ACCESS_TOKEN"
