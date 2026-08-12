import { getValidator } from './utils'

export const PERMS = ['owner', 'member'] as const
export type SquadPerm = typeof PERMS[number]
export const OWNER_BADGE_PATH = 'w-squad.badges.owner'
export const { validate: validatePerm } = getValidator(PERMS, 'w-squad.errors.invalid-permission')

export const JOIN_TYPE = ['free', 'invite'] as const
export type SquadJoinType = typeof JOIN_TYPE[number]
export const JOIN_TYPE_PATH: Record<SquadJoinType, string> = {
  free: 'w-squad.join-types.free',
  invite: 'w-squad.join-types.invite',
}
export const { validate: validateJoinType } = getValidator(JOIN_TYPE, 'w-squad.errors.invalid-join-type')
