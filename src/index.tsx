import { $, Context, Schema } from 'koishi'
import { em, emIn, nn } from './utils'
import { SquadPerm, SquadJoinType, validateJoinType, JOIN_TYPE_DESC, PERM_DESC } from './enums'
import { validateName, validateSquadExists, parseUid, getUserDndRules } from './operations'
import { explainDndRule, explainDndRuleWithFormatted, formatDndRule, parseDndRule, SquadDndRule, testDndRule } from './dnd-rule'

export const name = 'w-squad'

export const inject = ['database']

export interface SquadMember {
  uid: string
  nick: string
  squadId: number
  perm: SquadPerm
}

export interface Squad {
  id: number
  name: string
  joinType: SquadJoinType
  permCall: SquadPerm
  isPublic: boolean
}

export interface SquadInvitation {
  squadId: number
  inviterUid: string
  inviterNick: string
  inviteeUid: string
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
    'w-squad': Squad
    'w-squad-member': SquadMember
    'w-squad-invitation': SquadInvitation
    'w-squad-dnd-rule': SquadDndRuleInstance
  }
}

export function apply(ctx: Context) {
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

  ctx.model.extend('w-squad-invitation', {
    squadId: 'unsigned',
    inviterUid: 'string',
    inviterNick: 'string',
    inviteeUid: 'string',
  }, {
    primary: ['squadId', 'inviterUid', 'inviteeUid'],
    foreign: {
      squadId: ['w-squad', 'id'],
    }
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
    }
  })

  ctx.model.extend('w-squad-dnd-rule', {
    id: 'unsigned',
    uid: 'string',
    rule: 'json',
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.i18n.define('en-US', {
    'w-squad': {
      error: '{0}'
    }
  })

  ctx.command('squad', '小队')

  ctx.command('squad.create <name:string>', '创建一个小队')
    .option('joinType', '-j, --join-type <type:string> 加入小队方式 (free | invite)',
      { fallback: 'free' }
    )
    .action(async ({ session, options }, name) => {
      name = validateName(name)

      const [existingSquad] = await ctx.database.get('w-squad', { name })
      if (existingSquad) return `小队名${nn(name)}已被使用。`

      const squad = await ctx.database.create('w-squad', {
        name,
        joinType: validateJoinType(options.joinType),
        isPublic: true,
      })
      await ctx.database.create('w-squad-member', {
        uid: session.uid,
        squadId: squad.id,
        nick: session.username,
        perm: 'owner',
      })

      return `成功创建小队 ${nn(name)}。`
    })

  ctx.command('squad.modify <name:string>', '修改小队设置')
    .option('name', '-n <name:string> 小队名称')
    .option('joinType', '-j, --join-type <type:string> 加入小队方式 (free | invite)')
    .action(async ({ options }, name) => {
      name = validateName(name)
      const squad = await validateSquadExists(ctx, name)

      const squadUpdate: Partial<Squad> = {}
      const updateDesc: string[] = []
      if (options.name) {
        squadUpdate.name = validateName(options.name)
        updateDesc.push(`名称：${nn(name)}`)
      }
      if (options.joinType) {
        squadUpdate.joinType = validateJoinType(options.joinType)
        updateDesc.push(`加入方式：${JOIN_TYPE_DESC[squadUpdate.joinType]}`)
      }

      if (! updateDesc.length) return '没有需要修改的设置。'

      await ctx.database.set('w-squad', { id: squad.id }, squadUpdate)
      return `小队${nn(name)}设置已更新：\n${updateDesc.join('\n')}`
    })

  ctx.command('squad.invite <name:string> <invitee:user>', '邀请用户加入小队')
    .action(async ({ session }, name, inviteeUid) => {
      name = validateName(name)

      const { id } = await validateSquadExists(ctx, name)

      const { uid: inviterUid, username: inviterNick } = session

      const [[inviterMember], [inviteeMember], [invitation]] = await Promise.all([
        ctx.database.get('w-squad-member', { uid: inviterUid, squadId: id }),
        ctx.database.get('w-squad-member', { uid: inviteeUid, squadId: id }),
        ctx.database.get('w-squad-invitation', { squadId: id, inviteeUid }),
      ])

      if (! inviterMember) return `你不在小队${nn(name)}中。`
      if (inviteeMember) return `用户${nn(inviteeUid)}已在小队${nn(name)}中。`
      if (invitation) return `你已邀请过用户${nn(inviteeUid)}加入小队 ${nn(name)}。`

      await ctx.database.create('w-squad-invitation', {
        squadId: id,
        inviterUid,
        inviterNick,
        inviteeUid,
      })

      return `已邀请用户${nn(inviteeUid)}加入小队 ${nn(name)}。`
    })

  ctx.command('squad.invite.list', '查看和我有关的邀请')
    .action(async ({ session }) => {
      const { uid } = session

      const [invitationToMe, invitationFromMe] = await Promise.all([
        ctx.database
          .join(
            { squad: 'w-squad', invitation: 'w-squad-invitation' },
            row => $.and(
              $.eq(row.squad.id, row.invitation.squadId),
              $.eq(row.invitation.inviteeUid, uid),
            )
          )
          .project({
            squadName: row => row.squad.name,
            inviterNick: row => row.invitation.inviterNick,
          })
          .execute(),
        ctx.database
          .join(
            { squad: 'w-squad', invitation: 'w-squad-invitation' },
            row => $.and(
              $.eq(row.squad.id, row.invitation.squadId),
              $.eq(row.invitation.inviterUid, uid),
            )
          )
          .project({
            squadName: row => row.squad.name,
            inviteeUid: row => row.invitation.inviteeUid,
          })
          .execute(),
      ])

      return <>
        {
          invitationToMe.length
            ? <>
              <p>你收到的邀请：</p>
              {
                invitationToMe.map(it => <p>
                  * {nn(it.inviterNick)} 邀请你加入小队 {nn(it.squadName)}
                </p>)
              }
            </>
            : <p>你没有收到邀请。</p>
        }
        <br />
        {
          invitationFromMe.length
            ? <>
              <p>你发出的邀请：</p>
              {
                invitationFromMe.map(it => <p>
                  * 你邀请 {nn(it.inviteeUid)} 加入小队 {nn(it.squadName)}
                </p>)
              }
            </>
            : <p>你没有发出邀请。</p>
        }
      </>
    })

  ctx.command('squad.invite.accept <name:string>', '接受加入小队邀请')
    .action(async ({ session }, name) => {
      name = validateName(name)
      const { uid } = session

      const { id } = await validateSquadExists(ctx, name)
      const [invitation] = await ctx.database.get('w-squad-invitation', { squadId: id, inviteeUid: uid })
      if (! invitation) return `你没有收到小队${nn(name)}的邀请。`

      await Promise.all([
        ctx.database.create('w-squad-member', {
          uid,
          squadId: id,
          nick: session.username,
          perm: 'member',
        }),
        ctx.database.remove('w-squad-invitation', { squadId: id, inviteeUid: uid }),
      ])

      return `成功加入小队 ${nn(name)}。`
    })

  ctx.command('squad.invite.reject <name:string>', '拒绝加入小队邀请')
    .action(async ({ session }, name) => {
      name = validateName(name)

      const { uid } = session

      const { id } = await validateSquadExists(ctx, name)
      const [invitation] = await ctx.database.get('w-squad-invitation', { squadId: id, inviteeUid: uid })
      if (! invitation) return `你没有收到小队${nn(name)}的邀请。`

      await ctx.database.remove('w-squad-invitation', { squadId: id, inviteeUid: uid })
    })

  ctx.command('squad.list', '列出我加入的小队')
    .option('all', '-a 列出所有小队')
    .action(async ({ session, options }) => {
      if (options.all) {
        const squads = await ctx.database.get('w-squad', { isPublic: true })

        return squads.length
          ? <>
            <p>当前共有 {squads.length} 个公开小队：</p>
            { squads.map(it => <p>
              * {emIn(JOIN_TYPE_DESC, ['free'], it.joinType)}{it.name}#{it.id}
            </p>) }
          </>
          : '当前没有任何小队。'
      }

      const { uid } = session

      const squads = await ctx.database
        .join(
          { squad: 'w-squad', member: 'w-squad-member' },
          row => $.and(
            $.eq(row.squad.id, row.member.squadId),
            $.eq(row.member.uid, uid),
          )
        )
        .project({
          squadName: row => row.squad.name,
          squadId: row => row.squad.id,
          perm: row => row.member.perm,
        })
        .execute()

      return squads.length
        ? <>
          <p>你加入了 {squads.length} 个小队：</p>
          { squads.map(it => <p>
            * {emIn(PERM_DESC, ['owner'], it.perm)}{it.squadName}#{it.squadId}
          </p>) }
        </>
        : '你还没有加入任何小队。'
    })

  ctx.command('squad.join <name:string>', '加入小队')
    .action(async ({ session }, name) => {
      name = validateName(name)

      const { id, joinType } = await validateSquadExists(ctx, name)

      const { uid } = session
      const [member] = await ctx.database.get('w-squad-member', { uid, squadId: id })
      if (member) return `你已在小队${nn(name)}中。`

      if (joinType === 'invite') return `小队${nn(name)}需邀请才能加入。`

      await ctx.database.create('w-squad-member', {
        uid,
        squadId: id,
        perm: 'member',
        nick: session.username,
      })

      return `成功加入小队 ${nn(name)}。`
    })

  ctx.command('squad.leave <name:string>', '离开小队')
    .alias('squad.quit')
    .action(async ({ session }, name) => {
      name = validateName(name)

      const { id } = await validateSquadExists(ctx, name)
      const [member] = await ctx.database.get('w-squad-member', { uid: session.uid, squadId: id })

      if (! member) return `你不在小队${nn(name)}中。`

      if (member.perm === 'owner') {
        await session.send(`你是小队${nn(name)}的所有者，离开小队将会解散小队。回复 Y 继续。`)
        const resp = await session.prompt()

        if (resp !== 'Y') return '操作已取消。'

        await Promise.all([
          ctx.database.remove('w-squad', { id }),
          ctx.database.remove('w-squad-member', { squadId: id }),
        ])
        return `小队${nn(name)}已被解散。`
      }

      await ctx.database.remove('w-squad-member', { uid: session.uid, squadId: id })

      return `已离开小队 ${nn(name)}。`
    })

  ctx.command('squad.transfer <name:string> <target:user>', '转让小队所有权')
    .action(async ({ session }, name, targetUid) => {
      name = validateName(name)

      const squad = await validateSquadExists(ctx, name)
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member', { uid: targetUid, squadId: id }),
      ])

      if (! member) return `你不在小队${nn(name)}中。`
      if (member.perm !== 'owner') return `你不是小队${nn(name)}的所有者，无法转让所有权。`
      if (! targetMember) return `用户${nn(targetUid)}不在小队${nn(name)}中。`

      await ctx.database.set('w-squad-member', { uid: targetUid, squadId: id }, { perm: 'owner' })
      await ctx.database.set('w-squad-member', { uid: session.uid, squadId: id }, { perm: 'member' })

      return `已将小队 ${nn(name)} 的所有权转让给用户 ${nn(targetUid)}。`
    })

  ctx.command('squad.kick <name:string> <target:user>', '踢出小队成员')
    .action(async ({ session }, name, targetUid) => {
      name = validateName(name)

      const squad = await validateSquadExists(ctx, name)
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member', { uid: targetUid, squadId: id }),
      ])

      if (! member) return `你不在小队${nn(name)}中。`
      if (member.perm !== 'owner') return `你不是小队${nn(name)}的所有者，无法踢出成员。`
      if (! targetMember) return `用户${nn(targetUid)}不在小队${nn(name)}中。`

      await ctx.database.remove('w-squad-member', { uid: targetUid, squadId: id })

      return `已将用户${nn(targetUid)}踢出小队${nn(name)}。`
    })

  ctx.command('squad.call <name:string> [message:text]', '呼叫所有小队成员，可以附带一条消息')
    .action(async ({ session }, name, message) => {
      if (session.isDirect) return '此命令只能在群聊中使用。'

      name = validateName(name)
      const { id } = await validateSquadExists(ctx, name)

      const members = await ctx.database.get('w-squad-member', { squadId: id })
      if (! members.some(member => member.uid === session.uid)) return `你不在小队${nn(name)}中。`

      const membersSorted = members
        .filter(member => member.uid !== session.uid)
        .sort((a, b) => a.uid.localeCompare(b.uid))

      const memberDndRules = await ctx.database
        .select('w-squad-dnd-rule')
        .where(row => $.in(row.uid, membersSorted.map(member => member.uid)))
        .orderBy('uid', 'asc')
        .execute()

      let dndRuleIndex = 0
      let dndMatchedCount = 0
      const membersFiltered = membersSorted.filter(member => {
        let dndMatched = false
        while (true) {
          const dndRule = memberDndRules[dndRuleIndex]
          if (! dndRule || dndRule.uid !== member.uid) break

          const now = new Date()
          if (testDndRule(dndRule.rule, now)) {
            dndMatched = true
            dndMatchedCount ++
          }

          dndRuleIndex ++
        }
        return ! dndMatched
      })

      return <>
        <p>
          <at id={session.userId}></at> 正在呼叫小队 {nn(name)} 中所有成员！
          {
            membersFiltered.map(it => <>
              <at id={parseUid(it.uid).userId}></at>
              {' '}
            </>)
          }
          {
            dndMatchedCount ? <>（忽略了 {dndMatchedCount} 名免打扰的成员）</> : ''
          }
        </p>
        { message && <p>{em(message)}</p> }
      </>
    })

  ctx.command('squad.info <name:string>', '查看小队信息')
    .action(async ({ session }, name) => {
      name = validateName(name)

      const { id, joinType } = await validateSquadExists(ctx, name)

      const members = await ctx.database.get('w-squad-member', { squadId: id })

      return <>
        <p>小队：{name}#{id}</p>
        <p>加入方式：{JOIN_TYPE_DESC[joinType]}</p>
        <p>成员：{members.length}</p>
        {
          members.map(it => <p>
            * {it.uid === session.uid ? em('你') : '' }{emIn(PERM_DESC, ['owner'], it.perm)}{it.nick}
          </p>)
        }
      </>
    })

  ctx.command('squad.dnd', '小队呼叫免打扰')

  ctx.command('squad.dnd.test', '测试现在你是否处于免打扰时段')
    .action(async ({ session }) => {
      const rules = await getUserDndRules(ctx, session.uid)

      const now = new Date()
      const matchedRules = rules.filter(it => testDndRule(it.rule, now))

      return matchedRules.length
        ? `你当前处于免打扰时段，由以下规则生效：\n${
          matchedRules.map(it => `[${it.slot}] ${explainDndRuleWithFormatted(it.rule)}`).join('\n')
        }`
        : '你当前不处于免打扰时段。'
    })

  ctx.command('squad.dnd.rule', '小队呼叫免打扰规则')

  ctx.command('squad.dnd.rule.check <rule:text>', '检查小队呼叫免打扰规则格式')
    .action(async ({}, ruleText) => {
      try {
        const rule = parseDndRule(ruleText)
        return `规则格式正确：${formatDndRule(rule)}（${explainDndRule(rule)}）`
      }
      catch (err) {
        return `规则格式错误：${(err as Error).message}`
      }
    })

  ctx.command('squad.dnd.rule.list', '查看小队呼叫免打扰规则')
    .action(async ({ session }) => {
      const rules = await getUserDndRules(ctx, session.uid)

      return rules.length
        ? <>
          <p>你设置了 {rules.length} 条免打扰规则：</p>
          {
            rules.map(it => <p>
              [{it.slot}] {explainDndRuleWithFormatted(it.rule)}
            </p>)
          }
        </>
        : '你还没有设置任何免打扰规则。'
    })

  ctx.command('squad.dnd.rule.add <rule:text>', '添加小队呼叫免打扰规则')
    .action(async ({ session }, ruleText) => {
      const rule = parseDndRule(ruleText)
      const ruleInstance = await ctx.database.create('w-squad-dnd-rule', {
        uid: session.uid,
        rule,
      })
      return `已添加免打扰规则 ${explainDndRuleWithFormatted(ruleInstance.rule)}`
    })

  ctx.command('squad.dnd.rule.remove <slot:number>', '删除小队呼叫免打扰规则')
    .action(async ({ session }, ruleSlot) => {
      const [rule] = await ctx.database
        .select('w-squad-dnd-rule')
        .where({ uid: session.uid })
        .orderBy('id', 'asc')
        .offset(ruleSlot - 1)
        .limit(1)
        .execute()

      if (! rule) return `不存在编号为 [${ruleSlot}] 的免打扰规则。`
      await ctx.database.remove('w-squad-dnd-rule', { id: rule.id })
      return `已删除免打扰规则 ${explainDndRuleWithFormatted(rule.rule)}。`
    })
}

export interface Config {}

export const Config: Schema<Config> = Schema.object({})
