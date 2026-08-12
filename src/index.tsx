import { $, Context, Schema, SessionError } from 'koishi'
import { createSquadCallPlan, deliverSquadCall, SquadCallTarget } from './call'
import { validateJoinType, JOIN_TYPE_PATH, OWNER_BADGE_PATH } from './enums'
import { getEndpointIdentity, getEndpointKey, getEndpointName, isCurrentEndpoint } from './endpoint'
import { formatSquad, getUserDndRules, parseUid, resolveSquad, validateName } from './operations'
import { explainDndRule, explainDndRuleWithFormatted, formatDndRule, parseDndRule, testDndRule } from './dnd-rule'
import { createSquad, extendSquadModels, migrateSquadV2, Squad } from './model'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

export * from './model'

export const name = 'w-squad'

export const inject = ['database']

export function apply(ctx: Context) {
  extendSquadModels(ctx)
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)

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

  ctx.command('squad')

  ctx.command('squad.create <name:string>')
    .option('joinType', '-j, --join-type <type:string>',
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

      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.modify <squad:string>')
    .option('name', '-n <name:string>')
    .option('joinType', '-j, --join-type <type:string>')
    .action(async ({ session, options }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const [member] = await ctx.database.get('w-squad-member-v2', {
        uid: session.uid,
        squadId: squad.id,
      })
      if (member?.perm !== 'owner') {
        return session.text('.not-owner', { squad: formatSquad(squad) })
      }

      const squadUpdate: Partial<Squad> = {}
      const updateDesc: string[] = []
      if (options.name) {
        squadUpdate.name = validateName(options.name)
        updateDesc.push(session.text('.setting-name', { name: squadUpdate.name }))
      }
      if (options.joinType) {
        squadUpdate.joinType = validateJoinType(options.joinType)
        updateDesc.push(session.text('.setting-join-type', {
          joinType: session.text(JOIN_TYPE_PATH[squadUpdate.joinType]),
        }))
      }

      if (!updateDesc.length) return session.text('.no-change')

      await ctx.database.set('w-squad-v2', { id: squad.id }, squadUpdate)
      return session.text('.success', {
        squad: formatSquad({ ...squad, ...squadUpdate }),
        changes: updateDesc.join('\n'),
      })
    })

  ctx.command('squad.invite <squad:string> <invitee:user>')
    .action(async ({ session }, source, inviteeUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const { uid: inviterUid, username: inviterNick } = session

      const [[inviterMember], [inviteeMember], [invitation]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: inviterUid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: inviteeUid, squadId: id }),
        ctx.database.get('w-squad-invitation-v2', { squadId: id, inviteeUid }),
      ])

      const params = { uid: inviteeUid, squad: formatSquad(squad) }
      if (!inviterMember) return session.text('.not-member', params)
      if (inviteeMember) return session.text('.already-member', params)
      if (invitation) return session.text('.already-invited', params)

      await ctx.database.create('w-squad-invitation-v2', {
        squadId: id,
        inviterUid,
        inviterNick,
        inviteeUid,
      })

      return session.text('.success', params)
    })

  ctx.command('squad.invite.list')
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
              <p>{session.text('.received-title')}</p>
              {
                invitationToMe.map(it => <p>
                  {session.text('.received-item', {
                    inviter: it.inviterNick,
                    squad: `${it.squadName}#${it.squadId}`,
                  })}
                </p>)
              }
            </>
            : <p>{session.text('.no-received')}</p>
        }
        <br />
        {
          invitationFromMe.length
            ? <>
              <p>{session.text('.sent-title')}</p>
              {
                invitationFromMe.map(it => <p>
                  {session.text('.sent-item', {
                    invitee: it.inviteeUid,
                    squad: `${it.squadName}#${it.squadId}`,
                  })}
                </p>)
              }
            </>
            : <p>{session.text('.no-sent')}</p>
        }
      </>
    })

  ctx.command('squad.invite.accept <squad:string>')
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

      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.invite.reject <squad:string>')
    .action(async ({ session }, source) => {
      const { uid } = session
      const squad = await resolveSquad(ctx, uid, source, 'invited')
      await ctx.database.remove('w-squad-invitation-v2', { squadId: squad.id, inviteeUid: uid })
    })

  ctx.command('squad.list')
    .option('all', '-a')
    .action(async ({ session, options }) => {
      if (options.all) {
        const squads = await ctx.database.get('w-squad-v2', { isPublic: true })

        return squads.length
          ? <>
            <p>{session.text('.public-summary', { count: squads.length })}</p>
            { squads.map(it => <p>
              {session.text('.item', {
                badge: it.joinType === 'free' ? session.text('w-squad.badges.free') : '',
                squad: formatSquad(it),
              })}
            </p>) }
          </>
          : session.text('.no-public')
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
          <p>{session.text('.joined-summary', { count: squads.length })}</p>
          { squads.map(it => <p>
            {session.text('.item', {
              badge: it.perm === 'owner' ? session.text(OWNER_BADGE_PATH) : '',
              squad: `${it.squadName}#${it.squadId}`,
            })}
          </p>) }
        </>
        : session.text('.no-joined')
    })

  ctx.command('squad.join <squad:string>')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'public')
      const { id, joinType } = squad

      const { uid } = session
      const [member] = await ctx.database.get('w-squad-member-v2', { uid, squadId: id })
      if (member) return session.text('.already-member', { squad: formatSquad(squad) })

      if (joinType === 'invite') {
        return session.text('.invitation-required', { squad: formatSquad(squad) })
      }

      await ctx.database.create('w-squad-member-v2', {
        uid,
        squadId: id,
        perm: 'member',
        nick: session.username,
      })

      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.leave <squad:string>')
    .alias('squad.quit')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad
      const [member] = await ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id })

      if (member.perm === 'owner') {
        await session.send(session.text('.dissolve-confirm', { squad: formatSquad(squad) }))
        const resp = await session.prompt()

        if (resp !== 'Y') return session.text('.cancelled')

        await Promise.all([
          ctx.database.remove('w-squad-member-v2', { squadId: id }),
          ctx.database.remove('w-squad-invitation-v2', { squadId: id }),
          ctx.database.remove('w-squad-endpoint', { squadId: id }),
        ])
        await ctx.database.remove('w-squad-v2', { id })
        return session.text('.dissolved', { squad: formatSquad(squad) })
      }

      await Promise.all([
        ctx.database.remove('w-squad-member-v2', { uid: session.uid, squadId: id }),
        ctx.database.remove('w-squad-endpoint', { uid: session.uid, squadId: id }),
      ])

      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.transfer <squad:string> <target:user>')
    .action(async ({ session }, source, targetUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: targetUid, squadId: id }),
      ])

      const params = { uid: targetUid, squad: formatSquad(squad) }
      if (member.perm !== 'owner') return session.text('.not-owner', params)
      if (targetUid === session.uid) return session.text('.self')
      if (!targetMember) return session.text('.target-not-member', params)

      await ctx.database.set('w-squad-member-v2', { uid: targetUid, squadId: id }, { perm: 'owner' })
      await ctx.database.set('w-squad-member-v2', { uid: session.uid, squadId: id }, { perm: 'member' })

      return session.text('.success', params)
    })

  ctx.command('squad.kick <squad:string> <target:user>')
    .action(async ({ session }, source, targetUid) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const { id } = squad

      const [[member], [targetMember]] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { uid: session.uid, squadId: id }),
        ctx.database.get('w-squad-member-v2', { uid: targetUid, squadId: id }),
      ])

      const params = { uid: targetUid, squad: formatSquad(squad) }
      if (member.perm !== 'owner') return session.text('.not-owner', params)
      if (targetUid === session.uid) return session.text('.self')
      if (!targetMember) return session.text('.target-not-member', params)

      await Promise.all([
        ctx.database.remove('w-squad-member-v2', { uid: targetUid, squadId: id }),
        ctx.database.remove('w-squad-endpoint', { uid: targetUid, squadId: id }),
      ])

      return session.text('.success', params)
    })

  ctx.command('squad.bind <squad:string>')
    .action(async ({ session }, source) => {
      if (session.isDirect) return session.text('.group-only')

      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const endpoint = getEndpointIdentity(session)
      await ctx.database.upsert('w-squad-endpoint', [{
        squadId: squad.id,
        uid: session.uid,
        ...endpoint,
        channelName: getEndpointName(session),
        enabled: true,
        updatedAt: new Date(),
      }])

      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.unbind <squad:string>')
    .action(async ({ session }, source) => {
      if (session.isDirect) return session.text('.group-only')

      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const endpoint = getEndpointIdentity(session)
      const query = { squadId: squad.id, uid: session.uid, ...endpoint }
      const [binding] = await ctx.database.get('w-squad-endpoint', query)
      if (!binding) return session.text('.not-bound', { squad: formatSquad(squad) })

      await ctx.database.remove('w-squad-endpoint', query)
      return session.text('.success', { squad: formatSquad(squad) })
    })

  ctx.command('squad.groups <squad:string>')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const endpoints = await ctx.database.get('w-squad-endpoint', {
        squadId: squad.id,
        uid: session.uid,
        enabled: true,
      })
      endpoints.sort((a, b) => getEndpointKey(a).localeCompare(getEndpointKey(b)))

      return endpoints.length
        ? <>
          <p>{session.text('.summary', { squad: formatSquad(squad), count: endpoints.length })}</p>
          {endpoints.map(endpoint => <p>{session.text('.item', {
            current: !session.isDirect && isCurrentEndpoint(endpoint, session)
              ? session.text('.current')
              : '',
            channel: endpoint.channelName,
            bot: `${endpoint.platform}:${endpoint.selfId}`,
          })}</p>)}
        </>
        : session.text('.none', { squad: formatSquad(squad) })
    })

  ctx.command('squad.call <squad:string> [message:text]')
    .action(async ({ session }, source, message) => {
      if (session.isDirect) return session.text('.group-only')

      const squad = await resolveSquad(ctx, session.uid, source, 'member')
      const plan = await createSquadCallPlan(ctx, squad.id, session.uid)
      const currentKey = getEndpointKey(getEndpointIdentity(session))
      const currentTarget = plan.targets.find(target => getEndpointKey(target.endpoint) === currentKey)
      const remoteTargets = plan.targets.filter(target => target !== currentTarget)

      const renderCall = (target: SquadCallTarget, current = false) => <>
        <p>
          {current ? <at id={session.userId}></at> : session.username}
          {' '}
          {session.text('.summary', { squad: formatSquad(squad) })}
          {' '}
          {target.members.map(member => <>
            <at id={parseUid(member.uid).userId}></at>
            {' '}
          </>)}
        </p>
        {message && <p>{session.text('.attached-message', { message })}</p>}
      </>

      const delivery = await deliverSquadCall(ctx, remoteTargets, target => renderCall(target))
      const succeeded = delivery.succeeded.length + (currentTarget ? 1 : 0)
      const failed = delivery.failed.length
      const renderResult = () => <>
        <p>{session.text('.result', { succeeded, failed })}</p>
        {plan.otherMemberCount ? '' : <p>{session.text('.no-members')}</p>}
        {plan.otherMemberCount && !plan.targets.length ? <p>{session.text('.no-delivery')}</p> : ''}
        {plan.dndMemberCount ? <p>{session.text('.dnd-summary', { count: plan.dndMemberCount })}</p> : ''}
        {plan.unboundMemberCount
          ? <p>{session.text('.unbound-summary', { count: plan.unboundMemberCount })}</p>
          : ''}
      </>

      return currentTarget
        ? <>{renderCall(currentTarget, true)}{renderResult()}</>
        : renderResult()
    })

  ctx.command('squad.info <squad:string>')
    .action(async ({ session }, source) => {
      const squad = await resolveSquad(ctx, session.uid, source, 'public-or-member')
      const { id, joinType } = squad

      const [members, endpoints] = await Promise.all([
        ctx.database.get('w-squad-member-v2', { squadId: id }),
        ctx.database.get('w-squad-endpoint', { squadId: id, enabled: true }),
      ])
      members.sort((a, b) => {
        if (a.perm !== b.perm) return a.perm === 'owner' ? -1 : 1
        return a.nick.localeCompare(b.nick) || a.uid.localeCompare(b.uid)
      })

      const renderMember = (member: typeof members[number]) => <p>
        {session.text('.member-item', {
          badges: (member.uid === session.uid ? session.text('w-squad.badges.self') : '')
            + (member.perm === 'owner' ? session.text(OWNER_BADGE_PATH) : ''),
          nick: member.nick,
        })}
      </p>

      return <>
        <p>{session.text('.name', { squad: formatSquad(squad) })}</p>
        <p>{session.text('.join-type', { joinType: session.text(JOIN_TYPE_PATH[joinType]) })}</p>
        <p>{session.text('.members', { count: members.length })}</p>
        {session.isDirect
          ? members.map(renderMember)
          : (() => {
            const currentUids = new Set(endpoints
              .filter(endpoint => isCurrentEndpoint(endpoint, session))
              .map(endpoint => endpoint.uid))
            const currentMembers = members.filter(member => currentUids.has(member.uid))
            const otherMembers = members.filter(member => !currentUids.has(member.uid))
            return <>
              <p>{session.text('.current-members', { count: currentMembers.length })}</p>
              {currentMembers.length
                ? currentMembers.map(renderMember)
                : <p>{session.text('.none')}</p>}
              <p>{session.text('.other-members', { count: otherMembers.length })}</p>
              {otherMembers.length
                ? otherMembers.map(renderMember)
                : <p>{session.text('.none')}</p>}
            </>
          })()}
      </>
    })

  ctx.command('squad.dnd')

  ctx.command('squad.dnd.test')
    .action(async ({ session }) => {
      const rules = await getUserDndRules(ctx, session.uid)

      const now = new Date()
      const matchedRules = rules.filter(it => testDndRule(it.rule, now))

      return matchedRules.length
        ? session.text('.active', {
          rules: matchedRules.map(it => `[${it.slot}] ${explainDndRuleWithFormatted(it.rule, session)}`).join('\n'),
        })
        : session.text('.inactive')
    })

  ctx.command('squad.dnd.rule')

  ctx.command('squad.dnd.rule.check <rule:text>')
    .action(async ({ session }, ruleText) => {
      try {
        const rule = parseDndRule(ruleText)
        return session.text('.valid', {
          rule: formatDndRule(rule),
          explanation: explainDndRule(rule, session),
        })
      }
      catch (err) {
        const error = err instanceof SessionError
          ? session.text(err.path, err.param)
          : (err as Error).message
        return session.text('.invalid', { error })
      }
    })

  ctx.command('squad.dnd.rule.list')
    .action(async ({ session }) => {
      const rules = await getUserDndRules(ctx, session.uid)

      return rules.length
        ? <>
          <p>{session.text('.summary', { count: rules.length })}</p>
          {
            rules.map(it => <p>
              {session.text('.item', {
                slot: it.slot,
                rule: explainDndRuleWithFormatted(it.rule, session),
              })}
            </p>)
          }
        </>
        : session.text('.none')
    })

  ctx.command('squad.dnd.rule.add <rule:text>')
    .action(async ({ session }, ruleText) => {
      const rule = parseDndRule(ruleText)
      const ruleInstance = await ctx.database.create('w-squad-dnd-rule', {
        uid: session.uid,
        rule,
      })
      return session.text('.success', {
        rule: explainDndRuleWithFormatted(ruleInstance.rule, session),
      })
    })

  ctx.command('squad.dnd.rule.remove <slot:number>')
    .action(async ({ session }, ruleSlot) => {
      const [rule] = await ctx.database
        .select('w-squad-dnd-rule')
        .where({ uid: session.uid })
        .orderBy('id', 'asc')
        .offset(ruleSlot - 1)
        .limit(1)
        .execute()

      if (!rule) return session.text('.not-found', { slot: ruleSlot })
      await ctx.database.remove('w-squad-dnd-rule', { id: rule.id })
      return session.text('.success', {
        rule: explainDndRuleWithFormatted(rule.rule, session),
      })
    })
}

export interface Config {}

export const Config: Schema<Config> = Schema.object({})
