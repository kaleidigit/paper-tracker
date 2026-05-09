#!/usr/bin/env bash
set -euo pipefail

# 兼容两种执行方式：
# 1) 直接 ./deploy.sh（使用脚本所在目录）
# 2) curl ... | bash（使用当前工作目录）
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || true)"
if [ -n "${SCRIPT_DIR:-}" ] && [ -f "${SCRIPT_DIR}/package.json" ]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(pwd)"
fi
cd "$ROOT_DIR"

MANUAL_AUTH=0
AUTH_TIMEOUT_SECONDS="${AUTH_TIMEOUT_SECONDS:-300}"
AUTH_RETRIES="${AUTH_RETRIES:-2}"
AUTH_DOMAINS="${LARK_AUTH_DOMAINS:-im,docs,base}"
AUTH_POLL_INTERVAL_SECONDS="${LARK_AUTH_POLL_INTERVAL_SECONDS:-1}"
AUTH_SINGLE_POLL_TIMEOUT_SECONDS="${LARK_AUTH_SINGLE_POLL_TIMEOUT_SECONDS:-8}"
LARK_BIN="${LARK_CLI_BIN:-lark-cli}"
KEYCHAIN_FILE="${HOME}/.lark-cli/keychain.json"
AUTH_DOMAIN_ARGS=()

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Options:
  --manual-auth                只输出授权 URL，不自动等待登录完成
  --auth-domains <list>        授权域，逗号分隔（默认 im,docs,base）
  --auth-poll-interval <sec>   授权轮询间隔秒数（默认 1）
  --auth-single-poll-timeout <sec> 单次 device-code 轮询调用超时（默认 8）
  --auth-timeout <seconds>     授权超时（默认 300）
  --auth-retries <times>       授权重试次数（默认 2）
  -h, --help                   显示帮助
EOF
}

to_int() {
  local raw="$1"
  local int_part="${raw%%.*}"
  if [ -z "$int_part" ]; then
    int_part="0"
  fi
  if ! [[ "$int_part" =~ ^[0-9]+$ ]]; then
    int_part="0"
  fi
  echo "$int_part"
}

normalize_auth_settings() {
  AUTH_TIMEOUT_SECONDS="$(to_int "$AUTH_TIMEOUT_SECONDS")"
  AUTH_RETRIES="$(to_int "$AUTH_RETRIES")"

  if [ "$AUTH_TIMEOUT_SECONDS" -lt 300 ]; then
    log "auth timeout 小于 300 秒，已自动提升到 300 秒以保证扫码窗口。"
    AUTH_TIMEOUT_SECONDS=300
  fi
  if [ "$AUTH_RETRIES" -lt 1 ]; then
    AUTH_RETRIES=1
  fi
  AUTH_SINGLE_POLL_TIMEOUT_SECONDS="$(to_int "$AUTH_SINGLE_POLL_TIMEOUT_SECONDS")"
  if [ "$AUTH_SINGLE_POLL_TIMEOUT_SECONDS" -lt 3 ]; then
    AUTH_SINGLE_POLL_TIMEOUT_SECONDS=3
  fi
}

log() {
  echo "[deploy] $*"
}

die() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_lark() {
  if [ -x "$LARK_BIN" ]; then
    "$LARK_BIN" "$@"
  else
    command "$LARK_BIN" "$@"
  fi
}

supports_flag() {
  local flag="$1"
  shift
  run_lark "$@" --help 2>&1 | grep -q -- "$flag"
}

build_auth_domain_args() {
  local -a raw_domains=()
  local item=""
  IFS=',' read -r -a raw_domains <<< "$AUTH_DOMAINS"
  AUTH_DOMAIN_ARGS=()
  for item in "${raw_domains[@]}"; do
    item="$(echo "$item" | tr -d '[:space:]')"
    if [ -n "$item" ]; then
      AUTH_DOMAIN_ARGS+=(--domain "$item")
    fi
  done
  if [ "${#AUTH_DOMAIN_ARGS[@]}" -eq 0 ]; then
    AUTH_DOMAIN_ARGS=(--domain im --domain docs --domain base)
  fi
}

extract_first_url() {
  sed -nE 's@.*(https?://[^[:space:]"]+).*@\1@p' "$1" | head -n 1
}

is_lark_authenticated() {
  local out
  out="$(run_lark auth status 2>&1 || true)"
  if echo "$out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    return 0
  fi
  if echo "$out" | grep -Eq '"tokenStatus"[[:space:]]*:[[:space:]]*"valid"'; then
    return 0
  fi
  if [ -f "$KEYCHAIN_FILE" ] && grep -Eq '"(access_token|refresh_token)"[[:space:]]*:' "$KEYCHAIN_FILE"; then
    return 0
  fi
  return 1
}

needs_keychain_recovery() {
  local out
  if is_lark_authenticated; then
    return 1
  fi
  out="$(run_lark auth status 2>&1 || true)"
  if [ ! -f "$KEYCHAIN_FILE" ]; then
    return 0
  fi
  if echo "$out" | grep -qi "keychain not initialized"; then
    return 0
  fi
  if echo "$out" | grep -Eq '"message"[[:space:]]*:[[:space:]]*"not configured"'; then
    return 0
  fi
  return 1
}

