import { SessionError } from 'koishi'

export const fail = (message: string): never => {
  throw new SessionError('w-squad.error', [ message ])
}

export const getValidator = <const Ts extends readonly any[]>(values: Ts, desc = '值') => {
  type T = Ts[number]
  const is = (value: unknown): value is T => values.includes(value as T)
  const validate = (value: unknown): T => {
    if (! is(value))
      fail(`无效的${desc}。应为 ${values.join('|')}，得到了 ${value}。`)
    return value
  }
  return { is, validate }
}

export const nn = (text: string): string => `「${text}」`
export const em = (text: string): string => `【${text}】`
export const emIn = <T extends string>(desc: Record<T, string>, keys: T[], key: T) =>
  keys.includes(key) ? em(desc[key]) : ''
