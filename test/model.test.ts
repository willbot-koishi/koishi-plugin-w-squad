import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import { Context } from 'koishi'

import {
  createSquad,
  extendSquadModels,
  migrateSquadV2,
  SQUAD_MIGRATION_ID,
} from '../src/model'
import { parseSquadSelector, resolveSquad } from '../src/operations'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.stop()))
})

async function createContext() {
  const ctx = new Context()
  ctx.plugin(memory)
  extendSquadModels(ctx)
  contexts.push(ctx)
  await ctx.start()
  return ctx
}

async function seedLegacySquads(ctx: Context) {
  await ctx.database.create('w-squad', {
    id: 1,
    name: 'Alpha',
    joinType: 'free',
    permCall: 'member',
    isPublic: true,
  })
  await ctx.database.create('w-squad', {
    id: 2,
    name: 'Alpha',
    joinType: 'invite',
    permCall: 'owner',
    isPublic: true,
  })
  await ctx.database.create('w-squad-member', {
    uid: 'qq:1000',
    nick: 'Alice',
    squadId: 1,
    perm: 'owner',
  })
  await ctx.database.create('w-squad-invitation', {
    squadId: 2,
    inviterUid: 'discord:2000',
    inviterNick: 'Bob',
    inviteeUid: 'qq:1000',
  })
}

describe('squad v2 migration', () => {
  it('copies v1 relations and skips completed migrations', async () => {
    const ctx = await createContext()
    await seedLegacySquads(ctx)
    const ids = ['00000001', '00000002']

    assert.deepEqual(await migrateSquadV2(ctx, () => ids.shift()!), {
      skipped: false,
      squads: 2,
      members: 1,
      invitations: 1,
    })

    const squads = await ctx.database.get('w-squad-v2', {})
    assert.deepEqual(squads.map(({ id, legacyId }) => ({ id, legacyId })), [{
      id: '00000001',
      legacyId: 1,
    }, {
      id: '00000002',
      legacyId: 2,
    }])
    assert.deepEqual(await ctx.database.get('w-squad-member-v2', {}), [{
      uid: 'qq:1000',
      nick: 'Alice',
      squadId: '00000001',
      perm: 'owner',
    }])
    assert.deepEqual(await ctx.database.get('w-squad-invitation-v2', {}), [{
      squadId: '00000002',
      inviterUid: 'discord:2000',
      inviterNick: 'Bob',
      inviteeUid: 'qq:1000',
    }])
    assert.equal((await ctx.database.get('w-squad', {})).length, 2)
    assert.equal((await ctx.database.get('w-squad-member', {})).length, 1)
    assert.equal((await ctx.database.get('w-squad-invitation', {})).length, 1)
    assert.equal((await ctx.database.get('w-squad-migration', { id: SQUAD_MIGRATION_ID })).length, 1)

    assert.deepEqual(await migrateSquadV2(ctx, () => {
      throw new Error('the completed migration must not allocate another ID')
    }), {
      skipped: true,
      squads: 0,
      members: 0,
      invitations: 0,
    })
  })

  it('does not mark a migration with broken legacy references as complete', async () => {
    const ctx = await createContext()
    await ctx.database.create('w-squad', {
      id: 1,
      name: 'Alpha',
      joinType: 'free',
      permCall: 'member',
      isPublic: true,
    })
    await ctx.database.create('w-squad-member', {
      uid: 'qq:1000',
      nick: 'Alice',
      squadId: 404,
      perm: 'owner',
    })

    await assert.rejects(migrateSquadV2(ctx, () => '00000001'), /missing squad 404/)
    assert.equal((await ctx.database.get('w-squad-migration', {})).length, 0)
    assert.equal((await ctx.database.get('w-squad-v2', {})).length, 1)

    await ctx.database.create('w-squad', {
      id: 404,
      name: 'Recovered',
      joinType: 'free',
      permCall: 'member',
      isPublic: true,
    })
    assert.deepEqual(await migrateSquadV2(ctx, () => '00000002'), {
      skipped: false,
      squads: 2,
      members: 1,
      invitations: 0,
    })
    assert.equal((await ctx.database.get('w-squad-v2', {})).length, 2)
    assert.equal((await ctx.database.get('w-squad-migration', {})).length, 1)
  })
})

describe('squad identity', () => {
  it('resolves names within the requested scope and IDs exactly', async () => {
    const ctx = await createContext()
    await seedLegacySquads(ctx)
    const ids = ['00000001', '00000002']
    await migrateSquadV2(ctx, () => ids.shift()!)

    assert.equal((await resolveSquad(ctx, 'qq:1000', 'Alpha', 'member')).id, '00000001')
    assert.equal((await resolveSquad(ctx, 'qq:1000', 'Alpha', 'invited')).id, '00000002')
    assert.equal((await resolveSquad(ctx, 'qq:1000', '#00000002', 'public')).id, '00000002')
    assert.equal((await resolveSquad(ctx, 'qq:1000', 'outdated#00000001', 'member')).name, 'Alpha')
    await assert.rejects(resolveSquad(ctx, 'qq:1000', 'Alpha', 'public'))
  })

  it('normalizes human-friendly ID input and retries ID collisions', async () => {
    const ctx = await createContext()
    await ctx.database.create('w-squad-v2', {
      id: '00000001',
      legacyId: null,
      name: 'Existing',
      joinType: 'free',
      permCall: 'member',
      isPublic: true,
    })

    const ids = ['00000001', '00000002']
    const squad = await createSquad(ctx, {
      name: 'New',
      joinType: 'free',
      permCall: 'member',
      isPublic: true,
    }, () => ids.shift()!)

    assert.equal(squad.id, '00000002')
    assert.deepEqual(parseSquadSelector('#oooooooi'), { id: '00000001', name: undefined })
    assert.deepEqual(parseSquadSelector('New#00000002'), { id: '00000002', name: 'New' })
  })
})
