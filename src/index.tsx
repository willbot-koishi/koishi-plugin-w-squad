import { $, Context, Schema } from 'koishi'
import { em, emIn, nn } from './utils'
import { validateJoinType, JOIN_TYPE_DESC, PERM_DESC } from './enums'
import { formatSquad, getUserDndRules, parseUid, resolveSquad, validateName } from './operations'
import { explainDndRule, explainDndRuleWithFormatted, formatDndRule, parseDndRule, testDndRule } from './dnd-rule'
import { createSquad, extendSquadModels, migrateSquadV2, Squad } from './model'

export * from './model'

export const name = 'w-squad'

export const inject = ['database']

export function apply(ctx: Context) {
  extendSquadModels(ctx)

  ctx.on('ready', async () => {
    const result = await migrateSquadV2(ctx)
    if (!result.skipped && (result.squads || result.members || result.invitations)) {
      ctx.logger.info(
        'migrated %d squad(s), %d member(s), and %d invitation(s) to v2',
        result.squads,
        result.members,
        result.invitations,
      )
    }
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
      const squad = await createSquad(ctx, {
        name,
        joinType: validateJoinType(options.joinType),
        permCall: 'member',
        isPublic: true,
      })
      try {
        await ctx.database.create('w-squad-member-v2', {
          uid: session.uid,
          squadId: squad.id,
          nick: session.username,
          perm: 'owner',
        })
      } catch (error) {
        await ctx.database.remove('w-squad-v2', { id: squad.id })
        throw error
      }

      return `成功创建小队 ${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.modify <squad:string>', '修改小队设置')
    .option('name', '-n <name:string> 小队名称')
    .option('joinType', '-j, --join-type <type:string> 加入小队方式 (free | invite)')
    .action(async ({ session, options }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const [member] = await ctx.database.get('w-squad-member-v2', {
        uid: session.uid,
        squadId: squad.id,
      })
      if (member?.perm !== 'owner') {
        return `你不是小队${nn(formatSquad(squad))}的所有者，无法修改设置。`
      }

      const squadUpdate: Partial<Squad> = {}
      const updateDesc: string[] = []
      if (options.name) {
        squadUpdate.name = validateName(options.name)
        updateDesc.push(`名称：${nn(squadUpdate.name)}`)
      }
      if (options.joinType) {
        squadUpdate.joinType = validateJoinType(options.joinType)
        updateDesc.push(`加入方式：${JOIN_TYPE_DESC[squadUpdate.joinType]}`)
      }

      if (! updateDesc.length) return '没有需要修改的设置。'

      await ctx.database.set('w-squad-v2', { id: squad.id }, squadUpdate)
      return `小队${nn(formatSquad({ ...squad, ...squadUpdate }))}设置已更新：\n${updateDesc.join('\n')}`
    })

  ctx.command('squad.invite <squad:string> <invitee:user>', '邀请用户加入小队')
    .action(async ({ session }, source, inviteeUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const { uid: inviterUid, username: inviterNick } = session

      const [[inviterMember], [inviteeMember], [invitation]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: inviterUid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: inviteeUid, squadId: id }),
        ctx.database.get('w-squad-invitation-v2', { squadId: id, inviteeUid }),
      ])

      if (!inviterMember) return `你不在小队${nn(formatSquad(squad))}中。`
      if (inviteeMember) return `用户${nn(inviteeUid)}已在小队${nn(formatSquad(squad))}中。`
      if (invitation) return `已有用户邀请${nn(inviteeUid)}加入小队 ${nn(formatSquad(squad))}。`

      await ctx.database.create('w-squad-invitation-v2', {
        squadId: id,
        inviterUid,
        inviterNick,
        inviteeUid,
      })

      return `已邀请用户${nn(inviteeUid)}加入小队 ${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.invite.list', '查看和我有关的邀请')
    .action(async ({ session }) => {
      const { uid } = session

      const [invitationToMe, invitationFromMe] = await Promise.all([
        ctx.database
          .join(
            { squad: 'w-squad-v2', invitation: 'w-squad-invitation-v2' },
            row => $.and(
              $.eq(row.squad.id, row.invitation.squadId),
              $.eq(row.invitation.inviteeUid, uid),
            )
          )
          .project({
            squadName: row => row.squad.name,
            squadId: row => row.squad.id,
            inviterNick: row => row.invitation.inviterNick,
          })
          .execute(),
        ctx.database
          .join(
            { squad: 'w-squad-v2', invitation: 'w-squad-invitation-v2' },
            row => $.and(
              $.eq(row.squad.id, row.invitation.squadId),
              $.eq(row.invitation.inviterUid, uid),
            )
          )
          .project({
            squadName: row => row.squad.name,
            squadId: row => row.squad.id,
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
                  * {nn(it.inviterNick)} 邀请你加入小队 {nn(`${it.squadName}#${it.squadId}`)}
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
                  * 你邀请 {nn(it.inviteeUid)} 加入小队 {nn(`${it.squadName}#${it.squadId}`)}
                </p>)
              }
            </>
            : <p>你没有发出邀请。</p>
        }
      </>
    })

  ctx.command('squad.invite.accept <squad:string>', '接受加入小队邀请')
    .action(async ({ session }, source) => {
      const { uid } = session

      const squad = await resolveSquad(ctx, uid, source, 'invited')
      const { id } = squad

      await Promise.all([
        ctx.database.create('w-squad-member-v2', {
          uid,
          squadId: id,
          nick: session.username,
          perm: 'member',
        }),
        ctx.database.remove('w-squad-invitation-v2', { squadId: id, inviteeUid: uid }),
      ])

      return `成功加入小队 ${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.invite.reject <squad:string>', '拒绝加入小队邀请')
    .action(async ({ session }, source) => {
      const { uid } = session
      const squad = await resolveSquad(ctx, uid, source, 'invited')
      await ctx.database.remove('w-squad-invitation-v2', { squadId: squad.id, inviteeUid: uid })
    })

  ctx.command('squad.list', '列出我加入的小队')
    .option('all', '-a 列出所有小队')
    .action(async ({ session, options }) => {
      if (options.all) {
        const squads = await ctx.database.get('w-squad-v2', { isPublic: true })

        return squads.length
          ? <>
            <p>当前共有 {squads.length} 个公开小队：</p>
            { squads.map(it => <p>
              * {emIn(JOIN_TYPE_DESC, ['free'], it.joinType)}{formatSquad(it)}
            </p>) }
          </>
          : '当前没有任何小队。'
      }

      const { uid } = session

      const squads = await ctx.database
        .join(
          { squad: 'w-squad-v2', member: 'w-squad-member-v2' },
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

  ctx.command('squad.join <squad:string>', '加入小队')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'public')
      const { id, joinType } = squad

      const { uid } = session
      const [member] = await ctx.database.get('w-squad-member-v2', { uid, squadId: id })
      if (member) return `你已在小队${nn(formatSquad(squad))}中。`

      if (joinType === 'invite') return `小队${nn(formatSquad(squad))}需邀请才能加入。`

      await ctx.database.create('w-squad-member-v2', {
        uid,
        squadId: id,
        perm: 'member',
        nick: session.username,
      })

      return `成功加入小队 ${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.leave <squad:string>', '离开小队')
    .alias('squad.quit')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad
      const [member] = await ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id })

      if (member.perm === 'owner') {
        await session.send(`你是小队${nn(formatSquad(squad))}的所有者，离开小队将会解散小队。回复 Y 继续。`)
        const resp = await session.prompt()

        if (resp !== 'Y') return '操作已取消。'

        await Promise.all([
          ctx.database.remove('w-squad-member-v2', { squadId: id }),
          ctx.database.remove('w-squad-invitation-v2', { squadId: id }),
        ])
        await ctx.database.remove('w-squad-v2', { id })
        return `小队${nn(formatSquad(squad))}已被解散。`
      }

      await ctx.database.remove('w-squad-member-v2', { uid: session.uid, squadId: id })

      return `已离开小队 ${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.transfer <squad:string> <target:user>', '转让小队所有权')
    .action(async ({ session }, source, targetUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: targetUid, squadId: id }),
      ])

      if (member.perm !== 'owner') return `你不是小队${nn(formatSquad(squad))}的所有者，无法转让所有权。`
      if (!targetMember) return `用户${nn(targetUid)}不在小队${nn(formatSquad(squad))}中。`

      await ctx.database.set('w-squad-member-v2', { uid: targetUid, squadId: id }, { perm: 'owner' })
      await ctx.database.set('w-squad-member-v2', { uid: session.uid, squadId: id }, { perm: 'member' })

      return `已将小队 ${nn(formatSquad(squad))} 的所有权转让给用户 ${nn(targetUid)}。`
    })

  ctx.command('squad.kick <squad:string> <target:user>', '踢出小队成员')
    .action(async ({ session }, source, targetUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: targetUid, squadId: id }),
      ])

      if (member.perm !== 'owner') return `你不是小队${nn(formatSquad(squad))}的所有者，无法踢出成员。`
      if (!targetMember) return `用户${nn(targetUid)}不在小队${nn(formatSquad(squad))}中。`

      await ctx.database.remove('w-squad-member-v2', { uid: targetUid, squadId: id })

      return `已将用户${nn(targetUid)}踢出小队${nn(formatSquad(squad))}。`
    })

  ctx.command('squad.call <squad:string> [message:text]', '呼叫所有小队成员，可以附带一条消息')
    .action(async ({ session }, source, message) => {
      if (session.isDirect) return '此命令只能在群聊中使用。'

      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const members = await ctx.database.get('w-squad-member-v2', { squadId: id })

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
        return !dndMatched
      })

      return <>
        <p>
          <at id={session.userId}></at> 正在呼叫小队 {nn(formatSquad(squad))} 中所有成员！
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

  ctx.command('squad.info <squad:string>', '查看小队信息')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'public-or-member')
      const { id, joinType } = squad

      const members = await ctx.database.get('w-squad-member-v2', { squadId: id })

      return <>
        <p>小队：{formatSquad(squad)}</p>
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
