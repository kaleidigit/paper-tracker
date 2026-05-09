#!/usr/bin/env bash
# auto-push.sh — cron 定时任务入口
#
# 周一推送3天（上周五/六/日），周二至周五推送昨天，周末不推送
#
# 用法：
#   ./auto-push.sh              正式推送
#   ./auto-push.sh --dry-run   仅生成文件，不发飞书

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
      echo "  自动推送（周一→3天，周二至周五→1天）"
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

if [[ "$DAY_OF_WEEK" == "1" ]]; then
  DAYS=3   # 周一：推送上周五、六、日
else
  DAYS=1   # 周二至周五：推送昨天
fi

# ─── 调用 run.sh（依次运行所有 profile）────────────────────

PROFILES=("top-journal-env-energy" "env-economics-journal")
EXIT_CODE=0

for PROFILE_NAME in "${PROFILES[@]}"; do
  echo "[auto-push] day_of_week=$DAY_OF_WEEK days=$DAYS dry_run=$DRY_RUN profile=$PROFILE_NAME"

  ARGS=("--profile" "$PROFILE_NAME" "--days" "$DAYS")
  [[ "$DRY_RUN" == "1" ]] && ARGS+=("--dry-run")

  if ! bash "$ROOT_DIR/run.sh" "${ARGS[@]}"; then
    echo "[auto-push] ERROR: profile '$PROFILE_NAME' failed" >&2
    EXIT_CODE=1
  fi
done

exit $EXIT_CODE
