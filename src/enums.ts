import { getValidator } from './utils'

export const PERMS = ['owner', 'member'] as const
export type SquadPerm = typeof PERMS[number]
export const PERM_DESC: Record<SquadPerm, string> = {
  owner: '所有者',
  member: '成员',
}
export const { validate: validatePerm } = getValidator(PERMS, '权限')

export const JOIN_TYPE = ['free', 'invite'] as const
export type SquadJoinType = typeof JOIN_TYPE[number]
export const JOIN_TYPE_DESC: Record<SquadJoinType, string> = {
  free: '自由加入',
  invite: '邀请加入',
}
export const { validate: validateJoinType } = getValidator(JOIN_TYPE, '加入方式')
