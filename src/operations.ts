import { Context } from 'koishi'

import { normalizeSquadId, Squad, SquadDndRuleInstanceWithSlot } from './model'
import { fail, nn } from './utils'

export type SquadLookupScope = 'public' | 'member' | 'public-or-member' | 'invited'

export interface SquadSelector {
  id?: string
  name?: string
}

export function validateName(name: string): string {
  name = name.trim().normalize('NFC')
  if (!name) fail('小队名不能为空。')
  if (name.includes('#')) fail('小队名不能包含 #。')
  return name
}

export function formatSquad(squad: Pick<Squad, 'id' | 'name'>) {
  return `${squad.name}#${squad.id}`
}

export function parseSquadSelector(source: string): SquadSelector {
  source = source.trim()
  if (!source) fail('小队标识不能为空。')

  const hashIndex = source.lastIndexOf('#')
  if (hashIndex >= 0) {
    const id = normalizeSquadId(source.slice(hashIndex + 1))
    if (!id) return fail(`无效的小队 ID：${source.slice(hashIndex + 1)}。`)
    const name = source.slice(0, hashIndex).trim()
    return {
      id,
      name: name ? validateName(name) : undefined,
    }
  }

  return { name: validateName(source) }
}

export async function resolveSquad(
  ctx: Context,
  uid: string,
  source: string,
  scope: SquadLookupScope,
): Promise<Squad> {
  const selector = parseSquadSelector(source)
  if (selector.id) {
    const [squad] = await ctx.database.get('w-squad-v2', { id: selector.id })
    if (squad && await isSquadVisibleInScope(ctx, uid, squad, scope)) return squad
    fail(`不存在可访问的小队 #${selector.id}。`)
  }

  const squadName = selector.name
  if (!squadName) return fail('小队名称不能为空。')
  const squads = await ctx.database.get('w-squad-v2', { name: squadName })
  const visible: Squad[] = []
  for (const squad of squads) {
    if (await isSquadVisibleInScope(ctx, uid, squad, scope)) visible.push(squad)
  }

  if (!visible.length) fail(`不存在可访问的名为${nn(squadName)}的小队。`)
  if (visible.length > 1) {
    fail(`存在多个名为${nn(squadName)}的小队，请使用 ID 指定：\n${
      visible.map(squad => `- ${formatSquad(squad)}`).join('\n')
    }`)
  }
  return visible[0]
}

async function isSquadVisibleInScope(
  ctx: Context,
  uid: string,
  squad: Squad,
  scope: SquadLookupScope,
) {
  if (scope === 'public' && squad.isPublic) return true

  if (scope === 'member' || scope === 'public-or-member') {
    if (scope === 'public-or-member' && squad.isPublic) return true
    const [member] = await ctx.database.get('w-squad-member-v2', { uid, squadId: squad.id })
    return !!member
  }

  if (scope === 'invited') {
    const [invitation] = await ctx.database.get('w-squad-invitation-v2', {
      squadId: squad.id,
      inviteeUid: uid,
    })
    return !!invitation
  }

  return false
}

export function parseUid(uid: string): { platform: string, userId: string } {
  const [platform, userId] = uid.split(':')
  return { platform, userId }
}

export async function getUserDndRules(ctx: Context, uid: string): Promise<SquadDndRuleInstanceWithSlot[]> {
  const rules = await ctx.database
    .select('w-squad-dnd-rule')
    .where({ uid })
    .orderBy('id')
    .execute()

  return rules.map((rule, index) => ({ ...rule, slot: index + 1 }))
}
