import { randomBytes } from 'node:crypto'

import { Context } from 'koishi'

import { SquadDndRule } from './dnd-rule'
import { PERMS, SquadJoinType, SquadPerm } from './enums'

export const SQUAD_ID_LENGTH = 8
export const SQUAD_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const SQUAD_MIGRATION_ID = 'v2'

export interface LegacySquad {
  id: number
  name: string
  joinType: SquadJoinType
  permCall: SquadPerm
  isPublic: boolean
}

export interface LegacySquadMember {
  uid: string
  nick: string
  squadId: number
  perm: SquadPerm
}

export interface LegacySquadInvitation {
  squadId: number
  inviterUid: string
  inviterNick: string
  inviteeUid: string
}

export interface Squad {
  id: string
  /** Temporary migration key. It can be removed after v2 has been deployed safely. */
  legacyId: number | null
  name: string
  joinType: SquadJoinType
  permCall: SquadPerm
  isPublic: boolean
}

export interface SquadMember {
  uid: string
  nick: string
  squadId: string
  perm: SquadPerm
}

export interface SquadInvitation {
  squadId: string
  inviterUid: string
  inviterNick: string
  inviteeUid: string
}

export interface SquadEndpoint {
  squadId: string
  uid: string
  platform: string
  selfId: string
  channelId: string
  guildId: string
  channelName: string
  enabled: boolean
  updatedAt: Date
}

export interface SquadMigration {
  id: string
  completedAt: Date
}

export interface SquadDndRuleInstance {
  id: number
  uid: string
  rule: SquadDndRule
}

export interface SquadDndRuleInstanceWithSlot extends SquadDndRuleInstance {
  slot: number
}

declare module 'koishi' {
  interface Tables {
    'w-squad': LegacySquad
    'w-squad-member': LegacySquadMember
    'w-squad-invitation': LegacySquadInvitation
    'w-squad-v2': Squad
    'w-squad-member-v2': SquadMember
    'w-squad-invitation-v2': SquadInvitation
    'w-squad-endpoint': SquadEndpoint
    'w-squad-migration': SquadMigration
    'w-squad-dnd-rule': SquadDndRuleInstance
  }
}

