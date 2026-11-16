import assert from 'node:assert/strict';
import test from 'node:test';
import { getScheduleConflicts } from './schedule.js';

test('marks registered events with the same date and start time as conflicts', () => {
  const conflicts = getScheduleConflicts([
    { id: 1, name: 'Chess', eventDate: '2026-11-17', startTime: '15:00:00' },
    { id: 2, name: 'Debate', eventDate: '2026-11-17', startTime: '15:00:00' },
    { id: 3, name: 'Workshop', eventDate: '2026-11-17', startTime: '16:00:00' },
    { id: 4, name: 'Other day', eventDate: '2026-11-18', startTime: '15:00:00' },
  ]);

  assert.deepEqual(conflicts.get(1), ['Debate']);
  assert.deepEqual(conflicts.get(2), ['Chess']);
  assert.equal(conflicts.has(3), false);
  assert.equal(conflicts.has(4), false);
});

test('handles multiple simultaneous events and ignores missing schedules', () => {
  const conflicts = getScheduleConflicts([
    { id: 1, name: 'Chess', eventDate: '2026-11-17', startTime: '15:00' },
    { id: 2, name: 'Debate', eventDate: '2026-11-17', startTime: '15:00:30' },
    { id: 3, name: 'Robotics', eventDate: '2026-11-17', startTime: '15:00:00' },
    { id: 4, name: 'Unscheduled' },
  ]);

  assert.deepEqual(conflicts.get(1), ['Debate', 'Robotics']);
  assert.deepEqual(conflicts.get(2), ['Chess', 'Robotics']);
  assert.deepEqual(conflicts.get(3), ['Chess', 'Debate']);
  assert.equal(conflicts.has(4), false);
});
