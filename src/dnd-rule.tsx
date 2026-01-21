import { fail } from './utils'

/**
 * 免打扰的星期列表（星期日为 `0`），`null` 表示每天
 */
export type SquadDndRuleDays = number[] | null

/**
 * 免打扰的时间段 `[start, end]`，单位为小时（如 7:30 为 `7.5`），`null` 表示全天
 */
export type SquadDndRulePeriod = [number, number] | null

export interface SquadDndRule {
  days: SquadDndRuleDays
  period: SquadDndRulePeriod
}


export function parseDndRule(ruleText: string): SquadDndRule {
  const [daysText, periodText] = ruleText.trim().toLowerCase().split(/\s+/)

  const days = parseDndRuleDays(daysText)
  const period = parseDndRulePeriod(periodText)

  return { days, period }
}

export const DAY_NAME_TO_NUM: Record<string, number> = {
  'sun': 0,
  'mon': 1,
  'tue': 2,
  'wed': 3,
  'thu': 4,
  'fri': 5,
  'sat': 6,
}

export const DAY_NUM_TO_NAME: Record<number, string> = [
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'
]

export const DAY_NUM_TO_EXPLAIN: Record<number, string> = [
  '周日', '周一', '周二', '周三', '周四', '周五', '周六'
]

export function parseDndRuleDay(dayText: string): number {
  if (dayText in DAY_NAME_TO_NUM) {
    return DAY_NAME_TO_NUM[dayText]
  }
  fail(`无效的星期：${dayText}。应为 ${Object.keys(DAY_NAME_TO_NUM).join('|')}。`)
}

export function parseDndRuleDays(daysText: string): SquadDndRuleDays {
  if (daysText === '*') return null

  const daySet = new Set<number>()
  for (const daysItemText of daysText.split(',')) {
    if (daysItemText in DAY_NAME_TO_NUM) {
      daySet.add(parseDndRuleDay(daysItemText))
    }
    else if (daysItemText.includes('-')) {
      const daysItemParts = daysItemText.split('-')
      if (daysItemParts.length !== 2) {
        fail(`无效的星期区间：${daysItemText}。应为形如 mon-fri 的区间。`)
      }
      const [dayStart, dayEnd] = daysItemParts.map(parseDndRuleDay)
      for (let day = dayStart; ; day = (day + 1) % 7) {
        daySet.add(day)
        if (day === dayEnd) break
      }
    }
    else {
      fail(`无效的星期匹配：${daysItemText}。应为通配符 * 或形如 mon-fri,sun 的列表。`)
    }
  }

  return [...daySet]
}

export function parseDndRulePeriod(periodText: string): SquadDndRulePeriod {
  if (! periodText) return null

  const parts = periodText.split('-')
  if (parts.length !== 2) {
    fail(`无效的时间段：${periodText}。应为形如 8:00-17:30 的区间。`)
  }

  let [hourStart, hourEnd] = parts.map(parseDndRuleTime)
  if (hourStart >= hourEnd) hourEnd = 24 + hourEnd

  return [hourStart, hourEnd]
}

export function parseDndRuleTime(timeText: string): number {
  const timeParts = timeText.split(':')
  if (timeParts.length > 2) {
    fail(`无效的时间：${timeText}。仅支持小时和分钟。`)
  }

  const [hourText, minuteText] = timeParts
  const hour = parseDndRuleHour(hourText) + parseDndRuleMinute(minuteText) / 60
  return hour
}

export function parseDndRuleHour(hourText: string): number {
  if (hourText.match(/^\d{1,2}$/)) {
    const hour = Number(hourText)
    if (hour < 24) return hour
  }
  fail(`无效的小时：${hourText}。`)
}

export function parseDndRuleMinute(minuteText: string): number {
  if (! minuteText) return 0
  if (minuteText.match(/^\d{2}$/)) {
    const minute = Number(minuteText)
    if (minute < 60) return minute
  }
  fail(`无效的分钟：${minuteText}。`)
}

export function formatDndRule(rule: SquadDndRule): string {
  const daysText = formatDndRuleDays(rule.days)
  const periodText = formatDndRulePeriod(rule.period)
  return [daysText, periodText].filter(Boolean).join(' ')
}

export function formatDndRuleDays(days: SquadDndRuleDays): string {
  if (days === null) return '*'
  return days.toSorted().map(day => DAY_NUM_TO_NAME[day]).join(',')
}

export function formatDndRulePeriod(period: SquadDndRulePeriod): string {
  if (period === null) return ''
  const [hourStart, hourEnd] = period
  return [hourStart, hourEnd % 24].map(formatDndRuleTime).join('-')
}

export function formatDndRuleTime(hour: number): string {
  const hourInt = Math.floor(hour)
  const minute = Math.round((hour - hourInt) * 60)
  return [hourInt, minute].map(n => n.toString().padStart(2, '0')).join(':')
}

export function explainDndRule(rule: SquadDndRule): string {
  return `${explainDndRuleDays(rule.days)} ${explainDndRulePeriod(rule.period)}`
}

export function explainDndRuleDays(days: SquadDndRuleDays): string {
  if (days === null) return '每天'
  return days.toSorted().map(day => DAY_NUM_TO_EXPLAIN[day]).join('、')
}

export function explainDndRulePeriod(period: SquadDndRulePeriod): string {
  if (period === null) return '全天'
  const [hourStart, hourEnd] = period
  return `${formatDndRuleTime(hourStart)} 至${hourEnd >= 24 ? '次日' : ''} ${formatDndRuleTime(hourEnd % 24)}`
}

export function explainDndRuleWithFormatted(rule: SquadDndRule): string {
  return `${formatDndRule(rule)}（${explainDndRule(rule)}）`
}

export function testDndRule(rule: SquadDndRule, date: Date): boolean {
  if (rule.period) {
    const [hourStart, hourEnd] = rule.period
    if (hourEnd > 24) return (
      testDndRule({ ...rule, period: [hourStart, 24] }, date) ||
      testDndRule({ ...rule, period: [0, hourEnd - 24] }, new Date(+ date - 24 * 60 * 60 * 1000))
    )
  }

  const day = date.getDay()
  if (rule.days && ! rule.days.includes(day)) return false

  if (rule.period) {
    const hour = date.getHours() + date.getMinutes() / 60
    const [hourStart, hourEnd] = rule.period
    if (hour < hourStart || hour >= hourEnd) return false
  }

  return true
}
