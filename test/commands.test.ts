import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import Mock from '@koishijs/plugin-mock'
import { Context, type Plugin } from 'koishi'

import * as squadPlugin from '../src'

interface Fixture {
  ctx: Context
  mock: { dispose(): boolean }
}

const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ ctx, mock }) => {
    mock.dispose()
    await ctx.stop()
  }))
})

async function createFixture() {
  const ctx = new Context()
  ctx.plugin(memory)
  ctx.plugin(squadPlugin)
  const mock = ctx.plugin(Mock as Plugin.Constructor)
  fixtures.push({ ctx, mock })
  await ctx.start()
  return ctx
}

async function createSquad(ctx: Context, name = 'Alpha') {
  const owner = ctx.mock.client('owner', 'group')
  const [reply] = await owner.receive(`squad.create ${name}`, 1)
  const id = reply.match(/#([0-9A-HJKMNP-TV-Z]{8})/)?.[1]
  assert.ok(id, `missing squad ID in reply: ${reply}`)
  return { id, owner }
}

describe('squad command safeguards', () => {
  it('allows only owners to modify settings', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)

    await member.shouldReply(
      `squad.modify #${id} -n Hacked`,
      `你不是小队「Alpha#${id}」的所有者，无法修改设置。`,
    )
    assert.equal((await ctx.database.get('w-squad-v2', { id }))[0].name, 'Alpha')

    await owner.shouldReply(`squad.modify #${id} -n Renamed`, /设置已更新/)
    assert.equal((await ctx.database.get('w-squad-v2', { id }))[0].name, 'Renamed')
  })

  it('preserves ownership on self-targeted transfer and kick', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)

    await owner.shouldReply(
      `squad.transfer #${id} <at id="owner"/>`,
      '你已经是该小队的所有者。',
    )
    await owner.shouldReply(
      `squad.kick #${id} <at id="owner"/>`,
      '小队所有者不能将自己踢出小队。',
    )

    const [storedOwner] = await ctx.database.get('w-squad-member-v2', {
      uid: 'mock:owner',
      squadId: id,
    })
    assert.equal(storedOwner.perm, 'owner')
  })
})
