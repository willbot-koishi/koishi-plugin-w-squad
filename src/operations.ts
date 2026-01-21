import { Context } from 'koishi'
import { Squad, SquadDndRuleInstanceWithSlot } from '.'
import { nn, fail } from './utils'

export function validateName(name: string): string {
  name = name.trim()
  if (! name) fail('小队名不能为空')
  return name
}

export async function validateSquadExists(ctx: Context, name: string): Promise<Squad> {
  const [squad] = await ctx.database.get('w-squad', { name })
  if (! squad) fail(`不存在名为${nn(name)}的小队。`)
  return squad
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
