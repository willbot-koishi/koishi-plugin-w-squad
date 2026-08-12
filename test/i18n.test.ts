import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import enUS from '../src/locales/en-US.yml'
import zhCN from '../src/locales/zh-CN.yml'

function collectLeafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('squad locales', () => {
  it('keeps Chinese and English locale keys in sync', () => {
    assert.deepEqual(collectLeafPaths(enUS).sort(), collectLeafPaths(zhCN).sort())
  })
})
