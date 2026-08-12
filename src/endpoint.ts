import { Session } from 'koishi'

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
