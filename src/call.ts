import { $, Context, h } from 'koishi'

import { testDndRule } from './dnd-rule'
import { getEndpointKey } from './endpoint'
import { SquadEndpoint, SquadMember } from './model'
import { parseUid } from './operations'

export interface SquadCallTarget {
  endpoint: SquadEndpoint
  members: SquadMember[]
}

export interface SquadCallPlan {
  targets: SquadCallTarget[]
  otherMemberCount: number
  dndMemberCount: number
  unboundMemberCount: number
}

export interface SquadCallDelivery {
  succeeded: SquadCallTarget[]
  failed: Array<{ target: SquadCallTarget, error: unknown }>
}

export async function createSquadCallPlan(
  ctx: Context,
  squadId: string,
  callerUid: string,
): Promise<SquadCallPlan> {
  const [members, endpoints] = await Promise.all([
    ctx.database.get('w-squad-member-v2', { squadId }),
    ctx.database.get('w-squad-endpoint', { squadId, enabled: true }),
  ])
  const otherMembers = members.filter(member => member.uid !== callerUid)

  const rules = otherMembers.length
    ? await ctx.database
      .select('w-squad-dnd-rule')
      .where(row => $.in(row.uid, otherMembers.map(member => member.uid)))
      .execute()
    : []
  const now = new Date()
  const dndUids = new Set(rules
    .filter(rule => testDndRule(rule.rule, now))
    .map(rule => rule.uid))

  const endpointsByUid = new Map<string, SquadEndpoint[]>()
  for (const endpoint of endpoints) {
    const list = endpointsByUid.get(endpoint.uid) ?? []
    list.push(endpoint)
    endpointsByUid.set(endpoint.uid, list)
  }

  let unboundMemberCount = 0
  const targets = new Map<string, { endpoint: SquadEndpoint, members: Map<string, SquadMember> }>()
  for (const member of otherMembers) {
    if (dndUids.has(member.uid)) continue

    // Native mentions only work when the member account belongs to the endpoint platform.
    const memberPlatform = parseUid(member.uid).platform
    const memberEndpoints = (endpointsByUid.get(member.uid) ?? [])
      .filter(endpoint => endpoint.platform === memberPlatform)
    if (!memberEndpoints.length) {
      unboundMemberCount ++
      continue
    }

    for (const endpoint of memberEndpoints) {
      const key = getEndpointKey(endpoint)
      const target = targets.get(key) ?? { endpoint, members: new Map() }
      target.members.set(member.uid, member)
      targets.set(key, target)
    }
  }

  return {
    targets: [...targets.values()]
      .map(({ endpoint, members }) => ({
        endpoint,
        members: [...members.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
      }))
      .sort((a, b) => getEndpointKey(a.endpoint).localeCompare(getEndpointKey(b.endpoint))),
    otherMemberCount: otherMembers.length,
    dndMemberCount: dndUids.size,
    unboundMemberCount,
  }
}

export async function deliverSquadCall(
  ctx: Context,
  targets: SquadCallTarget[],
  render: (target: SquadCallTarget) => h.Fragment,
): Promise<SquadCallDelivery> {
  const delivery: SquadCallDelivery = { succeeded: [], failed: [] }
  await Promise.all(targets.map(async (target) => {
    const { platform, selfId, channelId, guildId } = target.endpoint
    const bot = ctx.bots.find(bot => bot.platform === platform && bot.selfId === selfId)
    if (!bot) {
      const error = new Error(`bot ${platform}:${selfId} is unavailable`)
      delivery.failed.push({ target, error })
      ctx.logger.warn(
        'failed to call squad members in %s:%s/%s: %s',
        platform,
        selfId,
        channelId,
        error,
      )
      return
    }

    try {
      await bot.sendMessage(channelId, render(target), guildId || undefined)
      delivery.succeeded.push(target)
    } catch (error) {
      delivery.failed.push({ target, error })
      ctx.logger.warn(
        'failed to call squad members in %s:%s/%s: %s',
        platform,
        selfId,
        channelId,
        error,
      )
    }
  }))
  return delivery
}
