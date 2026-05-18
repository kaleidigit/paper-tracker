#!/usr/bin/env bash
# auto-push.sh — cron 定时任务入口
#
# 周一推送周刊（上周所有论文按期刊排列），周二至周五推送日刊，周末不推送
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
      echo "  自动推送（周一→周刊，周二至周五→日刊）"
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
  DAYS=3   # 周一：采集上周五/六/日，然后推送周刊
else
  DAYS=1   # 周二至周五：推送昨天
fi

# ─── 从 config.json 读取 profile 列表 ──────────────────────

PROFILES=()
if command -v python3 &>/dev/null && [[ -f config.json ]]; then
  while IFS= read -r line; do
    PROFILES+=("$line")
  done < <(python3 -c "import json,sys; print('\n'.join(json.load(open('config.json')).get('profiles',['top-journal-env-energy'])))")
fi
if [[ ${#PROFILES[@]} -eq 0 ]]; then
  PROFILES=("top-journal-env-energy")
fi

# ─── 调用 run.sh（依次运行所有 profile）────────────────────
EXIT_CODE=0

for PROFILE_NAME in "${PROFILES[@]}"; do
  echo "[auto-push] day_of_week=$DAY_OF_WEEK days=$DAYS dry_run=$DRY_RUN profile=$PROFILE_NAME"

  if [[ "$DAY_OF_WEEK" == "1" ]]; then
    # ── 周一：采集+入库，然后推送周刊 ────────────────────
    export PROFILE="$PROFILE_NAME"
    export PUSH_DAYS="$DAYS"
    [[ "$DRY_RUN" == "1" ]] && export PUSH_DRY_RUN="1"

    STEPS="collect filter enrich store"
    for step in $STEPS; do
      echo "[auto-push] >>> step: $step"
      if ! npx tsx src/cli.ts --step "$step" --profile "$PROFILE_NAME"; then
        echo "[auto-push] ERROR: step '$step' failed for profile '$PROFILE_NAME'" >&2
        EXIT_CODE=1
        break
      fi
      echo "[auto-push] <<< step: $step done"
    done

    # 前面步骤都成功，运行周刊
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      echo "[auto-push] >>> step: weekly"
      if ! npx tsx src/cli.ts --step weekly --profile "$PROFILE_NAME"; then
        echo "[auto-push] ERROR: weekly step failed for profile '$PROFILE_NAME'" >&2
        EXIT_CODE=1
      fi
      echo "[auto-push] <<< step: weekly done"
    fi
  else
    ARGS=("--profile" "$PROFILE_NAME" "--days" "$DAYS")
    [[ "$DRY_RUN" == "1" ]] && ARGS+=("--dry-run")

    if ! bash "$ROOT_DIR/run.sh" "${ARGS[@]}"; then
      echo "[auto-push] ERROR: profile '$PROFILE_NAME' failed" >&2
      EXIT_CODE=1
    fi
  fi
done

exit $EXIT_CODE
