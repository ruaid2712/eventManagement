drop function if exists public.request_team_withdrawal(bigint, bigint);

create function public.request_team_withdrawal(
  p_event_id bigint,
  p_student_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.events%rowtype;
  target_team_id bigint;
  current_leader_id bigint;
  member_count bigint;
  new_request_id bigint;
begin
  select * into target_event
  from public.events
  where event_id = p_event_id
  for update;

  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if target_event.game_type <> 'team' then
    raise exception 'This event does not use team registration' using errcode = '22023';
  end if;

  select registration.team_id, team.leader_id
  into target_team_id, current_leader_id
  from public.registrations registration
  join public.teams team on team.team_id = registration.team_id
  join public.team_members member
    on member.team_id = registration.team_id
    and member.student_id = p_student_id
  where registration.event_id = p_event_id
  for update of registration, team;

  if target_team_id is null then
    raise exception 'You are not registered for this event' using errcode = '22023';
  end if;

  if current_leader_id = p_student_id then
    select count(*) into member_count
    from public.team_members
    where team_id = target_team_id;

    if member_count = 1 then
      delete from public.registrations
      where event_id = p_event_id
        and team_id = target_team_id;

      if not exists (
        select 1 from public.registrations
        where team_id = target_team_id
      ) then
        delete from public.teams where team_id = target_team_id;
      end if;

      return jsonb_build_object('status', 'withdrawn');
    end if;

    raise exception 'Team leaders must transfer leadership before requesting withdrawal' using errcode = '22023';
  end if;

  insert into public.team_withdrawal_requests (team_id, event_id, student_id)
  values (target_team_id, p_event_id, p_student_id)
  on conflict (team_id, event_id, student_id) where status = 'pending'
  do nothing
  returning request_id into new_request_id;

  if new_request_id is null then
    select request_id into new_request_id
    from public.team_withdrawal_requests
    where team_id = target_team_id
      and event_id = p_event_id
      and student_id = p_student_id
      and status = 'pending';
  end if;

  return jsonb_build_object('status', 'pending', 'requestId', new_request_id);
end;
$$;

revoke all on function public.request_team_withdrawal(bigint, bigint) from public, anon, authenticated;
grant execute on function public.request_team_withdrawal(bigint, bigint) to service_role;