export function extendSquadModels(ctx: Context) {
  // Keep the v1 models readable until the v2 migration has been verified in production.
  ctx.model.extend('w-squad', {
    id: 'unsigned',
    name: 'string',
    joinType: 'string',
    permCall: 'string',
    isPublic: 'boolean',
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.model.extend('w-squad-member', {
    uid: 'string',
    nick: 'string',
    squadId: 'unsigned',
    perm: 'string',
  }, {
    primary: ['uid', 'squadId'],
    foreign: {
      squadId: ['w-squad', 'id'],
    },
  })

  ctx.model.extend('w-squad-invitation', {
    squadId: 'unsigned',
    inviterUid: 'string',
    inviterNick: 'string',
    inviteeUid: 'string',
  }, {
    primary: ['squadId', 'inviterUid', 'inviteeUid'],
    foreign: {
      squadId: ['w-squad', 'id'],
    },
  })

  ctx.model.extend('w-squad-v2', {
    id: `char(${SQUAD_ID_LENGTH})`,
    legacyId: { type: 'unsigned', nullable: true, initial: null },
    name: 'string',
    joinType: 'string',
    permCall: 'string',
    isPublic: 'boolean',
  }, {
    primary: 'id',
    unique: ['legacyId'],
    indexes: [['name', 'isPublic']],
  })

  ctx.model.extend('w-squad-member-v2', {
    uid: 'string',
    nick: 'string',
    squadId: `char(${SQUAD_ID_LENGTH})`,
    perm: 'string',
  }, {
    primary: ['uid', 'squadId'],
    indexes: [['squadId']],
    foreign: {
      squadId: ['w-squad-v2', 'id'],
    },
  })

  ctx.model.extend('w-squad-invitation-v2', {
    squadId: `char(${SQUAD_ID_LENGTH})`,
    inviterUid: 'string',
    inviterNick: 'string',
    inviteeUid: 'string',
  }, {
    primary: ['squadId', 'inviterUid', 'inviteeUid'],
    indexes: [['inviteeUid'], ['inviterUid']],
    foreign: {
      squadId: ['w-squad-v2', 'id'],
    },
  })

  ctx.model.extend('w-squad-endpoint', {
    squadId: `char(${SQUAD_ID_LENGTH})`,
    uid: 'string',
    platform: 'string',
    selfId: 'string',
    channelId: 'string',
    guildId: 'string',
    channelName: 'string',
    enabled: 'boolean',
    updatedAt: 'timestamp',
  }, {
    primary: ['squadId', 'uid', 'platform', 'selfId', 'channelId'],
    indexes: [['squadId'], ['uid', 'squadId']],
    foreign: {
      squadId: ['w-squad-v2', 'id'],
    },
  })

  ctx.model.extend('w-squad-migration', {
    id: 'string',
    completedAt: 'timestamp',
  }, {
    primary: 'id',
  })

  ctx.model.extend('w-squad-dnd-rule', {
    id: 'unsigned',
    uid: 'string',
    rule: 'json',
  }, {
    autoInc: true,
    primary: 'id',
  })
}

export function generateSquadId() {
  // Five random bits map exactly to one Crockford Base32 character without bias.
  return [...randomBytes(SQUAD_ID_LENGTH)]
    .map(value => SQUAD_ID_ALPHABET[value & 31])
    .join('')
}

export function normalizeSquadId(source: string) {
  const id = source.trim().toUpperCase()
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1')
  if (id.length !== SQUAD_ID_LENGTH || [...id].some(char => !SQUAD_ID_ALPHABET.includes(char))) {
    return null
  }
  return id
}

export interface SquadMigrationResult {
  skipped: boolean
  squads: number
  members: number
  invitations: number
}

export async function migrateSquadV2(
  ctx: Context,
  generateId: () => string = generateSquadId,
): Promise<SquadMigrationResult> {
  const [completed] = await ctx.database.get('w-squad-migration', { id: SQUAD_MIGRATION_ID })
  if (completed) return { skipped: true, squads: 0, members: 0, invitations: 0 }

  const [legacySquads, legacyMembers, legacyInvitations] = await Promise.all([
    ctx.database.get('w-squad', {}),
    ctx.database.get('w-squad-member', {}),
    ctx.database.get('w-squad-invitation', {}),
  ])

  const idMap = new Map<number, string>()
  for (const legacy of legacySquads) {
    const data = {
      name: legacy.name,
      joinType: legacy.joinType,
      permCall: normalizeLegacyPerm(legacy.permCall),
      isPublic: legacy.isPublic,
    }
    let [squad] = await ctx.database.get('w-squad-v2', { legacyId: legacy.id })
    for (let attempt = 0; !squad && attempt < 32; ++attempt) {
      const id = normalizeSquadId(generateId())
      if (!id) throw new Error('generated an invalid squad ID')
      try {
        squad = await ctx.database.create('w-squad-v2', {
          id,
          legacyId: legacy.id,
          ...data,
        })
      } catch (error) {
        // Another process may have migrated this row, or the random ID may collide.
        ;[squad] = await ctx.database.get('w-squad-v2', { legacyId: legacy.id })
        if (!squad) {
          const [collision] = await ctx.database.get('w-squad-v2', { id })
          if (!collision) throw error
        }
      }
    }
    if (!squad) throw new Error(`failed to allocate a v2 ID for legacy squad ${legacy.id}`)
    await ctx.database.set('w-squad-v2', { id: squad.id }, data)
    idMap.set(legacy.id, squad.id)
  }

  const members = legacyMembers.map((member) => ({
    ...member,
    squadId: requireMigratedId(idMap, member.squadId),
  }))
  const invitations = legacyInvitations.map((invitation) => ({
    ...invitation,
    squadId: requireMigratedId(idMap, invitation.squadId),
  }))

  if (members.length) {
    await ctx.database.upsert('w-squad-member-v2', members, ['uid', 'squadId'])
  }
  if (invitations.length) {
    await ctx.database.upsert(
      'w-squad-invitation-v2',
      invitations,
      ['squadId', 'inviterUid', 'inviteeUid'],
    )
  }

  await validateSquadMigration(ctx, legacySquads, members, invitations)
  await ctx.database.create('w-squad-migration', {
    id: SQUAD_MIGRATION_ID,
    completedAt: new Date(),
  }).catch(async (error) => {
    const [marker] = await ctx.database.get('w-squad-migration', { id: SQUAD_MIGRATION_ID })
    if (!marker) throw error
  })

  return {
    skipped: false,
    squads: legacySquads.length,
    members: members.length,
    invitations: invitations.length,
  }
}

function requireMigratedId(idMap: Map<number, string>, legacyId: number) {
  const id = idMap.get(legacyId)
  if (!id) throw new Error(`legacy row references missing squad ${legacyId}`)
  return id
}

async function validateSquadMigration(
  ctx: Context,
  legacySquads: LegacySquad[],
  members: SquadMember[],
  invitations: SquadInvitation[],
) {
  const [storedSquads, storedMembers, storedInvitations] = await Promise.all([
    ctx.database.get('w-squad-v2', {}),
    ctx.database.get('w-squad-member-v2', {}),
    ctx.database.get('w-squad-invitation-v2', {}),
  ])
  const squadsByLegacyId = new Map(storedSquads.map(squad => [squad.legacyId, squad]))
  const memberKeys = new Set(storedMembers.map(member => `${member.uid}\0${member.squadId}`))
  const invitationKeys = new Set(storedInvitations.map(invitation =>
    `${invitation.squadId}\0${invitation.inviterUid}\0${invitation.inviteeUid}`,
  ))

  for (const legacy of legacySquads) {
    const stored = squadsByLegacyId.get(legacy.id)
    if (!stored
      || stored.name !== legacy.name
      || stored.joinType !== legacy.joinType
      || stored.permCall !== normalizeLegacyPerm(legacy.permCall)
      || stored.isPublic !== legacy.isPublic) {
      throw new Error(`legacy squad ${legacy.id} was not migrated correctly`)
    }
  }
  for (const member of members) {
    if (!memberKeys.has(`${member.uid}\0${member.squadId}`)) {
      throw new Error(`failed to migrate member ${member.uid} of squad ${member.squadId}`)
    }
  }
  for (const invitation of invitations) {
    const key = `${invitation.squadId}\0${invitation.inviterUid}\0${invitation.inviteeUid}`
    if (!invitationKeys.has(key)) {
      throw new Error(`failed to migrate invitation to squad ${invitation.squadId}`)
    }
  }
}

function normalizeLegacyPerm(perm: unknown): SquadPerm {
  return PERMS.includes(perm as SquadPerm) ? perm as SquadPerm : 'member'
}

export async function createSquad(
  ctx: Context,
  data: Omit<Squad, 'id' | 'legacyId'>,
  generateId: () => string = generateSquadId,
) {
  for (let attempt = 0; attempt < 32; ++attempt) {
    const id = normalizeSquadId(generateId())
    if (!id) throw new Error('generated an invalid squad ID')
    try {
      return await ctx.database.create('w-squad-v2', { ...data, id, legacyId: null })
    } catch (error) {
      const [collision] = await ctx.database.get('w-squad-v2', { id })
      if (!collision) throw error
    }
  }
  throw new Error('failed to allocate a unique squad ID')
}
