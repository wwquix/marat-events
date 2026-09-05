create or replace function public.get_event_analytics(p_event_id uuid)
returns table (
  event_id uuid,
  event_slug text,
  event_title text,
  starts_at timestamptz,
  event_capacity integer,
  event_price_cents integer,
  event_currency text,
  active_selection_count bigint,
  eligible_people bigint,
  audience_limit_exceeded boolean,
  campaign_count bigint,
  campaign_recipient_count bigint,
  campaign_recipient_people bigint,
  outbox_message_count bigint,
  registration_count bigint,
  registered_people bigint,
  paid_registration_count bigint,
  paid_people bigint,
  paid_revenue_cents bigint,
  checked_in_registration_count bigint,
  checked_in_people bigint,
  matching_participant_count bigint,
  liked_profile_count bigint,
  like_count bigint,
  match_count bigint,
  matched_profile_count bigint,
  remaining_capacity integer,
  oversold_by integer,
  selection_breakdown jsonb,
  campaign_breakdown jsonb,
  outbox_status_breakdown jsonb,
  ticket_breakdown jsonb,
  source_breakdown jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_event as (
    select event.*
    from public.events as event
    where event.id = p_event_id
  ),
  active_selections as (
    select selection.id, selection.name
    from public.event_audience_selections as selection
    where selection.event_id = p_event_id
      and selection.status = 'draft'
  ),
  selection_results as (
    select
      selection.id as selection_id,
      preview.person_id,
      preview.eligible
    from active_selections as selection
    cross join lateral public.preview_event_audience_selection(selection.id, 5001) as preview
  ),
  event_campaigns as (
    select campaign.*
    from public.campaigns as campaign
    where campaign.event_id = p_event_id
  ),
  event_campaign_recipients as (
    select recipient.*
    from public.campaign_recipients as recipient
    join event_campaigns as campaign on campaign.id = recipient.campaign_id
  ),
  event_outbox_messages as (
    select message.*
    from public.outbox_messages as message
    join event_campaigns as campaign on campaign.id = message.campaign_id
  ),
  event_registrations as (
    select registration.*
    from public.registrations as registration
    where registration.event_id = p_event_id
  ),
  active_check_ins as (
    select check_in.*
    from public.registration_check_ins as check_in
    where check_in.event_id = p_event_id
      and check_in.status = 'checked_in'
  ),
  active_matching_profiles as (
    select profile.*
    from public.matching_participant_profiles as profile
    where profile.event_id = p_event_id
      and profile.status = 'active'
  ),
  event_likes as (
    select matching_like.*
    from public.matching_likes as matching_like
    where matching_like.event_id = p_event_id
  ),
  event_matches as (
    select matching_match.*
    from public.matching_matches as matching_match
    where matching_match.event_id = p_event_id
  ),
  event_ticket_types as (
    select ticket.*
    from public.ticket_types as ticket
    where ticket.event_id = p_event_id
  ),
  ticket_rows as (
    select
      ticket.id as ticket_type_id,
      ticket.code,
      ticket.name,
      ticket.capacity,
      ticket.price_cents,
      ticket.currency,
      false as unassigned
    from event_ticket_types as ticket

    union all

    select
      null::uuid,
      'unassigned'::text,
      'Unassigned or invalid ticket'::text,
      null::integer,
      null::integer,
      event.currency,
      true
    from selected_event as event
    where exists (
      select 1
      from event_registrations as registration
      where not exists (
        select 1
        from event_ticket_types as ticket
        where ticket.id = registration.ticket_type_id
      )
    )
  ),
  source_values as (
    select distinct coalesce(nullif(trim(registration.source), ''), 'unknown') as source
    from event_registrations as registration
  )
  select
    event.id,
    event.slug,
    event.title,
    event.starts_at,
    event.capacity,
    event.price_cents,
    event.currency,
    (select count(*) from active_selections),
    (
      select count(distinct result.person_id)
      from selection_results as result
      where result.eligible
    ),
    exists (
      select 1
      from selection_results as result
      group by result.selection_id
      having count(*) >= 5001
    ),
    (select count(*) from event_campaigns),
    (select count(*) from event_campaign_recipients),
    (select count(distinct recipient.person_id) from event_campaign_recipients as recipient),
    (select count(*) from event_outbox_messages),
    (select count(*) from event_registrations),
    (
      select count(distinct registration.person_id)
      from event_registrations as registration
      where registration.person_id is not null
    ),
    (
      select count(*)
      from event_registrations as registration
      where registration.payment_status = 'paid'
    ),
    (
      select count(distinct registration.person_id)
      from event_registrations as registration
      where registration.payment_status = 'paid'
        and registration.person_id is not null
    ),
    coalesce(
      (
        select sum(registration.amount_cents)::bigint
        from event_registrations as registration
        where registration.payment_status = 'paid'
      ),
      0::bigint
    ),
    (select count(distinct check_in.registration_id) from active_check_ins as check_in),
    (
      select count(distinct registration.person_id)
      from active_check_ins as check_in
      join event_registrations as registration on registration.id = check_in.registration_id
      where registration.person_id is not null
    ),
    (select count(*) from active_matching_profiles),
    (select count(distinct matching_like.liker_profile_id) from event_likes as matching_like),
    (select count(*) from event_likes),
    (select count(*) from event_matches),
    (
      select count(*)
      from (
        select matching_match.profile_one_id as profile_id from event_matches as matching_match
        union
        select matching_match.profile_two_id as profile_id from event_matches as matching_match
      ) as matched_profile
    ),
    case
      when event.capacity is null then null
      else greatest(
        event.capacity - (
          select count(*)::integer
          from event_registrations as registration
          where registration.payment_status = 'paid'
        ),
        0
      )
    end,
    case
      when event.capacity is null then null
      else greatest(
        (
          select count(*)::integer
          from event_registrations as registration
          where registration.payment_status = 'paid'
        ) - event.capacity,
        0
      )
    end,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'selection_id', selection.id,
            'name', selection.name,
            'evaluated_count', (
              select count(*)
              from selection_results as result
              where result.selection_id = selection.id
            ),
            'eligible_count', (
              select count(*)
              from selection_results as result
              where result.selection_id = selection.id
                and result.eligible
            ),
            'limit_exceeded', (
              select count(*) >= 5001
              from selection_results as result
              where result.selection_id = selection.id
            )
          )
          order by lower(selection.name), selection.id
        )
        from active_selections as selection
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'campaign_id', campaign.id,
            'name', campaign.name,
            'channel', campaign.channel,
            'delivery_mode', campaign.delivery_mode,
            'status', campaign.status,
            'recipient_count', (
              select count(*)
              from event_campaign_recipients as recipient
              where recipient.campaign_id = campaign.id
            ),
            'outbox_message_count', (
              select count(*)
              from event_outbox_messages as message
              where message.campaign_id = campaign.id
            ),
            'outbox_statuses', coalesce(
              (
                select jsonb_object_agg(status_count.status, status_count.total order by status_count.status)
                from (
                  select message.status, count(*)::bigint as total
                  from event_outbox_messages as message
                  where message.campaign_id = campaign.id
                  group by message.status
                ) as status_count
              ),
              '{}'::jsonb
            )
          )
          order by campaign.created_at, campaign.id
        )
        from event_campaigns as campaign
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_object_agg(status_count.status, status_count.total order by status_count.status)
        from (
          select message.status, count(*)::bigint as total
          from event_outbox_messages as message
          group by message.status
        ) as status_count
      ),
      '{}'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'ticket_type_id', ticket.ticket_type_id,
            'code', ticket.code,
            'name', ticket.name,
            'capacity', ticket.capacity,
            'price_cents', ticket.price_cents,
            'currency', ticket.currency,
            'registration_count', (
              select count(*)
              from event_registrations as registration
              where (
                (not ticket.unassigned and registration.ticket_type_id = ticket.ticket_type_id)
                or (
                  ticket.unassigned
                  and not exists (
                    select 1
                    from event_ticket_types as known_ticket
                    where known_ticket.id = registration.ticket_type_id
                  )
                )
              )
            ),
            'paid_count', (
              select count(*)
              from event_registrations as registration
              where registration.payment_status = 'paid'
                and (
                  (not ticket.unassigned and registration.ticket_type_id = ticket.ticket_type_id)
                  or (
                    ticket.unassigned
                    and not exists (
                      select 1
                      from event_ticket_types as known_ticket
                      where known_ticket.id = registration.ticket_type_id
                    )
                  )
                )
            ),
            'checked_in_count', (
              select count(distinct check_in.registration_id)
              from active_check_ins as check_in
              join event_registrations as registration on registration.id = check_in.registration_id
              where (
                (not ticket.unassigned and registration.ticket_type_id = ticket.ticket_type_id)
                or (
                  ticket.unassigned
                  and not exists (
                    select 1
                    from event_ticket_types as known_ticket
                    where known_ticket.id = registration.ticket_type_id
                  )
                )
              )
            ),
            'paid_revenue_cents', coalesce(
              (
                select sum(registration.amount_cents)::bigint
                from event_registrations as registration
                where registration.payment_status = 'paid'
                  and (
                    (not ticket.unassigned and registration.ticket_type_id = ticket.ticket_type_id)
                    or (
                      ticket.unassigned
                      and not exists (
                        select 1
                        from event_ticket_types as known_ticket
                        where known_ticket.id = registration.ticket_type_id
                      )
                    )
                  )
              ),
              0::bigint
            )
          )
          order by ticket.unassigned, ticket.code, ticket.ticket_type_id
        )
        from ticket_rows as ticket
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'source', source_value.source,
            'registration_count', (
              select count(*)
              from event_registrations as registration
              where coalesce(nullif(trim(registration.source), ''), 'unknown') = source_value.source
            ),
            'paid_count', (
              select count(*)
              from event_registrations as registration
              where registration.payment_status = 'paid'
                and coalesce(nullif(trim(registration.source), ''), 'unknown') = source_value.source
            ),
            'checked_in_count', (
              select count(distinct check_in.registration_id)
              from active_check_ins as check_in
              join event_registrations as registration on registration.id = check_in.registration_id
              where coalesce(nullif(trim(registration.source), ''), 'unknown') = source_value.source
            )
          )
          order by source_value.source
        )
        from source_values as source_value
      ),
      '[]'::jsonb
    )
  from selected_event as event;
$$;

revoke execute on function public.get_event_analytics(uuid)
  from public, anon, authenticated;
grant execute on function public.get_event_analytics(uuid)
  to service_role;

comment on function public.get_event_analytics(uuid) is
  'Computes current event operations metrics from authoritative rows. Audience counts are explicitly flagged when a selection exceeds the supported 5,000-person evaluation boundary.';
