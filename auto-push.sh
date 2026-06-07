#!/usr/bin/env bash
# auto-push.sh — cron 定时任务入口
#
# 每天运行所有 profile 的完整 pipeline，合并生成 RSS。
# 周一 DAYS=3（周末积压），周二至五 DAYS=1。
# 周末跳过。
#
# 用法：
#   ./auto-push.sh               正式运行
#   ./auto-push.sh --dry-run     仅生成文件，不发邮件

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
# 加载环境变量
set -a && source .env && set +a

# ─── 参数解析 ───────────────────────────────────────────────

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|--dryrun) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo ""
      echo "  每天运行所有 profile，合并生成 RSS 和发送邮件"
      echo "  周一 DAYS=3（覆盖周末），周二至五 DAYS=1"
      echo "  --dry-run  仅生成文件，跳过邮件发送"
      exit 0 ;;
  esac
done

# ─── 日期逻辑 ──────────────────────────────────────────────

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

DRY_FLAG=""
[[ "$DRY_RUN" == "1" ]] && DRY_FLAG="--dry-run"

echo "[auto-push] day=$DAY_OF_WEEK days=$DAYS dry_run=$DRY_RUN"

bash "$ROOT_DIR/run.sh" --days "$DAYS" $DRY_FLAG
