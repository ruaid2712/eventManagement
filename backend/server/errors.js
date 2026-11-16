export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function getDatabaseError(error) {
  if (error.code === '23505') {
    const message = error.message.startsWith('duplicate key value violates unique constraint')
      ? 'This record already exists.'
      : error.message;
    return new HttpError(409, message);
  }
  if (error.code === '23503') return new HttpError(400, 'A referenced record does not exist.');
  if (error.code === '23514' || error.code === '22023') return new HttpError(400, error.message);
  if (error.code === 'P0002') return new HttpError(404, error.message);
  if (error.code === '42501') return new HttpError(403, 'You do not have permission to perform this action.');
  return error;
}

export function requireString(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

export function requirePositiveInteger(value, label) {
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    throw new HttpError(400, `${label} must be a positive whole number.`);
  }
  return parsedValue;
}

export function requireEventPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'An event object is required.');
  }

  const eventDate = requireString(body.date, 'Event date', 10);
  const startTime = requireString(body.time, 'Event start time', 8);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !/^\d{2}:\d{2}(:\d{2})?$/.test(startTime)) {
    throw new HttpError(400, 'Provide a valid event date and start time.');
  }
  const parsedDate = new Date(`${eventDate}T00:00:00.000Z`);
  const [hours, minutes, seconds = 0] = startTime.split(':').map(Number);
  if (
    Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== eventDate
    || hours > 23
    || minutes > 59
    || seconds > 59
  ) {
    throw new HttpError(400, 'Provide a valid event date and start time.');
  }

  const gameType = body.gameType;
  if (gameType !== 'single' && gameType !== 'team') {
    throw new HttpError(400, 'Game type must be single or team.');
  }

  return {
    event_name: requireString(body.name, 'Event name', 150),
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 5000) : null,
    category: requireString(body.category ?? 'Community', 'Event category', 80),
    game_type: gameType,
    event_date: eventDate,
    start_time: startTime.length === 5 ? `${startTime}:00` : startTime,
    venue: requireString(body.venue, 'Event venue', 200),
    capacity: requirePositiveInteger(body.capacity, 'Event capacity'),
  };
}

export function requireRegistrationPayload(body, gameType) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'A registration object is required.');
  }
  if (gameType === 'single') return { type: 'single' };

  const teamName = requireString(body.teamName, 'Team name', 100);
  if (!Array.isArray(body.memberEmails) || body.memberEmails.length > 50) {
    throw new HttpError(400, 'Provide up to 50 team member email addresses.');
  }
  const memberEmails = [...new Set(body.memberEmails.map((email) => {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new HttpError(400, 'Every team member must have a valid email address.');
    }
    return email.trim().toLowerCase();
  }))];

  return { type: 'team', teamName, memberEmails };
}

export function toEventDto(row, summary = {}, registered = false) {
  return {
    id: Number(row.event_id),
    name: row.event_name,
    description: row.description ?? '',
    category: row.category,
    gameType: row.game_type,
    eventDate: row.event_date,
    startTime: row.start_time,
    date: new Date(`${row.event_date}T12:00:00`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    time: new Date(`1970-01-01T${row.start_time}`).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }),
    venue: row.venue,
    capacity: row.capacity,
    registrationCount: summary.registration_count ?? 0,
    attendeeCount: summary.attendee_count ?? 0,
    isRegistered: registered,
    theme: row.category?.toLowerCase() === 'basketball' ? 'basketball' : row.game_type === 'team' ? 'run' : 'soccer',
    registrations: [],
  };
}
