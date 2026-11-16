create or replace function public.register_team_event(
  p_event_id bigint,
  p_leader_id bigint,
  p_team_name text,
  p_member_ids bigint[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.events%rowtype;
  normalized_member_ids bigint[];
  current_teams integer;
  new_team_id bigint;
  new_registration_id bigint;
begin
  select * into target_event
  from public.events
  where event_id = p_event_id
  for update;

  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if target_event.game_type <> 'team' then
    raise exception 'This event accepts individual registration' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.users
    where user_id = p_leader_id and role = 'student'
  ) then
    raise exception 'A valid student account is required' using errcode = '42501';
  end if;
  if nullif(trim(p_team_name), '') is null or length(trim(p_team_name)) > 100 then
    raise exception 'Team name must be between 1 and 100 characters' using errcode = '22023';
  end if;

  select array_agg(distinct member_id order by member_id)
  into normalized_member_ids
  from unnest(coalesce(p_member_ids, array[]::bigint[])) as members(member_id);

  if coalesce(cardinality(normalized_member_ids), 0) = 0
    or not (p_leader_id = any(normalized_member_ids)) then
    raise exception 'The team leader must be included in the member list' using errcode = '22023';
  end if;

  if (
    select count(*) from public.users
    where user_id = any(normalized_member_ids) and role = 'student'
  ) <> cardinality(normalized_member_ids) then
    raise exception 'All team members must be student accounts' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.registrations registration
    left join public.team_members member on member.team_id = registration.team_id
    where registration.event_id = p_event_id
      and (
        registration.student_id = any(normalized_member_ids)
        or member.student_id = any(normalized_member_ids)
      )
  ) then
    raise exception 'A team member is already registered for this event' using errcode = '23505';
  end if;

  select count(*)::integer into current_teams
  from public.registrations registration
  where registration.event_id = p_event_id
    and registration.team_id is not null;

  if current_teams >= target_event.capacity then
    raise exception 'No team places remain for this event' using errcode = '23514';
  end if;

  insert into public.teams (team_name, leader_id)
  values (trim(p_team_name), p_leader_id)
  returning team_id into new_team_id;

  insert into public.team_members (team_id, student_id)
  select new_team_id, unnest(normalized_member_ids);

  insert into public.registrations (event_id, team_id)
  values (p_event_id, new_team_id)
  returning registration_id into new_registration_id;

  return new_registration_id;
end;
$$;