init_lark_config() {
  local tmp_cfg
  tmp_cfg="$(mktemp)"

  # 按需求优先尝试 --non-interactive；若当前 lark-cli 版本不支持，则回退到 app-id/app-secret 方式
  if run_lark config init --non-interactive >"$tmp_cfg" 2>&1; then
    cat "$tmp_cfg"
    rm -f "$tmp_cfg"
    return 0
  fi

  if grep -qiE 'unknown flag|unknown shorthand|unknown option|unrecognized|not defined' "$tmp_cfg"; then
    if [ -z "${LARK_APP_ID:-}" ] || [ -z "${LARK_APP_SECRET:-}" ]; then
      cat "$tmp_cfg" >&2
      rm -f "$tmp_cfg"
      die "当前 lark-cli 不支持 --non-interactive，且未提供 LARK_APP_ID/LARK_APP_SECRET。"
    fi
    log "fallback: 使用 --app-id/--app-secret-stdin 初始化配置"
    printf '%s\n' "$LARK_APP_SECRET" | run_lark config init --app-id "$LARK_APP_ID" --app-secret-stdin --brand "${LARK_BRAND:-feishu}"
    rm -f "$tmp_cfg"
    return 0
  fi

  cat "$tmp_cfg" >&2
  rm -f "$tmp_cfg"
  die "lark-cli config init 失败。"
}

