#!/usr/bin/env bash
# auto-push.sh — cron 定时任务入口
#
# 每天运行所有 profile 的完整 pipeline，合并推送一份日报。
# 周一 DAYS=3（周末积压），周二至五 DAYS=1。
# 周末跳过。
#
# 用法：
#   ./auto-push.sh               正式推送
#   ./auto-push.sh --dry-run     仅生成文件，不发飞书

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ─── 参数解析 ───────────────────────────────────────────────

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|--dryrun) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo ""
      echo "  每天运行所有 profile，合并推一份日报"
      echo "  周一 DAYS=3（覆盖周末），周二至五 DAYS=1"
      echo "  --dry-run  仅生成文件，跳过飞书发布"
      exit 0 ;;
  esac
done

# ─── 日期逻辑 ────────────────────────────────────────────────

TZ="${TZ:-Asia/Shanghai}"
DAY_OF_WEEK="$(TZ="$TZ" date +%u)"  # 1=Monday ... 7=Sunday

# 周末不推送
if [[ "$DAY_OF_WEEK" == "6" || "$DAY_OF_WEEK" == "7" ]]; then
  echo "[auto-push] 周末跳过 (day_of_week=$DAY_OF_WEEK)"
  exit 0
fi

# ─── 天数 ──────────────────────────────────────────────────

if [[ "$DAY_OF_WEEK" == "1" ]]; then
  DAYS=3
else
  DAYS=1
fi

# ─── 执行 ──────────────────────────────────────────────────

EXIT_CODE=0
DRY_FLAG=""
[[ "$DRY_RUN" == "1" ]] && DRY_FLAG="--dry-run"

echo "[auto-push] day=$DAY_OF_WEEK days=$DAYS dry_run=$DRY_RUN"

# 读取 profile 列表
PROFILES=()
if command -v python3 &>/dev/null && [[ -f config.json ]]; then
  while IFS= read -r line; do
    PROFILES+=("$line")
  done < <(python3 -c "import json,sys; print('\n'.join(json.load(open('config.json')).get('profiles',['top'])))")
fi
if [[ ${#PROFILES[@]} -eq 0 ]]; then
  PROFILES=("top")
fi

echo "[auto-push] profiles: ${PROFILES[*]}"

# 1. 逐 profile 跑 pipeline（不 push）
for PROFILE_NAME in "${PROFILES[@]}"; do
  echo "[auto-push] === $PROFILE_NAME pipeline ==="
  if ! bash "$ROOT_DIR/run.sh" --profile "$PROFILE_NAME" --days "$DAYS" --no-push $DRY_FLAG; then
    echo "[auto-push] ERROR: pipeline failed for $PROFILE_NAME" >&2
    EXIT_CODE=1
    break
  fi
  echo "[auto-push] $PROFILE_NAME done."
done

# 2. 合并推送
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "[auto-push] === combined-push ==="
  if ! npx tsx src/cli.ts --step combined-push --profile top $DRY_FLAG; then
    echo "[auto-push] ERROR: combined-push failed" >&2
    EXIT_CODE=1
  fi
fi

exit $EXIT_CODE
