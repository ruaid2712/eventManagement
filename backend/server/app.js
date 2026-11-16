import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { asyncHandler, getDatabaseError, HttpError, requireEventPayload, requirePositiveInteger, requireRegistrationPayload, toEventDto } from './errors.js';

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '40kb' }));

async function loadProfile(authUserId) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, auth_user_id, name, email, role, created_at')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(403, 'Your account profile is not ready yet. Please try again.');
  return data;
}

async function authenticate(request, optional = false) {
  const authorization = request.get('authorization');
  if (!authorization) {
    if (optional) return null;
    throw new HttpError(401, 'Sign in to continue.');
  }

  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'A valid access token is required.');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session is invalid or has expired.');
  const profile = await loadProfile(data.user.id);
  request.authUser = data.user;
  request.profile = profile;
  return profile;
}

function requireRole(role) {
  return asyncHandler(async (request, response, next) => {
    const profile = await authenticate(request);
    if (profile.role !== role) throw new HttpError(403, `A ${role} account is required.`);
    next();
  });
}

const requireAuth = asyncHandler(async (request, response, next) => {
  await authenticate(request);
  next();
});

function formatEvent(row, summary, registered) {
  return toEventDto(row, summary, registered);
}

app.get('/api/health', (request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/auth/me', requireAuth, asyncHandler(async (request, response) => {
  response.json({
    user: {
      id: Number(request.profile.user_id),
      name: request.profile.name,
      email: request.profile.email,
      role: request.profile.role,
    },
  });
}));