emit_auth_url() {
  local url="$1"
  url="$(printf '%s' "$url" | tr -d " \t\r\n\`'\"")"
  if [ -n "$url" ]; then
    echo "LARK_AUTH_URL=$url"
  fi
}

auth_with_qr_console() {
  local tmp_out pid start now url=""
  tmp_out="$(mktemp)"

  run_lark auth login --qr-console "${AUTH_DOMAIN_ARGS[@]}" >"$tmp_out" 2>&1 &
  pid="$!"
  start="$(date +%s)"

  while kill -0 "$pid" >/dev/null 2>&1; do
    if [ -z "$url" ]; then
      url="$(extract_first_url "$tmp_out" || true)"
      if [ -n "$url" ]; then
        emit_auth_url "$url"
        if [ "$MANUAL_AUTH" -eq 1 ]; then
          kill "$pid" >/dev/null 2>&1 || true
          wait "$pid" >/dev/null 2>&1 || true
          rm -f "$tmp_out"
          return 0
        fi
      fi
    fi

    # 某些版本在扫码成功后子进程不会立刻退出，这里主动检测登录状态并提前放行
    if is_lark_authenticated; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      rm -f "$tmp_out"
      return 0
    fi

    now="$(date +%s)"
    if [ $((now - start)) -ge "$AUTH_TIMEOUT_SECONDS" ]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      cat "$tmp_out" >&2
      rm -f "$tmp_out"
      return 1
    fi
    sleep 2
  done

  wait "$pid" || {
    # 即使子进程退出码异常，只要本地已拿到有效 token，仍视为成功
    if is_lark_authenticated; then
      rm -f "$tmp_out"
      return 0
    fi
    cat "$tmp_out" >&2
    rm -f "$tmp_out"
    return 1
  }

  if [ -z "$url" ]; then
    url="$(extract_first_url "$tmp_out" || true)"
    emit_auth_url "$url"
  fi
  cat "$tmp_out"
  rm -f "$tmp_out"
  return 0
}

auth_with_no_wait() {
  local init_out tmp_json url device_code start now poll_out last_logged_remain=-1 remain=0
  tmp_json="$(mktemp)"

  init_out="$(run_lark auth login --no-wait --json "${AUTH_DOMAIN_ARGS[@]}" 2>&1 || true)"
  echo "$init_out" >"$tmp_json"

  url="$(extract_first_url "$tmp_json" || true)"
  device_code="$(sed -nE 's@.*"device_code"[[:space:]]*:[[:space:]]*"([^"]+)".*@\1@p' "$tmp_json" | head -n 1)"
  emit_auth_url "$url"

  if echo "$init_out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*false'; then
    cat "$tmp_json" >&2
    rm -f "$tmp_json"
    return 1
  fi

  if [ -z "$device_code" ]; then
    cat "$tmp_json" >&2
    rm -f "$tmp_json"
    return 1
  fi

  if [ "$MANUAL_AUTH" -eq 1 ]; then
    rm -f "$tmp_json"
    return 0
  fi

  start="$(date +%s)"
  while true; do
    if is_lark_authenticated; then
      rm -f "$tmp_json"
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - start)) -ge "$AUTH_TIMEOUT_SECONDS" ]; then
      rm -f "$tmp_json"
      return 1
    fi
    remain=$((AUTH_TIMEOUT_SECONDS - (now - start)))
    if [ "$remain" -ne "$last_logged_remain" ] && [ $((remain % 10)) -eq 0 ]; then
      log "等待扫码授权中，剩余 ${remain}s..."
      last_logged_remain="$remain"
    fi
    poll_out="$(poll_device_code_once "$device_code" || true)"
    if echo "$poll_out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true|authorized|success|成功'; then
      rm -f "$tmp_json"
      return 0
    fi
    if echo "$poll_out" | grep -Eqi 'authorization_pending|pending|等待|wait'; then
      :
    elif echo "$poll_out" | grep -Eqi 'expired|invalid|denied|forbidden|拒绝|无效'; then
      log "device-code 轮询返回异常：$(echo "$poll_out" | tr '\n' ' ' | cut -c 1-180)"
      rm -f "$tmp_json"
      return 1
    fi
    sleep "$AUTH_POLL_INTERVAL_SECONDS"
  done
}

poll_device_code_once() {
  local device_code="$1"
  local tmp_out pid start now
  tmp_out="$(mktemp)"
  run_lark auth login --device-code "$device_code" >"$tmp_out" 2>&1 &
  pid="$!"
  start="$(date +%s)"
  while kill -0 "$pid" >/dev/null 2>&1; do
    now="$(date +%s)"
    if [ $((now - start)) -ge "$AUTH_SINGLE_POLL_TIMEOUT_SECONDS" ]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      echo '{"ok": false, "error": {"message": "authorization_pending"}}'
      rm -f "$tmp_out"
      return 0
    fi
    sleep 1
  done
  wait "$pid" >/dev/null 2>&1 || true
  cat "$tmp_out"
  rm -f "$tmp_out"
  return 0
}

bootstrap_lark_auth() {
  local attempt=1
  while [ "$attempt" -le "$AUTH_RETRIES" ]; do
    log "lark auth bootstrap attempt ${attempt}/${AUTH_RETRIES}（本轮最多等待 ${AUTH_TIMEOUT_SECONDS}s）"
    if needs_keychain_recovery; then
      init_lark_config
      # 默认优先 no-wait 设备码轮询，避免 qr-console 在部分版本/终端卡住
      if supports_flag "--no-wait" auth login; then
        auth_with_no_wait || true
      elif supports_flag "--qr-console" auth login; then
        auth_with_qr_console || true
      else
        run_lark auth login || true
      fi
    fi

    if [ "$MANUAL_AUTH" -eq 1 ]; then
      log "manual auth enabled: 已输出授权 URL，跳过自动等待。"
      return 0
    fi

    if is_lark_authenticated; then
      log "lark auth ready."
      return 0
    fi
    log "本轮授权未完成，剩余重试次数: $((AUTH_RETRIES - attempt))"
    attempt=$((attempt + 1))
  done

  die "lark auth 未在 ${AUTH_RETRIES} 次重试内完成，或 token 无效。"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --manual-auth)
        MANUAL_AUTH=1
        ;;
      --auth-domains)
        shift
        [ $# -gt 0 ] || die "--auth-domains 缺少参数"
        AUTH_DOMAINS="$1"
        ;;
      --auth-poll-interval)
        shift
        [ $# -gt 0 ] || die "--auth-poll-interval 缺少参数"
        AUTH_POLL_INTERVAL_SECONDS="$1"
        ;;
      --auth-single-poll-timeout)
        shift
        [ $# -gt 0 ] || die "--auth-single-poll-timeout 缺少参数"
        AUTH_SINGLE_POLL_TIMEOUT_SECONDS="$1"
        ;;
      --auth-timeout)
        shift
        [ $# -gt 0 ] || die "--auth-timeout 缺少参数"
        AUTH_TIMEOUT_SECONDS="$1"
        ;;
      --auth-retries)
        shift
        [ $# -gt 0 ] || die "--auth-retries 缺少参数"
        AUTH_RETRIES="$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "未知参数: $1"
        ;;
    esac
    shift
  done
}

parse_args "$@"
normalize_auth_settings
build_auth_domain_args

if [ ! -f ".env" ]; then
  if [ -f "config/.env.cn.example" ]; then
    cp config/.env.cn.example .env
  elif [ -f "config/.env.example" ]; then
    cp config/.env.example .env
  elif [ -f ".env.cn.example" ]; then
    cp .env.cn.example .env
  else
    cp .env.example .env
  fi
  log ".env not found, copied from template."
fi

set -a
# shellcheck disable=SC1091
source ".env"
set +a

if ! has_cmd node || ! has_cmd npm; then
  die "Node.js/npm 未安装。请先安装 Node.js 20+。"
fi

if ! has_cmd "$LARK_BIN" && [ ! -x "$LARK_BIN" ]; then
  log "lark-cli 未安装，自动安装 @larksuite/cli..."
  npm install -g @larksuite/cli
fi

log "Installing npm dependencies..."
npm install

log "Building TypeScript..."
npm run build

bootstrap_lark_auth

if [ "$MANUAL_AUTH" -eq 1 ]; then
  log "manual mode finished. 请扫码授权后再次执行 ./deploy.sh 完成后续部署。"
  exit 0
fi

log "Deployment completed with auth domains: ${AUTH_DOMAINS}"
log "日常推送请执行 ./auto-push.sh 或 ./run.sh --profile top-journal-env-energy"
