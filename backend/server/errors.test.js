import assert from 'node:assert/strict';
import test from 'node:test';
import { getDatabaseError, HttpError, requireEventPayload, requirePositiveInteger, requireRegistrationPayload, toEventDto } from './errors.js';

test('validates and maps event payloads to database fields', () => {
  const event = requireEventPayload({
    name: 'Campus Cup',
    description: 'Final match',
    category: 'Tournament',
    gameType: 'team',
    date: '2026-12-05',
    time: '15:30',
    venue: 'Northfield Stadium',
    capacity: '48',
  });

  assert.deepEqual(event, {
    event_name: 'Campus Cup',
    description: 'Final match',
    category: 'Tournament',
    game_type: 'team',
    event_date: '2026-12-05',
    start_time: '15:30:00',
    venue: 'Northfield Stadium',
    capacity: 48,
  });
});

test('rejects invalid event date, game type, and capacity', () => {
  assert.throws(() => requireEventPayload({
    name: 'Invalid date',
    gameType: 'single',
    date: '2026-02-31',
    time: '12:00',
    venue: 'Campus',
    capacity: 20,
  }), HttpError);
  assert.throws(() => requireEventPayload({
    name: 'Invalid game',
    gameType: 'duel',
    date: '2026-12-05',
    time: '12:00',
    venue: 'Campus',
    capacity: 20,
  }), HttpError);
  assert.throws(() => requireEventPayload({
    name: 'Invalid time',
    gameType: 'single',
    date: '2026-12-05',
    time: '12:00:60',
    venue: 'Campus',
    capacity: 20,
  }), HttpError);
  assert.throws(() => requirePositiveInteger(0, 'Capacity'), HttpError);
});

test('preserves useful database messages for team request errors', () => {
  assert.equal(getDatabaseError({
    code: '23505',
    message: 'You already have a pending request to join another team for this event',
  }).message, 'You already have a pending request to join another team for this event');
  assert.equal(getDatabaseError({
    code: 'P0002',
    message: 'Pending team join request not found',
  }).message, 'Pending team join request not found');
  assert.equal(getDatabaseError({
    code: '23505',
    message: 'duplicate key value violates unique constraint "team_name_key"',
  }).message, 'This record already exists.');
});

test('normalizes and validates team registration input', () => {
  assert.deepEqual(requireRegistrationPayload({
    teamName: '  Blue Jays  ',
    memberEmails: [' one@example.edu ', 'two@example.edu', 'one@example.edu'],
  }, 'team'), {
    type: 'team',
    teamName: 'Blue Jays',
    memberEmails: ['one@example.edu', 'two@example.edu'],
  });
  assert.throws(() => requireRegistrationPayload({
    teamName: 'Blue Jays',
    memberEmails: ['not-an-email'],
  }, 'team'), HttpError);
  assert.deepEqual(requireRegistrationPayload({}, 'single'), { type: 'single' });
});

test('maps database event records and registration counts for the UI', () => {
  const event = toEventDto({
    event_id: 17,
    event_name: 'Campus Cup',
    description: null,
    category: 'Tournament',
    game_type: 'team',
    event_date: '2026-12-05',
    start_time: '15:30:00',
    venue: 'Northfield Stadium',
    capacity: 48,
  }, { registration_count: 3, attendee_count: 21 }, true);

  assert.equal(event.id, 17);
  assert.equal(event.startTime, '15:30:00');
  assert.equal(event.date, 'Dec 5, 2026');
  assert.equal(event.time, '3:30 PM');
  assert.equal(event.registrationCount, 3);
  assert.equal(event.attendeeCount, 21);
  assert.equal(event.isRegistered, true);
});