app.post('/api/auth/claim-admin', requireAuth, asyncHandler(async (request, response) => {
  if (request.profile.role === 'admin') {
    response.json({ user: { id: Number(request.profile.user_id), name: request.profile.name, email: request.profile.email, role: 'admin' } });
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .update({ role: 'admin' })
    .eq('user_id', request.profile.user_id)
    .eq('role', 'student')
    .select('user_id, name, email, role')
    .single();
  if (error) throw error;
  response.json({ user: { id: Number(data.user_id), name: data.name, email: data.email, role: data.role } });
}));

app.get('/api/events', asyncHandler(async (request, response) => {
  const profile = await authenticate(request, true);
  const { data: rows, error: eventError } = await supabase
    .from('events')
    .select('*')
    .order('event_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (eventError) throw eventError;

  const eventIds = rows.map((row) => row.event_id);
  if (!eventIds.length) {
    response.json({ events: [] });
    return;
  }

  const { data: summaries, error: summaryError } = await supabase
    .from('event_registration_summary')
    .select('event_id, registration_count, attendee_count')
    .in('event_id', eventIds);
  if (summaryError) throw summaryError;

  const registeredIds = new Set();
  if (profile?.role === 'student') {
    const studentId = Number(profile.user_id);
    const [{ data: directRegistrations, error: directError }, { data: memberships, error: memberError }] = await Promise.all([
      supabase.from('registrations').select('event_id').in('event_id', eventIds).eq('student_id', studentId),
      supabase.from('event_team_members').select('event_id').in('event_id', eventIds).eq('student_id', studentId),
    ]);
    if (directError) throw directError;
    if (memberError) throw memberError;
    for (const registration of directRegistrations) registeredIds.add(registration.event_id);
    for (const membership of memberships) registeredIds.add(membership.event_id);
  }

  const summaryByEvent = new Map(summaries.map((summary) => [summary.event_id, summary]));
  response.json({
    events: rows.map((row) => formatEvent(row, summaryByEvent.get(row.event_id), registeredIds.has(row.event_id))),
  });
}));

app.post('/api/events', requireRole('admin'), asyncHandler(async (request, response) => {
  const payload = requireEventPayload(request.body);
  const { data, error } = await supabase
    .from('events')
    .insert({ ...payload, created_by_admin: request.profile.user_id })
    .select('*')
    .single();
  if (error) throw error;
  response.status(201).json({ event: formatEvent(data, { registration_count: 0, attendee_count: 0 }) });
}));

app.post('/api/events/:eventId/register', requireRole('student'), asyncHandler(async (request, response) => {
  const eventId = requirePositiveInteger(request.params.eventId, 'Event ID');
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('event_id, game_type')
    .eq('event_id', eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw new HttpError(404, 'Event not found.');
  const registration = requireRegistrationPayload(request.body, event.game_type);
  let rpcResult;

  if (registration.type === 'single') {
    rpcResult = await supabase.rpc('register_single_event', {
      p_event_id: eventId,
      p_student_id: request.profile.user_id,
    });
  } else {
    const memberEmails = [...new Set([...registration.memberEmails, request.profile.email.toLowerCase()])];
    const { data: members, error: membersError } = await supabase
      .from('users')
      .select('user_id, email, role')
      .in('email', memberEmails);
    if (membersError) throw membersError;
    const memberByEmail = new Map(members.map((member) => [member.email.toLowerCase(), member]));
    const missingEmail = memberEmails.find((email) => !memberByEmail.has(email));
    if (missingEmail) throw new HttpError(400, `No registered student account was found for ${missingEmail}.`);
    const nonStudent = members.find((member) => member.role !== 'student');
    if (nonStudent) throw new HttpError(400, 'All team members must have student accounts.');

    rpcResult = await supabase.rpc('register_team_event', {
      p_event_id: eventId,
      p_leader_id: request.profile.user_id,
      p_team_name: registration.teamName,
      p_member_ids: members.map((member) => member.user_id),
    });
  }

  if (rpcResult.error) throw getDatabaseError(rpcResult.error);
  response.status(201).json({ registrationId: rpcResult.data });
}));

app.get('/api/events/:eventId/teams', requireRole('student'), asyncHandler(async (request, response) => {
  const eventId = requirePositiveInteger(request.params.eventId, 'Event ID');
  const studentId = Number(request.profile.user_id);
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('event_id, game_type')
    .eq('event_id', eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw new HttpError(404, 'Event not found.');
  if (event.game_type !== 'team') throw new HttpError(400, 'This event does not accept team registrations.');

  const { data: registrations, error: registrationError } = await supabase
    .from('registrations')
    .select('team_id')
    .eq('event_id', eventId)
    .not('team_id', 'is', null);
  if (registrationError) throw registrationError;
  const teamIds = registrations.map((registration) => registration.team_id);
  if (!teamIds.length) {
    response.json({ teams: [] });
    return;
  }

  const [teamResult, memberResult, joinRequestResult] = await Promise.all([
    supabase.from('teams').select('team_id, team_name, leader_id').in('team_id', teamIds),
    supabase.from('event_team_members').select('team_id, student_id').eq('event_id', eventId).in('team_id', teamIds),
    supabase.from('team_join_requests').select('team_id, status').eq('event_id', eventId).eq('student_id', studentId).in('team_id', teamIds).order('created_at', { ascending: false }),
  ]);
  if (teamResult.error) throw teamResult.error;
  if (memberResult.error) throw memberResult.error;
  if (joinRequestResult.error) throw joinRequestResult.error;

  const peopleIds = [...new Set([
    ...teamResult.data.map((team) => team.leader_id),
    studentId,
  ])];
  const { data: people, error: peopleError } = await supabase
    .from('users')
    .select('user_id, name')
    .in('user_id', peopleIds);
  if (peopleError) throw peopleError;

  const peopleById = new Map(people.map((person) => [person.user_id, person]));
  const countByTeam = new Map();
  const memberTeamIds = new Set();
  for (const member of memberResult.data) {
    countByTeam.set(member.team_id, (countByTeam.get(member.team_id) ?? 0) + 1);
    if (Number(member.student_id) === studentId) memberTeamIds.add(member.team_id);
  }
  const requestByTeam = new Map();
  for (const joinRequest of joinRequestResult.data) {
    if (!requestByTeam.has(joinRequest.team_id)) requestByTeam.set(joinRequest.team_id, joinRequest.status);
  }

  response.json({
    teams: teamResult.data.map((team) => ({
      id: Number(team.team_id),
      name: team.team_name,
      leaderName: peopleById.get(team.leader_id)?.name ?? 'Team leader',
      memberCount: countByTeam.get(team.team_id) ?? 0,
      isMember: memberTeamIds.has(team.team_id),
      requestStatus: requestByTeam.get(team.team_id) ?? null,
    })),
  });
}));

app.post('/api/events/:eventId/team-join-requests', requireRole('student'), asyncHandler(async (request, response) => {
  const eventId = requirePositiveInteger(request.params.eventId, 'Event ID');
  const teamId = requirePositiveInteger(request.body?.teamId, 'Team ID');
  const { data: requestId, error } = await supabase.rpc('request_team_join', {
    p_event_id: eventId,
    p_team_id: teamId,
    p_student_id: request.profile.user_id,
  });
  if (error) throw getDatabaseError(error);
  response.status(202).json({ requestId, status: 'pending' });
}));

app.delete('/api/events/:eventId/registration', requireRole('student'), asyncHandler(async (request, response) => {
  const eventId = requirePositiveInteger(request.params.eventId, 'Event ID');
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('game_type')
    .eq('event_id', eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw new HttpError(404, 'Event not found.');

  if (event.game_type === 'team') {
    const { data: result, error } = await supabase.rpc('request_team_withdrawal', {
      p_event_id: eventId,
      p_student_id: request.profile.user_id,
    });
    if (error) throw getDatabaseError(error);
    response.status(result.status === 'pending' ? 202 : 200).json(result);
    return;
  }

  const { error } = await supabase.rpc('withdraw_event_registration', {
    p_event_id: eventId,
    p_student_id: request.profile.user_id,
  });
  if (error) throw getDatabaseError(error);
  response.json({ status: 'withdrawn' });
}));

app.get('/api/teams/mine', requireRole('student'), asyncHandler(async (request, response) => {
  const studentId = Number(request.profile.user_id);
  const [membershipResult, myJoinRequestResult, myWithdrawalResult] = await Promise.all([
    supabase.from('event_team_members').select('team_id, event_id, joined_at').eq('student_id', studentId),
    supabase.from('team_join_requests').select('team_id').eq('student_id', studentId),
    supabase.from('team_withdrawal_requests').select('team_id').eq('student_id', studentId),
  ]);
  const { data: memberships, error: membershipError } = membershipResult;
  if (membershipError) throw membershipError;
  if (myJoinRequestResult.error) throw myJoinRequestResult.error;
  if (myWithdrawalResult.error) throw myWithdrawalResult.error;
  const teamIds = [...new Set([
    ...memberships.map((membership) => membership.team_id),
    ...myJoinRequestResult.data.map((joinRequest) => joinRequest.team_id),
    ...myWithdrawalResult.data.map((withdrawal) => withdrawal.team_id),
  ])];
  if (!teamIds.length) {
    response.json({ teams: [] });
    return;
  }

  const [teamResult, memberResult, registrationResult, withdrawalResult, joinRequestResult] = await Promise.all([
    supabase.from('teams').select('team_id, team_name, leader_id, created_at').in('team_id', teamIds),
    supabase.from('event_team_members').select('team_id, event_id, student_id, joined_at').in('team_id', teamIds),
    supabase.from('registrations').select('team_id, event_id, registered_at').in('team_id', teamIds),
    supabase.from('team_withdrawal_requests').select('request_id, team_id, event_id, student_id, status, created_at').in('team_id', teamIds).order('created_at', { ascending: false }),
    supabase.from('team_join_requests').select('request_id, team_id, event_id, student_id, status, created_at').in('team_id', teamIds).order('created_at', { ascending: false }),
  ]);
  if (teamResult.error) throw teamResult.error;
  if (memberResult.error) throw memberResult.error;
  if (registrationResult.error) throw registrationResult.error;
  if (withdrawalResult.error) throw withdrawalResult.error;
  if (joinRequestResult.error) throw joinRequestResult.error;

  const personIds = [...new Set([
    ...memberResult.data.map((member) => member.student_id),
    ...withdrawalResult.data.map((withdrawal) => withdrawal.student_id),
    ...joinRequestResult.data.map((joinRequest) => joinRequest.student_id),
  ])];
  const eventIds = [...new Set([
    ...registrationResult.data.map((registration) => registration.event_id),
    ...withdrawalResult.data.map((withdrawal) => withdrawal.event_id),
    ...joinRequestResult.data.map((joinRequest) => joinRequest.event_id),
  ])];
  const [peopleResult, eventResult] = await Promise.all([
    personIds.length
      ? supabase.from('users').select('user_id, name, email').in('user_id', personIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? supabase.from('events').select('event_id, event_name, event_date, start_time, venue').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (peopleResult.error) throw peopleResult.error;
  if (eventResult.error) throw eventResult.error;

  const teamsById = new Map(teamResult.data.map((team) => [team.team_id, team]));
  const peopleById = new Map(peopleResult.data.map((person) => [person.user_id, person]));
  const eventsById = new Map(eventResult.data.map((event) => [event.event_id, event]));
  const membersByTeam = new Map();
  for (const membership of memberResult.data) {
    const person = peopleById.get(membership.student_id);
    if (!person) continue;
    const key = `${membership.event_id}:${membership.team_id}`;
    const members = membersByTeam.get(key) ?? [];
    members.push({
      id: Number(person.user_id),
      name: person.name,
      email: person.email,
      isLeader: membership.student_id === teamsById.get(membership.team_id)?.leader_id,
    });
    membersByTeam.set(key, members);
  }

  const withdrawalsByTeamEvent = new Map();
  for (const withdrawal of withdrawalResult.data) {
    const person = peopleById.get(withdrawal.student_id);
    const event = eventsById.get(withdrawal.event_id);
    if (!person || !event) continue;
    const key = `${withdrawal.event_id}:${withdrawal.team_id}`;
    const requests = withdrawalsByTeamEvent.get(key) ?? [];
    requests.push({
      id: Number(withdrawal.request_id),
      eventId: Number(withdrawal.event_id),
      eventName: event.event_name,
      studentId: Number(withdrawal.student_id),
      studentName: person.name,
      studentEmail: person.email,
      status: withdrawal.status,
      createdAt: withdrawal.created_at,
    });
    withdrawalsByTeamEvent.set(key, requests);
  }

  const joinsByTeamEvent = new Map();
  for (const joinRequest of joinRequestResult.data) {
    const person = peopleById.get(joinRequest.student_id);
    const event = eventsById.get(joinRequest.event_id);
    if (!person || !event) continue;
    const key = `${joinRequest.event_id}:${joinRequest.team_id}`;
    const requests = joinsByTeamEvent.get(key) ?? [];
    requests.push({
      id: Number(joinRequest.request_id),
      eventId: Number(joinRequest.event_id),
      eventName: event.event_name,
      studentId: Number(joinRequest.student_id),
      studentName: person.name,
      studentEmail: person.email,
      status: joinRequest.status,
      createdAt: joinRequest.created_at,
    });
    joinsByTeamEvent.set(key, requests);
  }

  response.json({
    teams: registrationResult.data.flatMap((registration) => {
      const team = teamsById.get(registration.team_id);
      const event = eventsById.get(registration.event_id);
      if (!team) return [];
      if (!event) return [];
      const key = `${registration.event_id}:${registration.team_id}`;
      const teamMembers = membersByTeam.get(key) ?? [];
      const teamWithdrawals = withdrawalsByTeamEvent.get(key) ?? [];
      const teamJoinRequests = joinsByTeamEvent.get(key) ?? [];
      return [{
        id: Number(team.team_id),
        name: team.team_name,
        createdAt: team.created_at,
        eventId: Number(registration.event_id),
        isMember: teamMembers.some((member) => member.id === studentId),
        members: teamMembers,
        registrations: [{
          registeredAt: registration.registered_at,
          event: {
            id: Number(event.event_id),
            name: event.event_name,
            date: new Date(`${event.event_date}T12:00:00`).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }),
            time: new Date(`1970-01-01T${event.start_time}`).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
            }),
            venue: event.venue,
          },
        }],
        withdrawalRequests: Number(team.leader_id) === studentId
          ? teamWithdrawals.filter((withdrawal) => withdrawal.status === 'pending')
          : [],
        myWithdrawalRequests: teamWithdrawals
          .filter((withdrawal) => withdrawal.studentId === studentId)
          .map(({ eventId, status, createdAt }) => ({ eventId, status, createdAt })),
        joinRequests: Number(team.leader_id) === studentId
          ? teamJoinRequests.filter((joinRequest) => joinRequest.status === 'pending')
          : [],
        myJoinRequests: teamJoinRequests
          .filter((joinRequest) => joinRequest.studentId === studentId)
          .filter((joinRequest, index, requests) => requests.findIndex((item) => item.eventId === joinRequest.eventId) === index)
          .map(({ eventId, status, createdAt }) => ({ eventId, status, createdAt })),
      }];
    }),
  });
}));

app.post('/api/teams/withdrawal-requests/:requestId/review', requireRole('student'), asyncHandler(async (request, response) => {
  const requestId = requirePositiveInteger(request.params.requestId, 'Withdrawal request ID');
  if (typeof request.body?.approve !== 'boolean') {
    throw new HttpError(400, 'Choose whether to approve or reject the withdrawal request.');
  }
  const { error } = await supabase.rpc('review_team_withdrawal', {
    p_request_id: requestId,
    p_leader_id: request.profile.user_id,
    p_approve: request.body.approve,
  });
  if (error) throw getDatabaseError(error);
  response.json({ success: true, status: request.body.approve ? 'approved' : 'rejected' });
}));

app.post('/api/teams/join-requests/:requestId/review', requireRole('student'), asyncHandler(async (request, response) => {
  const requestId = requirePositiveInteger(request.params.requestId, 'Join request ID');
  if (typeof request.body?.approve !== 'boolean') {
    throw new HttpError(400, 'Choose whether to approve or reject the join request.');
  }
  const { error } = await supabase.rpc('review_team_join', {
    p_request_id: requestId,
    p_leader_id: request.profile.user_id,
    p_approve: request.body.approve,
  });
  if (error) throw getDatabaseError(error);
  response.json({ success: true, status: request.body.approve ? 'approved' : 'rejected' });
}));

app.get('/api/events/:eventId/registrations', requireRole('admin'), asyncHandler(async (request, response) => {
  const eventId = requirePositiveInteger(request.params.eventId, 'Event ID');
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('*')
    .eq('event_id', eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw new HttpError(404, 'Event not found.');

  const { data: registrations, error: registrationError } = await supabase
    .from('registrations')
    .select('registration_id, registered_at, student_id, team_id')
    .eq('event_id', eventId)
    .order('registered_at', { ascending: true });
  if (registrationError) throw registrationError;

  const studentIds = registrations.filter((item) => item.student_id).map((item) => item.student_id);
  const teamIds = registrations.filter((item) => item.team_id).map((item) => item.team_id);
  const [teamResult, membershipResult] = await Promise.all([
    teamIds.length ? supabase.from('teams').select('team_id, team_name, leader_id').in('team_id', teamIds) : Promise.resolve({ data: [], error: null }),
    teamIds.length ? supabase.from('event_team_members').select('team_id, student_id').eq('event_id', eventId).in('team_id', teamIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (teamResult.error) throw teamResult.error;
  if (membershipResult.error) throw membershipResult.error;

  const allMemberIds = [...new Set([...studentIds, ...membershipResult.data.map((item) => item.student_id)])];
  const { data: people, error: peopleError } = allMemberIds.length
    ? await supabase.from('users').select('user_id, name, email').in('user_id', allMemberIds)
    : { data: [], error: null };
  if (peopleError) throw peopleError;

  const peopleById = new Map(people.map((person) => [person.user_id, person]));
  const teamsById = new Map(teamResult.data.map((team) => [team.team_id, team]));
  const membersByTeam = new Map();
  for (const membership of membershipResult.data) {
    const list = membersByTeam.get(membership.team_id) ?? [];
    const person = peopleById.get(membership.student_id);
    if (person) list.push({ id: Number(person.user_id), name: person.name, email: person.email, isLeader: membership.student_id === teamsById.get(membership.team_id)?.leader_id });
    membersByTeam.set(membership.team_id, list);
  }

  const roster = registrations.flatMap((registration) => {
    if (registration.student_id) {
      const student = peopleById.get(registration.student_id);
      return student ? [{
        registrationId: Number(registration.registration_id),
        registeredAt: registration.registered_at,
        id: Number(student.user_id),
        name: student.name,
        email: student.email,
        teamName: null,
      }] : [];
    }
    const team = teamsById.get(registration.team_id);
    return (membersByTeam.get(registration.team_id) ?? []).map((member) => ({
      registrationId: Number(registration.registration_id),
      registeredAt: registration.registered_at,
      ...member,
      teamName: team?.team_name ?? 'Team',
    }));
  });
  const registeredTeams = registrations.flatMap((registration) => {
    if (!registration.team_id) return [];
    const team = teamsById.get(registration.team_id);
    if (!team) return [];
    const members = membersByTeam.get(registration.team_id) ?? [];
    const leader = members.find((member) => member.isLeader);
    if (!leader) return [];
    return [{
      id: Number(team.team_id),
      registrationId: Number(registration.registration_id),
      name: team.team_name,
      registeredAt: registration.registered_at,
      leader,
      members,
    }];
  });

  const { data: summary, error: summaryError } = await supabase
    .from('event_registration_summary')
    .select('event_id, registration_count, attendee_count')
    .eq('event_id', eventId)
    .single();
  if (summaryError) throw summaryError;

  response.json({
    event: formatEvent(event, summary),
    registrations: event.game_type === 'team'
      ? registeredTeams.map((team) => ({
        registrationId: team.registrationId,
        registeredAt: team.registeredAt,
        id: team.leader.id,
        name: team.leader.name,
        email: team.leader.email,
        teamName: team.name,
        isLeader: true,
      }))
      : roster,
    teams: registeredTeams,
  });
}));

app.use((request, response) => {
  response.status(404).json({ error: 'API route not found.' });
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const handledError = getDatabaseError(error);
  const status = handledError.status ?? 500;
  if (status >= 500) console.error('API request failed:', error);
  response.status(status).json({
    error: status === 500 ? 'An unexpected server error occurred.' : handledError.message,
  });
});

export default app;
