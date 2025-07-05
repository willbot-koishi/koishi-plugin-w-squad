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