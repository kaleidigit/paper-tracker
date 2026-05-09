/**
 * time-window.ts
 * 智能时间窗口计算模块，支持工作日推送逻辑
 */

export interface TimeWindowConfig {
  timezone: string;
  mode: 'auto' | 'manual';
}

export interface TimeWindow {
  startAt: Date;
  endAt: Date;
  days: number;
  reason: string;
}

/**
 * 计算推送时间窗口
 * - 周一（Monday=1）：推送周五、周六、周日的论文（3天）
 * - 周二-周五：推送昨天的论文（1天）
 * - 周六、周日：不推送（但如果手动运行，推送昨天的论文）
 */
export function calculateTimeWindow(config: TimeWindowConfig): TimeWindow {
  const { timezone, mode } = config;

  // 获取当前时区的时间
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const dayOfWeek = nowInTz.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday

  let daysToGoBack = 1;
  let reason = '默认推送昨天的论文';

  if (mode === 'auto') {
    // 自动推送模式：周一推送3天，周二-周五推送1天
    if (dayOfWeek === 1) {
      // 周一：推送周五、周六、周日（3天）
      daysToGoBack = 3;
      reason = '周一推送周五-周日的论文';
    } else if (dayOfWeek >= 2 && dayOfWeek <= 5) {
      // 周二-周五：推送昨天（1天）
      daysToGoBack = 1;
      reason = '工作日推送昨天的论文';
    } else {
      // 周六、周日：理论上不应该自动推送，但如果运行了，推送昨天
      daysToGoBack = 1;
      reason = '周末不应自动推送，但如果运行则推送昨天';
    }
  } else {
    // 手动推送模式：始终推送昨天
    daysToGoBack = 1;
    reason = '手动推送模式，推送昨天的论文';
  }

  // 计算开始时间：往前推 daysToGoBack 天，设置为 08:00:00
  const startAt = new Date(nowInTz);
  startAt.setDate(nowInTz.getDate() - daysToGoBack);
  startAt.setHours(8, 0, 0, 0);

  // 结束时间：当前时间
  const endAt = new Date(nowInTz);

  return {
    startAt,
    endAt,
    days: daysToGoBack,
    reason
  };
}

/**
 * 格式化时间窗口为可读字符串
 */
export function formatTimeWindow(window: TimeWindow, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return `${formatter.format(window.startAt)} ~ ${formatter.format(window.endAt)} (${window.days}天, ${window.reason})`;
}
