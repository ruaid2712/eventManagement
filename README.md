# Fieldhouse

Fieldhouse is a campus event-management app with a React/Vite frontend, an Express API, Supabase Auth, and a Supabase PostgreSQL database.

## Features

- **Students** can browse campus events, register for individual events, create teams for team events, and request to join an existing event team.
- **Team leaders** can approve or reject requests to join or leave their team. Team membership is specific to an event, so joining a team for one event does not change the team's membership in another event.
- **Withdrawal rules:** individual registrations are removed immediately. A member leaving a team needs leader approval. A team leader can withdraw directly if they are the only member; otherwise, they must transfer leadership first.
- **Student pages** include All events, My registrations, My teams, and Notifications. Notifications include upcoming event reminders and team join/withdrawal request updates. Team updates refresh when the app regains focus and periodically while it remains open.
- **Schedule conflicts** are highlighted for registered events occurring on the same date and starting at the same time.
- **Admins** can create events, review registrations, see team leaders and capacity by registered teams, and open full team rosters.

## Backend setup

1. Create a Supabase project.
2. In the Supabase SQL Editor, apply the migrations in timestamp order:
   1. [`backend/supabase/migrations/20261116000000_initial_schema.sql`](./backend/supabase/migrations/20261116000000_initial_schema.sql) — creates the initial schema and API functions.
   2. [`backend/supabase/migrations/20261116010000_team_capacity_by_team.sql`](./backend/supabase/migrations/20261116010000_team_capacity_by_team.sql) — counts team-event capacity by registered teams, rather than team members.
   3. [`backend/supabase/migrations/20261116020000_withdraw_event_registration.sql`](./backend/supabase/migrations/20261116020000_withdraw_event_registration.sql) — enables individual withdrawal and team-leader-reviewed withdrawal requests.
   4. [`backend/supabase/migrations/20261116030000_single_member_team_withdrawal.sql`](./backend/supabase/migrations/20261116030000_single_member_team_withdrawal.sql) — lets a team leader who is the only member withdraw directly.
   5. [`backend/supabase/migrations/20261116040000_event_scoped_team_membership_and_join.sql`](./backend/supabase/migrations/20261116040000_event_scoped_team_membership_and_join.sql) — adds event-specific memberships and leader-approved join requests, and migrates existing team memberships.
3. Copy `.env.example` to `.env` and set:
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the Express API.
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for browser sign-in. Never use the service-role key in a `VITE_` variable.
   - `DATABASE_URL` only if you use tooling that connects directly to PostgreSQL. The Express API uses the Supabase API and does not read this variable.
4. Configure Supabase Auth email confirmation and allowed redirect URLs for the frontend’s origin.
5. Install dependencies with `npm install`.
6. Start the API and frontend in separate terminals:

   ```sh
   npm run dev:server
   npm run dev
   ```

The Vite development server proxies `/api` requests to `http://localhost:3001`. For a production deployment, set `VITE_API_URL` and `CLIENT_ORIGIN` to the deployed frontend/API origins.

## API

- `GET /api/health` — health check
- `GET /api/events` — public event list, including registration counts
- `GET /api/auth/me` — current account profile
- `POST /api/auth/claim-admin` — promote the authenticated account to admin
- `POST /api/events` — create an event (admin only)
- `POST /api/events/:eventId/register` — register a student or team
- `GET /api/events/:eventId/teams` — list teams registered for a team event that a student may request to join
- `POST /api/events/:eventId/team-join-requests` — request to join an event team; the leader must approve
- `POST /api/teams/join-requests/:requestId/review` — approve or reject a team join request (team leader only)
- `DELETE /api/events/:eventId/registration` — immediately withdraw a student from an individual event or request leader approval to leave a team event
- `POST /api/teams/withdrawal-requests/:requestId/review` — approve or reject a team withdrawal request (team leader only)
- `GET /api/teams/mine` — list the student's event-specific team memberships, pending leader actions, and join/withdrawal request statuses
- `GET /api/events/:eventId/registrations` — list event registrants (admin only)

The API validates Supabase access tokens and enforces roles on the server. Direct browser access to private profile, team, and registration rows is blocked by row-level security. Team creation, joining, join approval, and withdrawal are transactionally handled by PostgreSQL functions. Team capacity is measured in teams, while attendee counts use event-specific team membership.

## Notes

- User passwords and sessions are managed by Supabase Auth; the application profile table links to `auth.users` and does not store password hashes.
- Event records include date, start time, venue, capacity, and category in addition to the supplied game type.
- Admin registration is open: anyone can select the admin role and gain admin access. Restrict admin provisioning before deploying publicly.
- Run `npm run build`, `npm run lint`, and `npm test` to validate the project.
