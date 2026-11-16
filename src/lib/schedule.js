export function getScheduleConflicts(events) {
  const eventsByStart = new Map();
  for (const event of events) {
    if (!event.eventDate || !event.startTime) continue;
    const startKey = `${event.eventDate}T${event.startTime.slice(0, 5)}`;
    const group = eventsByStart.get(startKey) ?? [];
    group.push(event);
    eventsByStart.set(startKey, group);
  }

  const conflicts = new Map();
  for (const group of eventsByStart.values()) {
    if (group.length < 2) continue;
    for (const event of group) {
      conflicts.set(event.id, group.filter((other) => other.id !== event.id).map((other) => other.name));
    }
  }
  return conflicts;
}
