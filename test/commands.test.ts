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
  ctx.middleware((session, next) => {
    if (session.userId === 'english') session.locales = ['en-US']
    return next()
  }, true)
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

  it('mentions only members on the current platform', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await ctx.database.create('w-squad-member-v2', {
      uid: 'discord:foreign',
      nick: 'Foreign',
      squadId: id,
      perm: 'member',
    })

    const [reply] = await owner.receive(`squad.call #${id}`, 1)
    assert.match(reply, /<at id="member"\/>/)
    assert.doesNotMatch(reply, /<at id="foreign"\/>/)
    assert.doesNotMatch(reply, /没有其他可呼叫的小队成员/)
  })

  it('counts each DND member once', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await ctx.database.create('w-squad-dnd-rule', {
      uid: 'mock:member',
      rule: { days: null, period: null },
    })
    await ctx.database.create('w-squad-dnd-rule', {
      uid: 'mock:member',
      rule: { days: null, period: null },
    })

    const [reply] = await owner.receive(`squad.call #${id}`, 1)
    assert.doesNotMatch(reply, /<at id="member"\/>/)
    assert.match(reply, /当前平台没有其他可呼叫的小队成员/)
    assert.match(reply, /忽略了 1 名免打扰的成员/)
  })

  it('renders commands and validation errors in English', async () => {
    const ctx = await createFixture()
    const client = ctx.mock.client('english', 'group')

    const [created] = await client.receive('squad.create Alpha', 1)
    assert.match(created, /^Created squad "Alpha#[0-9A-HJKMNP-TV-Z]{8}"\.$/)
    const id = created.match(/#([0-9A-HJKMNP-TV-Z]{8})/)![1]

    await client.shouldReply(
      `squad.modify #${id} --join-type invalid`,
      'Invalid join type. Expected free|invite, but received invalid.',
    )
    await client.shouldReply(
      'squad.info Missing',
      'No accessible squad exists with the name "Missing".',
    )
    await client.shouldReply(
      'squad.dnd.rule.check nonsense',
      'Invalid rule: Invalid weekday match: nonsense. Use * or a list such as mon-fri,sun.',
    )
    await client.shouldReply(
      'squad.dnd.rule.check *',
      'The rule is valid: * (every day, all day)',
    )
    await client.shouldReply(
      `squad.call #${id}`,
      /There are no other squad members available to call on this platform\./,
    )
  })

  it('provides Chinese and English command metadata', async () => {
    const ctx = await createFixture()
    const commands = ctx.$commander._commandList.filter(command =>
      command.name === 'squad' || command.name.startsWith('squad.'),
    )

    for (const command of commands) {
      const data = command.toJSON()
      assert.ok(data.description['zh-CN'], `missing zh-CN description for ${command.name}`)
      assert.ok(data.description['en-US'], `missing en-US description for ${command.name}`)
      for (const argument of data.arguments) {
        assert.ok(argument.description['zh-CN'], `missing zh-CN argument ${command.name}.${argument.name}`)
        assert.ok(argument.description['en-US'], `missing en-US argument ${command.name}.${argument.name}`)
      }
      for (const option of data.options) {
        assert.ok(option.description['zh-CN'], `missing zh-CN option ${command.name}.${option.name}`)
        assert.ok(option.description['en-US'], `missing en-US option ${command.name}.${option.name}`)
      }
    }
  })
})
