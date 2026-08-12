import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import Mock from '@koishijs/plugin-mock'
import { Context, h, type Plugin } from 'koishi'

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

function captureProactiveMessages(ctx: Context) {
  const bot = ctx.bots[0]
  const original = bot.sendMessage.bind(bot)
  const messages: Array<{ channelId: string, content: string }> = []
  bot.sendMessage = (async (channelId, content, referrer, options) => {
    if (options?.session) return original(channelId, content, referrer, options)
    messages.push({ channelId, content: h.normalize(content).join('') })
    return [`message-${messages.length}`]
  }) as typeof bot.sendMessage
  return messages
}

describe('squad command safeguards', () => {
  it('binds create and join channels by default', async () => {
    const ctx = await createFixture()
    const { id } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group-b')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)

    const bindings = await ctx.database.get('w-squad-endpoint', { squadId: id })
    assert.deepEqual(bindings.map(binding => [binding.uid, binding.channelId]).sort(), [
      ['mock:member', 'group-b'],
      ['mock:owner', 'group'],
    ])
  })

  it('supports disabling automatic create and join bindings', async () => {
    const ctx = await createFixture()
    const owner = ctx.mock.client('owner', 'group')
    const [created] = await owner.receive('squad.create Alpha -B', 1)
    const id = created.match(/#([0-9A-HJKMNP-TV-Z]{8})/)?.[1]
    assert.ok(id)

    const member = ctx.mock.client('member', 'group-b')
    await member.shouldReply(`squad.join #${id} --no-bind`, /成功加入小队/)
    assert.deepEqual(await ctx.database.get('w-squad-endpoint', { squadId: id }), [])
  })

  it('declares bind as a positive option with a negative short variant', async () => {
    const ctx = await createFixture()

    for (const name of ['squad.create', 'squad.join']) {
      const command = ctx.$commander.resolve(name)!
      const option = command._options.bind
      assert.equal(option.syntax, '--bind')
      assert.equal(option.fallback, true)
      assert.equal(option.variants.false.syntax, '-B')
      assert.equal(option.variants.false.value, false)
    }
  })

  it('does not create a binding from a direct conversation', async () => {
    const ctx = await createFixture()
    const owner = ctx.mock.client('owner')
    const [created] = await owner.receive('squad.create Alpha', 1)
    const id = created.match(/#([0-9A-HJKMNP-TV-Z]{8})/)?.[1]
    assert.ok(id)

    assert.deepEqual(await ctx.database.get('w-squad-endpoint', { squadId: id }), [])
  })

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

  it('mentions bound members and reports unbound members', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await member.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    await ctx.database.create('w-squad-member-v2', {
      uid: 'discord:foreign',
      nick: 'Foreign',
      squadId: id,
      perm: 'member',
    })

    const [reply] = await owner.receive(`squad.call #${id}`, 1)
    assert.match(reply, /<at id="member"\/>/)
    assert.doesNotMatch(reply, /<at id="foreign"\/>/)
    assert.match(reply, /有 1 名成员没有绑定任何可用群/)
  })

  it('counts each DND member once', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await member.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
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
    assert.match(reply, /没有可投递的小队呼叫/)
    assert.match(reply, /忽略了 1 名免打扰的成员/)
  })

  it('delivers to every binding and merges the local call with its result', async () => {
    const ctx = await createFixture()
    const { id } = await createSquad(ctx)
    const caller = ctx.mock.client('owner', 'group-a')
    const local = ctx.mock.client('local', 'group-a')
    const remoteB = ctx.mock.client('remote', 'group-b')
    const remoteC = ctx.mock.client('remote', 'group-c')

    await local.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await local.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    await remoteB.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await remoteB.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    await remoteC.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)

    const proactive = captureProactiveMessages(ctx)
    const replies = await caller.receive(`squad.call #${id} 集合`)

    assert.equal(replies.length, 1)
    assert.match(replies[0], /<at id="local"\/>/)
    assert.match(replies[0], /呼叫结果：成功投递到 3 个群，0 个群投递失败/)
    assert.equal(proactive.length, 2)
    assert.deepEqual(proactive.map(message => message.channelId).sort(), ['group-b', 'group-c'])
    for (const message of proactive) {
      assert.match(message.content, /<at id="remote"\/>/)
      assert.match(message.content, /【集合】/)
      assert.doesNotMatch(message.content, /呼叫结果/)
    }
  })

  it('reports delivery failures without failing the command', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    await ctx.database.create('w-squad-member-v2', {
      uid: 'discord:member',
      nick: 'member',
      squadId: id,
      perm: 'member',
    })
    await ctx.database.create('w-squad-endpoint', {
      squadId: id,
      uid: 'discord:member',
      platform: 'discord',
      selfId: 'offline',
      channelId: 'group-b',
      guildId: 'group-b',
      channelName: 'group-b',
      enabled: true,
      updatedAt: new Date(),
    })

    const [reply] = await owner.receive(`squad.call #${id}`, 1)
    assert.match(reply, /成功投递到 0 个群，1 个群投递失败/)
  })

  it('groups squad info by bindings in the current channel', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group-b')
    await owner.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await member.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)

    const [reply] = await owner.receive(`squad.info #${id}`, 1)
    assert.match(reply, /当前群成员：1\n\* 【你】【所有者】owner/)
    assert.match(reply, /其他成员：1\n\* member/)
  })

  it('omits the empty other-member group from squad info', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)

    const [reply] = await owner.receive(`squad.info #${id}`, 1)
    assert.match(reply, /当前群成员：1/)
    assert.doesNotMatch(reply, /其他成员/)
  })

  it('removes a member binding when they leave the squad', async () => {
    const ctx = await createFixture()
    const { id } = await createSquad(ctx)
    const member = ctx.mock.client('member', 'group-b')
    await member.shouldReply(`squad.join #${id}`, /成功加入小队/)
    await member.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)

    await member.shouldReply(`squad.leave #${id}`, /已离开小队/)
    assert.deepEqual(await ctx.database.get('w-squad-endpoint', {
      squadId: id,
      uid: 'mock:member',
    }), [])
  })

  it('binds each channel once and allows it to be unbound', async () => {
    const ctx = await createFixture()
    const { id, owner } = await createSquad(ctx)

    await owner.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    await owner.shouldReply(`squad.bind #${id}`, /已将当前群绑定/)
    assert.equal((await ctx.database.get('w-squad-endpoint', { squadId: id })).length, 1)
    await owner.shouldReply(`squad.groups #${id}`, /你为小队「Alpha#[^」]+」绑定了 1 个群/)
    await owner.shouldReply(`squad.unbind #${id}`, /已解除当前群/)
    await owner.shouldReply(`squad.unbind #${id}`, /当前群没有绑定/)
  })

  it('binds all joined squads in the current channel', async () => {
    const ctx = await createFixture()
    const { id: firstId, owner } = await createSquad(ctx, 'First')
    const { id: secondId } = await createSquad(ctx, 'Second')

    await owner.shouldReply('squad.bind -a', '已将当前群绑定到你加入的 2 个小队。')
    const bindings = await ctx.database.get('w-squad-endpoint', { uid: 'mock:owner' })
    assert.deepEqual(bindings.map(binding => binding.squadId).sort(), [firstId, secondId].sort())

    await owner.shouldReply('squad.bind --all', '已将当前群绑定到你加入的 2 个小队。')
    assert.equal((await ctx.database.get('w-squad-endpoint', { uid: 'mock:owner' })).length, 2)
  })

  it('changes the current member name in one squad', async () => {
    const ctx = await createFixture()
    const { id: firstId, owner } = await createSquad(ctx, 'First')
    const { id: secondId } = await createSquad(ctx, 'Second')

    await owner.shouldReply(
      `squad.callme #${firstId} New Call Name`,
      `已将你在小队「First#${firstId}」中的名称修改为「New Call Name」。`,
    )
    assert.equal((await ctx.database.get('w-squad-member-v2', {
      uid: 'mock:owner',
      squadId: firstId,
    }))[0].nick, 'New Call Name')
    assert.equal((await ctx.database.get('w-squad-member-v2', {
      uid: 'mock:owner',
      squadId: secondId,
    }))[0].nick, 'owner')

    const [info] = await owner.receive(`squad.info #${firstId}`, 1)
    assert.match(info, /【你】【所有者】New Call Name/)
  })

  it('explains missing and empty bind selections', async () => {
    const ctx = await createFixture()
    const client = ctx.mock.client('newcomer', 'group')

    await client.shouldReply(
      'squad.bind',
      '请指定要绑定的小队，或使用 --all 绑定所有加入的小队。',
    )
    await client.shouldReply('squad.bind -a', '你还没有加入任何小队。')
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
      /There are no other members in this squad\./,
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
