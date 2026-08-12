import { type Session } from 'koishi'

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

export function parseDndRuleDay(dayText: string): number {
  if (dayText in DAY_NAME_TO_NUM) {
    return DAY_NAME_TO_NUM[dayText]
  }
  fail('w-squad.errors.invalid-day', {
    day: dayText,
    expected: Object.keys(DAY_NAME_TO_NUM).join('|'),
  })
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
        fail('w-squad.errors.invalid-day-range', { range: daysItemText })
      }
      const [dayStart, dayEnd] = daysItemParts.map(parseDndRuleDay)
      for (let day = dayStart; ; day = (day + 1) % 7) {
        daySet.add(day)
        if (day === dayEnd) break
      }
    }
    else {
      fail('w-squad.errors.invalid-days', { days: daysItemText })
    }
  }

  return [...daySet]
}

export function parseDndRulePeriod(periodText: string): SquadDndRulePeriod {
  if (! periodText) return null

  const parts = periodText.split('-')
  if (parts.length !== 2) {
    fail('w-squad.errors.invalid-period', { period: periodText })
  }

  let [hourStart, hourEnd] = parts.map(parseDndRuleTime)
  if (hourStart >= hourEnd) hourEnd = 24 + hourEnd

  return [hourStart, hourEnd]
}

export function parseDndRuleTime(timeText: string): number {
  const timeParts = timeText.split(':')
  if (timeParts.length > 2) {
    fail('w-squad.errors.invalid-time', { time: timeText })
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
  fail('w-squad.errors.invalid-hour', { hour: hourText })
}

export function parseDndRuleMinute(minuteText: string): number {
  if (! minuteText) return 0
  if (minuteText.match(/^\d{2}$/)) {
    const minute = Number(minuteText)
    if (minute < 60) return minute
  }
  fail('w-squad.errors.invalid-minute', { minute: minuteText })
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

export function explainDndRule(rule: SquadDndRule, session: Session): string {
  return session.text('w-squad.dnd.explanation', {
    days: explainDndRuleDays(rule.days, session),
    period: explainDndRulePeriod(rule.period, session),
  })
}

export function explainDndRuleDays(days: SquadDndRuleDays, session: Session): string {
  if (days === null) return session.text('w-squad.dnd.every-day')
  const separator = session.text('w-squad.dnd.day-separator')
  return days.toSorted().map(day => session.text(`w-squad.dnd.days.${DAY_NUM_TO_NAME[day]}`)).join(separator)
}

export function explainDndRulePeriod(period: SquadDndRulePeriod, session: Session): string {
  if (period === null) return session.text('w-squad.dnd.all-day')
  const [hourStart, hourEnd] = period
  return session.text(`w-squad.dnd.${hourEnd >= 24 ? 'overnight-period' : 'period'}`, {
    start: formatDndRuleTime(hourStart),
    end: formatDndRuleTime(hourEnd % 24),
  })
}

export function explainDndRuleWithFormatted(rule: SquadDndRule, session: Session): string {
  return session.text('w-squad.dnd.formatted', {
    rule: formatDndRule(rule),
    explanation: explainDndRule(rule, session),
  })
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
