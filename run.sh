#!/usr/bin/env bash
# run.sh — 手动执行入口（所有 step 顺序执行）
#
# 用法：
#   ./run.sh                           # 运行所有 profile（从 config.json 读取）
#   ./run.sh --profile economics       # 指定单个 profile
#   ./run.sh --profile economics --dry-run
#   ./run.sh --days 7                  # 指定回溯天数（覆盖 config）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ─── 从 config.json 读取 profile 列表 ──────────────────────

ALL_PROFILES=()
if command -v python3 &>/dev/null && [[ -f config.json ]]; then
  while IFS= read -r line; do
    ALL_PROFILES+=("$line")
  done < <(python3 -c "import json,sys; print('\n'.join(json.load(open('config.json')).get('profiles',['top-journal-env-energy'])))")
fi
if [[ ${#ALL_PROFILES[@]} -eq 0 ]]; then
  ALL_PROFILES=("top-journal-env-energy")
fi

# ─── 参数解析 ───────────────────────────────────────────────

PROFILE=""
DRY_RUN=0
DAYS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --days)
      DAYS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--profile NAME] [--days N] [--dry-run]"
      echo ""
      echo "  --profile NAME   指定 profile（不指定则运行所有 profile，读取 config.json）"
      echo "  --days N         回溯天数（覆盖 config）"
      echo "  --dry-run        仅生成文件，跳过飞书发布"
      exit 0 ;;
    *)
      echo "Unknown option: $1"; exit 1 ;;
  esac
done

# 确定要运行的 profile 列表
if [[ -n "$PROFILE" ]]; then
  PROFILES=("$PROFILE")
else
  PROFILES=("${ALL_PROFILES[@]}")
fi

# ─── 设置环境变量 ──────────────────────────────────────────

export DRY_RUN
[[ "$DRY_RUN" == "1" ]] && export PUSH_DRY_RUN="1"
[[ -n "$DAYS" ]] && export PUSH_DAYS="$DAYS"

# ─── 逐 profile 执行 ───────────────────────────────────────

EXIT_CODE=0

for PROFILE_NAME in "${PROFILES[@]}"; do
  export PROFILE="$PROFILE_NAME"

  echo "[run] profile=$PROFILE_NAME dry_run=$DRY_RUN days=${DAYS:-from_config}"

  STEPS="collect filter enrich digest"
  if [[ "$DRY_RUN" != "1" ]]; then
    STEPS="$STEPS push"
  fi

  for step in $STEPS; do
    echo "[run] >>> step: $step"
    if ! npx tsx src/cli.ts --step "$step" --profile "$PROFILE_NAME"; then
      echo "[run] ERROR: step '$step' failed for profile '$PROFILE_NAME'" >&2
      EXIT_CODE=1
      break
    fi
    echo "[run] <<< step: $step done"
  done

  echo "[run] Profile '$PROFILE_NAME' complete."
  echo ""
done

if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "[run] All profiles complete."
else
  echo "[run] Some profiles failed (exit code=$EXIT_CODE)." >&2
fi

exit $EXIT_CODE
