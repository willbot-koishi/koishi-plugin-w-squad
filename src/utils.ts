import { SessionError, type Dict } from 'koishi'

export const fail = (path: string, param?: Dict): never => {
  throw new SessionError(path, param)
}

export const getValidator = <const Ts extends readonly any[]>(values: Ts, errorPath: string) => {
  type T = Ts[number]
  const is = (value: unknown): value is T => values.includes(value as T)
  const validate = (value: unknown): T => {
    if (!is(value)) {
      fail(errorPath, { expected: values.join('|'), actual: value })
    }
    return value
  }
  return { is, validate }
}
