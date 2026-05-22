#!/usr/bin/env bash
# auto-push.sh — cron 定时任务入口
#
# 周一：环境能源日报(周末积压) + 经济学期刊入库 + 法学期刊入库 + 合并周刊(仅经济+法学)
# 周二至周五：仅环境能源日报
# 周末：跳过
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
      echo "  周一：环境能源日报 + 合并周刊；周二至周五：仅环境能源日报"
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

# ─── 执行 ────────────────────────────────────────────────
EXIT_CODE=0

if [[ "$DAY_OF_WEEK" == "1" ]]; then
  # ════════════════════════════════════════════════════════
  # 周一：top-journal daily digest + 经济学期刊入库 + 合并周刊
  # ════════════════════════════════════════════════════════

  # 1. 环境能源日报（DAYS=3，推送周五/六/日论文）
  echo "[auto-push] === Monday: top-journal daily digest ==="
  DAILY_ARGS=("--profile" "top" "--days" "3")
  [[ "$DRY_RUN" == "1" ]] && DAILY_ARGS+=("--dry-run")
  if bash "$ROOT_DIR/run.sh" "${DAILY_ARGS[@]}"; then
    echo "[auto-push] top-journal daily done."
  else
    echo "[auto-push] ERROR: top-journal daily digest failed" >&2
    EXIT_CODE=1
  fi

  # 2. 环境经济学期刊采集入库（DAYS=7，覆盖整周，不发日报）
  echo "[auto-push] === Monday: env-economics collect+store ==="
  export PROFILE="econ"
  for step in collect filter enrich store; do
    echo "[auto-push] >>> step: $step (econ)"
    if ! PUSH_DAYS=7 npx tsx src/cli.ts --step "$step" --profile econ; then
      echo "[auto-push] ERROR: step '$step' failed for econ" >&2
      EXIT_CODE=1
      break
    fi
    echo "[auto-push] <<< step: $step done"
  done

  # 3. 法学期刊采集入库
  if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo "[auto-push] === Monday: law collect+store ==="
    for step in collect filter enrich store; do
      echo "[auto-push] >>> step: $step (law)"
      if ! PUSH_DAYS=7 npx tsx src/cli.ts --step "$step" --profile law; then
        echo "[auto-push] ERROR: step '$step' failed for law" >&2
        EXIT_CODE=1
        break
      fi
      echo "[auto-push] <<< step: $step done"
    done
  fi

  # 4. 合并周刊（排除 top，仅经济+法学）
  if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo "[auto-push] === Monday: combined weekly ==="
    if ! npx tsx src/cli.ts --step weekly-all --profile top; then
      echo "[auto-push] ERROR: combined weekly failed" >&2
      EXIT_CODE=1
    fi
    echo "[auto-push] <<< weekly-all done"
  fi

else
  # ════════════════════════════════════════════════════════
  # 周二至周五：仅top-journal daily digest（DAYS=1）
  # ════════════════════════════════════════════════════════
  echo "[auto-push] === Weekday: top-journal daily ==="
  DAILY_ARGS=("--profile" "top" "--days" "1")
  [[ "$DRY_RUN" == "1" ]] && DAILY_ARGS+=("--dry-run")
  if bash "$ROOT_DIR/run.sh" "${DAILY_ARGS[@]}"; then
    echo "[auto-push] top-journal daily done."
  else
    echo "[auto-push] ERROR: top-journal daily failed" >&2
    EXIT_CODE=1
  fi
fi

exit $EXIT_CODE
