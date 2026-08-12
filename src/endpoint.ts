import { Context, Session } from 'koishi'

import { SquadEndpoint } from './model'

export interface EndpointIdentity {
  platform: string
  selfId: string
  channelId: string
  guildId: string
}

export function getEndpointIdentity(session: Session): EndpointIdentity {
  return {
    platform: session.platform,
    selfId: session.selfId,
    channelId: session.channelId,
    guildId: session.guildId ?? '',
  }
}

export function getEndpointKey(endpoint: EndpointIdentity) {
  return [endpoint.platform, endpoint.selfId, endpoint.channelId, endpoint.guildId].join('\0')
}

export function isCurrentEndpoint(endpoint: SquadEndpoint, session: Session) {
  return getEndpointKey(endpoint) === getEndpointKey(getEndpointIdentity(session))
}

export function getEndpointName(session: Session) {
  return session.event.guild?.name || session.event.channel?.name || session.channelId
}

export function createSquadEndpoint(session: Session, squadId: string): SquadEndpoint {
  return {
    squadId,
    uid: session.uid,
    ...getEndpointIdentity(session),
    channelName: getEndpointName(session),
    enabled: true,
    updatedAt: new Date(),
  }
}

export async function bindSquadEndpoint(ctx: Context, session: Session, squadId: string) {
  await ctx.database.upsert('w-squad-endpoint', [createSquadEndpoint(session, squadId)])
}
