import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  EyeOff,
  MapPin,
  Plus,
  Search,
  Ticket,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, getProfile, supabase } from './lib/api.js';
import { getScheduleConflicts } from './lib/schedule.js';
import './App.css';

const filters = ['All events', 'Tournaments', 'Community'];

async function getProfileWithRetry(accessToken) {
  let latestError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getProfile(accessToken);
    } catch (error) {
      latestError = error;
      if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  throw latestError;
}

function getRegisteredCount(event) {
  return event.gameType === 'team'
    ? event.registrationCount ?? 0
    : event.attendeeCount ?? event.registrations?.length ?? 0;
}

function getRegistrationUnit(event) {
  return event.gameType === 'team' ? 'team' : 'student';
}

function getEventStatus(event) {
  const registeredCount = getRegisteredCount(event);
  const remainingSpots = event.capacity - registeredCount;
  if (remainingSpots <= 0) return 'Event full';
  if (registeredCount > 0 && remainingSpots / event.capacity <= 0.2) return 'Almost full';
  return 'Registration open';
}

function App() {
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [apiError, setApiError] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [authRole, setAuthRole] = useState('student');
  const [authError, setAuthError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [view, setView] = useState('events');
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [registrations, setRegistrations] = useState([]);
  const [registeredTeams, setRegisteredTeams] = useState([]);
  const [registrationsLoading, setRegistrationsLoading] = useState(false);
  const [registrationError, setRegistrationError] = useState('');
  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState('');
  const [teamsRefresh, setTeamsRefresh] = useState(0);
  const [teamRegistrationChoice, setTeamRegistrationChoice] = useState('create');
  const [availableTeams, setAvailableTeams] = useState([]);
  const [availableTeamsLoading, setAvailableTeamsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All events');
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const role = user?.role;
  const isAdmin = role === 'admin';

  const myEvents = useMemo(() => events.filter((event) => event.isRegistered), [events]);
  const scheduleConflicts = useMemo(() => getScheduleConflicts(myEvents), [myEvents]);
  const registeredEventIds = useMemo(() => new Set(myEvents.map((event) => event.id)), [myEvents]);
  const myWithdrawalStatuses = useMemo(() => {
    const statuses = new Map();
    for (const team of teams) {
      for (const withdrawal of team.myWithdrawalRequests ?? []) {
        if (!statuses.has(withdrawal.eventId)) statuses.set(withdrawal.eventId, withdrawal.status);
      }
    }
    return statuses;
  }, [teams]);
  const withdrawalNotifications = useMemo(() => teams.flatMap((team) => [
    ...(team.withdrawalRequests ?? []).map((withdrawal) => ({
      id: `incoming-${withdrawal.id}`,
      kind: 'incoming',
      teamId: team.id,
      teamName: team.name,
      eventId: withdrawal.eventId,
      eventName: withdrawal.eventName,
      studentName: withdrawal.studentName,
      status: withdrawal.status,
    })),
    ...(team.myWithdrawalRequests ?? []).map((withdrawal) => {
      const registration = team.registrations.find((item) => item.event.id === withdrawal.eventId);
      return {
        id: `mine-${team.id}-${withdrawal.eventId}`,
        kind: 'mine',
        teamId: team.id,
        teamName: team.name,
        eventId: withdrawal.eventId,
        eventName: registration?.event.name ?? 'team event',
        status: withdrawal.status,
      };
    }),
  ]), [teams]);
  const joinNotifications = useMemo(() => teams.flatMap((team) => [
    ...(team.joinRequests ?? []).map((joinRequest) => ({
      id: `join-incoming-${joinRequest.id}`,
      kind: 'join-incoming',
      teamId: team.id,
      teamName: team.name,
      eventId: joinRequest.eventId,
      eventName: joinRequest.eventName,
      studentName: joinRequest.studentName,
    })),
    ...(team.myJoinRequests ?? []).map((joinRequest) => ({
      id: `join-mine-${team.id}-${joinRequest.eventId}`,
      kind: 'join-mine',
      teamId: team.id,
      teamName: team.name,
      eventId: joinRequest.eventId,
      eventName: joinRequest.eventName,
      status: joinRequest.status,
    })),
  ]), [teams]);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const notificationEvents = myEvents.filter((event) => new Date(`${event.eventDate}T12:00:00`) >= new Date());
  const notificationCount = notificationEvents.length + withdrawalNotifications.length + joinNotifications.length;

  useEffect(() => {
    if (!supabase) {
      setApiError('Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to sign in.');
      setAuthReady(true);
      return undefined;
    }

    let active = true;
    const loadSessionProfile = async (session) => {
      if (!session) {
        setUser(null);
        setAuthReady(true);
        return;
      }

      setAuthReady(false);
      try {
        const profile = await getProfile(session.access_token);
        if (active) {
          setUser(profile);
          setView(profile.role === 'admin' ? 'overview' : 'events');
          setApiError('');
        }
      } catch (error) {
        if (active) {
          setUser(null);
          setApiError(error.message);
        }
      } finally {
        if (active) setAuthReady(true);
      }
    };

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        return loadSessionProfile(data.session);
      })
      .catch((error) => {
        if (active) {
          setApiError(`Could not restore your session: ${error.message}`);
          setAuthReady(true);
        }
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        if (active) void loadSessionProfile(session);
      }, 0);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return undefined;
    let active = true;
    setEventsLoading(true);
    apiRequest('/events')
      .then(({ events: loadedEvents }) => {
        if (active) {
          setEvents(loadedEvents);
          setSelectedEventId((current) => current ?? loadedEvents[0]?.id ?? null);
          setApiError('');
        }
      })
      .catch((error) => {
        if (active) setApiError(error.message);
      })
      .finally(() => {
        if (active) setEventsLoading(false);
      });
    return () => { active = false; };
  }, [authReady, user]);

  useEffect(() => {
    if (!isAdmin || view !== 'registrations' || !selectedEvent) return undefined;
    let active = true;
    setRegistrationsLoading(true);
    setRegistrationError('');
    apiRequest(`/events/${selectedEvent.id}/registrations`)
      .then(({ registrations: eventRegistrations, teams: eventTeams }) => {
        if (active) {
          setRegistrations(eventRegistrations);
          setRegisteredTeams(eventTeams ?? []);
        }
      })
      .catch((error) => {
        if (active) {
          setRegistrations([]);
          setRegisteredTeams([]);
          setRegistrationError(error.message);
        }
      })
      .finally(() => {
        if (active) setRegistrationsLoading(false);
      });
    return () => { active = false; };
  }, [isAdmin, selectedEvent, view]);

  useEffect(() => {
    if (isAdmin || !user) {
      setTeams([]);
      setTeamsLoading(false);
      setTeamsError('');
      return undefined;
    }
    let active = true;
    let loadingInitialTeams = true;
    const refreshTeams = async () => {
      try {
        const { teams: studentTeams } = await apiRequest('/teams/mine');
        if (active) {
          setTeams(studentTeams);
          setTeamsError('');
        }
      } catch (error) {
        if (active) setTeamsError(error.message);
      } finally {
        if (active && loadingInitialTeams) {
          loadingInitialTeams = false;
          setTeamsLoading(false);
        }
      }
    };
    setTeamsLoading(true);
    setTeamsError('');
    void refreshTeams();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshTeams();
    };
    const refreshInterval = window.setInterval(refreshWhenVisible, 15000);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [isAdmin, user, teamsRefresh]);

  const visibleEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      const matchesSearch = !query || `${event.name} ${event.category} ${event.venue}`.toLowerCase().includes(query);
      const matchesFilter =
        filter === 'All events' ||
        (filter === 'Tournaments' && event.category === 'Tournament') ||
        (filter === 'Community' && event.category === 'Community');
      const matchesView = view !== 'my-events' || registeredEventIds.has(event.id);
      return matchesSearch && matchesFilter && matchesView;
    });
  }, [events, filter, registeredEventIds, search, view]);

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3500);
  }

  function openAuth(mode = 'login', requestedRole = 'student') {
    setAuthMode(mode);
    setAuthRole(requestedRole);
    setAuthError('');
    setShowPassword(false);
    setAuthOpen(true);
  }

  async function submitAuth(formEvent) {
    formEvent.preventDefault();
    setAuthError('');
    if (!supabase) {
      setAuthError('Supabase is not configured. Add the public Supabase URL and anon key to your environment.');
      return;
    }
    const formData = new FormData(formEvent.currentTarget);
    const email = formData.get('email')?.toString().trim().toLowerCase();
    const password = formData.get('password')?.toString();
    const name = formData.get('name')?.toString().trim();
    if (!email || !password || (authMode === 'register' && !name)) {
      setAuthError('Complete all required fields to continue.');
      return;
    }

    setAuthSubmitting(true);
    try {
      let accessToken;
      if (authMode === 'register') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMode('login');
          setAuthError('Check your email to confirm the account, then log in.');
          return;
        }
        accessToken = data.session.access_token;
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        accessToken = data.session.access_token;
      }

      let account = await getProfileWithRetry(accessToken);
      if (authRole === 'admin' && account.role !== 'admin') {
        try {
          const result = await apiRequest('/auth/claim-admin', {
            method: 'POST',
            accessToken,
          });
          account = result.user;
        } catch (error) {
          const { error: signOutError } = await supabase.auth.signOut();
          setUser(null);
          if (signOutError) throw signOutError;
          throw error;
        }
      }
      if (account.role !== authRole) {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        setUser(null);
        throw new Error(`This email is registered as a ${account.role} account.`);
      }
      setUser(account);
      setView(account.role === 'admin' ? 'overview' : 'events');
      setAuthOpen(false);
      setAuthError('');
      setApiError('');
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function signOut() {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) {
        showNotice(`Could not sign out: ${error.message}`);
        return;
      }
    }
    setUser(null);
    setAuthMode('login');
    setAuthRole('student');
    setAuthError('');
    setView('events');
    setShowNotifications(false);
  }

  async function registerForEvent(event, teamRegistration) {
    if (!user || isAdmin) return;
    try {
      await apiRequest(`/events/${event.id}/register`, {
        method: 'POST',
        body: teamRegistration ?? {},
      });
      if (teamRegistration) setTeamsRefresh((current) => current + 1);
      const { events: updatedEvents } = await apiRequest('/events');
      setEvents(updatedEvents);
      setDialog(null);
      showNotice('You’re registered. We’ll remind you before the event.');
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function withdrawFromEvent(event) {
    if (!user || isAdmin) return;
    try {
      const result = await apiRequest(`/events/${event.id}/registration`, { method: 'DELETE' });
      setTeamsRefresh((current) => current + 1);
      if (result.status === 'pending') {
        setDialog(null);
        showNotice('Withdrawal request sent to your team leader for approval.');
        return;
      }
      const { events: updatedEvents } = await apiRequest('/events');
      setEvents(updatedEvents);
      setDialog(null);
      showNotice('You withdrew from this event.');
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function reviewWithdrawalRequest(requestId, approve) {
    try {
      await apiRequest(`/teams/withdrawal-requests/${requestId}/review`, {
        method: 'POST',
        body: { approve },
      });
      setTeamsRefresh((current) => current + 1);
      const { events: updatedEvents } = await apiRequest('/events');
      setEvents(updatedEvents);
      showNotice(approve ? 'Withdrawal approved.' : 'Withdrawal request rejected.');
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function reviewJoinRequest(requestId, approve) {
    try {
      await apiRequest(`/teams/join-requests/${requestId}/review`, {
        method: 'POST',
        body: { approve },
      });
      setTeamsRefresh((current) => current + 1);
      showNotice(approve ? 'Join request approved.' : 'Join request rejected.');
    } catch (error) {
      showNotice(error.message);
    }
  }

  function openTeamRegistration(event) {
    setTeamRegistrationChoice('create');
    setAvailableTeams([]);
    setAvailableTeamsLoading(true);
    setDialog({ mode: 'team-register', event });
    apiRequest(`/events/${event.id}/teams`)
      .then(({ teams: eventTeams }) => setAvailableTeams(eventTeams))
      .catch((error) => showNotice(error.message))
      .finally(() => setAvailableTeamsLoading(false));
  }

  async function requestToJoinTeam(teamId) {
    if (!dialog || dialog.mode !== 'team-register') return;
    try {
      await apiRequest(`/events/${dialog.event.id}/team-join-requests`, {
        method: 'POST',
        body: { teamId },
      });
      setTeamsRefresh((current) => current + 1);
      setAvailableTeams((current) => current.map((team) => (
        team.id === teamId ? { ...team, requestStatus: 'pending' } : team
      )));
      showNotice('Join request sent to the team leader for approval.');
    } catch (error) {
      showNotice(error.message);
    }
  }

  function handleRegistrationClick(event) {
    if (!user) {
      openAuth('login', 'student');
      return;
    }
    if (event.gameType === 'team') {
      setDialog({ mode: 'details', event });
      return;
    }
    setDialog({ mode: 'details', event });
  }

  function submitTeamRegistration(formEvent) {
    formEvent.preventDefault();
    const formData = new FormData(formEvent.currentTarget);
    const teamName = formData.get('teamName')?.toString().trim();
    const memberEmails = formData.get('memberEmails')?.toString()
      .split(/[\n,;]+/)
      .map((email) => email.trim())
      .filter(Boolean);
    if (!teamName) return;
    void registerForEvent(dialog.event, { teamName, memberEmails });
  }

  function createEvent(formEvent) {
    formEvent.preventDefault();
    if (!isAdmin) return;
    const formData = new FormData(formEvent.currentTarget);
    const name = formData.get('name')?.toString().trim();
    const dateValue = formData.get('date')?.toString();
    const venue = formData.get('venue')?.toString().trim();
    const capacityValue = Number(formData.get('capacity'));
    const gameType = formData.get('gameType')?.toString();

    if (!name || !dateValue || !venue || !Number.isInteger(capacityValue) || capacityValue < 1 || !gameType) return;
    void apiRequest('/events', {
      method: 'POST',
      body: {
        name,
        description: formData.get('description')?.toString().trim() ?? '',
        category: formData.get('category')?.toString() || 'Community',
        gameType,
        date: dateValue,
        time: formData.get('time')?.toString() || '12:00',
        venue,
        capacity: capacityValue,
      },
    })
      .then(({ event }) => {
        setEvents((currentEvents) => [event, ...currentEvents]);
        setSelectedEventId(event.id);
        setView('events');
        setDialog(null);
        showNotice('Event created. Students can now register.');
      })
      .catch((error) => showNotice(error.message));
  }

  const pageTitle = isAdmin
    ? ({ overview: 'Overview', events: 'Manage events', registrations: 'Event registrations' }[view] ?? 'Overview')
    : ({ events: 'All events', 'my-events': 'My registrations', teams: 'My teams', notifications: 'Notifications' }[view] ?? 'All events');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Fieldhouse home">
          <span className="brand-mark"><Activity size={21} strokeWidth={2.5} /></span>
          <span>fieldhouse<span className="brand-period">.</span></span>
        </a>

        <div className="workspace-switcher">
          <span className="workspace-avatar">N</span>
          <span className="workspace-copy"><strong>Northfield College</strong><small>Campus workspace</small></span>
          <ChevronDown size={16} />
        </div>

        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav" aria-label="Main navigation">
          {isAdmin ? (
            <>
              <button type="button" className={`nav-link ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}><Activity size={18} /> Overview</button>
              <button type="button" className={`nav-link ${view === 'events' ? 'active' : ''}`} onClick={() => setView('events')}><CalendarDays size={18} /> Events <span className="nav-count">{events.length}</span></button>
              <button type="button" className={`nav-link ${view === 'registrations' ? 'active' : ''}`} onClick={() => setView('registrations')}><Users size={18} /> Registrations</button>
            </>
          ) : user ? (
            <>
              <button type="button" className={`nav-link ${view === 'events' ? 'active' : ''}`} onClick={() => setView('events')}><CalendarDays size={18} /> All events <span className="nav-count">{events.length}</span></button>
              <button type="button" className={`nav-link ${view === 'my-events' ? 'active' : ''}`} onClick={() => setView('my-events')}><Ticket size={18} /> My registrations <span className="nav-count">{myEvents.length}</span></button>
              <button type="button" className={`nav-link ${view === 'teams' ? 'active' : ''}`} onClick={() => setView('teams')}><Users size={18} /> My teams <span className="nav-count">{teams.length}</span></button>
              <button type="button" className={`nav-link ${view === 'notifications' ? 'active' : ''}`} onClick={() => setView('notifications')}><Bell size={18} /> Notifications {notificationCount > 0 && <span className="nav-count">{notificationCount}</span>}</button>
            </>
          ) : (
            <button type="button" className="nav-link active" onClick={() => setView('events')}><CalendarDays size={18} /> Browse events <span className="nav-count">{events.length}</span></button>
          )}

        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">{isAdmin ? <Plus size={16} /> : <Activity size={16} />}</span>
            <strong>{isAdmin ? 'Host your next event' : 'Find your next moment'}</strong>
            <p>{isAdmin ? 'Create a campus event and manage student registrations in one place.' : 'Explore campus events and keep track of the ones you join.'}</p>
            {isAdmin ? (
              <button type="button" onClick={() => setDialog({ mode: 'create' })}>Create an event <ArrowRight size={14} /></button>
            ) : !user ? (
              <button type="button" onClick={() => openAuth('register')}>Join Fieldhouse <ArrowRight size={14} /></button>
            ) : null}
          </div>
          {user ? (
            <div className="profile-row">
              <span className="profile-avatar">{user.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span>
              <span className="profile-copy"><strong>{user.name}</strong><small>{isAdmin ? 'Administrator' : 'Student'}</small></span>
              <button type="button" className="sign-out-button" onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <div className="sidebar-auth-note">Sign in to register and get event reminders.</div>
          )}
        </div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span><strong>fieldhouse<span className="brand-period">.</span></strong></div>
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            {(view === 'events' || view === 'my-events') && (
              <label className="search-box">
                <Search size={17} />
                <input type="search" placeholder="Search events..." value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search events" />
                <kbd>/</kbd>
              </label>
            )}
            {!isAdmin && user && (
              <div className="notification-wrap">
                <button type="button" className="icon-button notification-button" aria-label="Notifications" aria-expanded={showNotifications} onClick={() => setShowNotifications((shown) => !shown)}>
                  <Bell size={18} />
                  {notificationCount > 0 && <span className="notification-dot" />}
                </button>
                {showNotifications && (
                  <div className="notification-popover">
                    <strong>Notifications</strong>
                    {withdrawalNotifications.slice(0, 3).map((notification) => (
                      <div className="notification-item" key={notification.id}>
                        <span className="notification-icon"><Users size={15} /></span>
                        <span>
                          <b>{notification.kind === 'incoming'
                            ? `${notification.studentName} wants to leave ${notification.teamName}`
                            : `Withdrawal ${notification.status}: ${notification.eventName}`}</b>
                          <small>{notification.kind === 'incoming' ? notification.eventName : notification.status === 'pending' ? 'Waiting for team leader approval' : `Team: ${notification.teamName}`}</small>
                        </span>
                      </div>
                    ))}
                    {joinNotifications.slice(0, 3).map((notification) => (
                      <div className="notification-item" key={notification.id}>
                        <span className="notification-icon"><Users size={15} /></span>
                        <span>
                          <b>{notification.kind === 'join-incoming'
                            ? `${notification.studentName} wants to join ${notification.teamName}`
                            : `Join request ${notification.status}: ${notification.teamName}`}</b>
                          <small>{notification.kind === 'join-incoming' ? notification.eventName : notification.status === 'pending' ? 'Waiting for team leader approval' : notification.eventName}</small>
                        </span>
                      </div>
                    ))}
                    {notificationEvents.length ? notificationEvents.map((event) => (
                      <div className="notification-item" key={event.id}>
                        <span className="notification-icon"><CalendarDays size={15} /></span>
                        <span><b>{event.name}</b><small>{event.date} · {event.time}</small>{scheduleConflicts.has(event.id) && <small className="notification-conflict">Overlaps with {scheduleConflicts.get(event.id).join(', ')}</small>}</span>
                      </div>
                    )) : null}
                    {!notificationCount && <p>You’ll see event reminders and team updates here.</p>}
                    <button type="button" onClick={() => { setView('notifications'); setShowNotifications(false); }}>View notifications <ArrowRight size={13} /></button>
                  </div>
                )}
              </div>
            )}
            {user ? (
              <button type="button" className="topbar-avatar" title="Sign out" aria-label={`Sign out ${user.name}`} onClick={signOut}>
                {user.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
              </button>
            ) : (
              <div className="auth-header-actions">
                  <button type="button" className="header-login" onClick={() => openAuth('login')}>Log in</button>
                  <button type="button" className="button button-primary header-signup" onClick={() => openAuth('register')}>Sign up</button>
              </div>
            )}
          </div>
        </header>

        <div className="dashboard">
          {apiError && <div className="api-error-banner" role="alert">{apiError}</div>}
          <section className="welcome-row">
            <div>
              <p className="eyebrow"><span className="live-dot" /> {isAdmin ? 'EVENT MANAGEMENT' : 'YOUR CAMPUS, IN MOTION'}</p>
              <h1>{isAdmin ? `Welcome, ${user.name}` : user ? `Welcome, ${user.name}` : 'Find your next campus moment'} <span className="wave">✦</span></h1>
              <p className="welcome-subtitle">
                {isAdmin ? 'Create campus events and keep an eye on student registrations.' : user ? 'Discover events, manage your registrations, and see what’s coming up.' : 'Explore campus events. Sign up to register and get reminders for the ones you join.'}
              </p>
            </div>
            {isAdmin && <button type="button" className="button button-primary create-button" onClick={() => setDialog({ mode: 'create' })}><Plus size={18} /> Create event</button>}
          </section>

          {isAdmin && view === 'overview' && (
            <>
              <section className="stats-grid role-stats" aria-label="Event overview">
                <StatCard icon={<CalendarDays size={18} />} label="Events created" value={events.length} tone="mint" />
                <StatCard icon={<Users size={18} />} label="Student / team registrations" value={events.reduce((sum, event) => sum + getRegisteredCount(event), 0)} tone="lilac" />
                <StatCard icon={<Ticket size={18} />} label="Events with registrations" value={events.filter((event) => event.registrationCount > 0).length} tone="peach" />
              </section>
              <section className="events-section">
                <SectionHeading title="Your events" subtitle="Select an event to see its student or team registrations." count={events.length} />
                <EventGrid events={events.slice(0, 3)} role="admin" registeredEventIds={registeredEventIds} onRegister={registerForEvent} onDetails={(event) => { setSelectedEventId(event.id); setView('registrations'); }} />
                {events.length > 3 && <button type="button" className="text-button role-view-all" onClick={() => setView('events')}>Manage all events <ArrowRight size={15} /></button>}
              </section>
            </>
          )}

          {isAdmin && view === 'events' && (
            <section className="events-section role-page-section">
              <SectionHeading title="Manage events" subtitle="Create events and review their registration status." count={visibleEvents.length} />
              <div className="role-toolbar">
                <FilterTabs filter={filter} onChange={setFilter} />
                <button type="button" className="button button-primary" onClick={() => setDialog({ mode: 'create' })}><Plus size={16} /> Create event</button>
              </div>
              {eventsLoading ? <p className="loading-message">Loading events…</p> : <EventGrid events={visibleEvents} role="admin" registeredEventIds={registeredEventIds} onRegister={registerForEvent} onDetails={(event) => { setSelectedEventId(event.id); setView('registrations'); }} onClear={() => { setFilter('All events'); setSearch(''); }} />}
            </section>
          )}

          {isAdmin && view === 'registrations' && (
            <section className="registrations-section">
              <div className="section-heading">
                <div><div className="heading-title"><h2>Event registrations</h2></div><p>Choose an event to see its registered students or teams.</p></div>
                <select className="event-select" value={selectedEvent?.id ?? ''} onChange={(event) => setSelectedEventId(Number(event.target.value))} aria-label="Choose event">
                  {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
                </select>
              </div>
              {selectedEvent && (
                <div className="registration-panel">
                  <div className="registration-summary">
                    <div className={`registration-event-mark ${selectedEvent.theme}`}><CalendarDays size={20} /></div>
                    <div><h3>{selectedEvent.name}</h3><p><CalendarDays size={14} /> {selectedEvent.date} · {selectedEvent.time} <span>·</span> <MapPin size={14} /> {selectedEvent.venue}</p></div>
                    <span className="registration-capacity">{getRegisteredCount(selectedEvent)} / {selectedEvent.capacity} {selectedEvent.gameType === 'team' ? 'teams' : 'students'} registered</span>
                  </div>
                  <div className="roster-heading"><strong>{selectedEvent.gameType === 'team' ? 'Registered teams' : 'Registered students'}</strong><span>{getRegisteredCount(selectedEvent)} {getRegistrationUnit(selectedEvent)}{getRegisteredCount(selectedEvent) === 1 ? '' : 's'}</span></div>
                  {registrationsLoading ? <p className="loading-message">Loading registrations…</p> : registrationError ? <p className="api-error-message" role="alert">{registrationError}</p> : (selectedEvent.gameType === 'team' ? registeredTeams.length : registrations.length) ? (
                    selectedEvent.gameType === 'team' ? (
                      <div className="roster-list team-registration-list">
                        {registeredTeams.map((team) => (
                          <div className="team-registration-row" key={team.id}>
                            <span className="student-team-icon"><Users size={18} /></span>
                            <span className="roster-person"><strong>{team.name}</strong><small>Leader: {team.leader.name} · {team.leader.email} · {team.members.length} {team.members.length === 1 ? 'member' : 'members'}</small></span>
                            <span className="roster-date">Registered {new Date(team.registeredAt).toLocaleDateString()}</span>
                            <button type="button" className="button button-secondary team-details-button" onClick={() => setDialog({ mode: 'registered-team', team })}>View team</button>
                          </div>
                        ))}
                      </div>
                    ) : (
                    <div className="roster-list">
                      {registrations.map((student) => (
                        <div className="roster-row" key={`${student.registrationId}-${student.id}`}>
                          <span className="roster-avatar">{student.name.split(' ').map((part) => part[0]).join('')}</span>
                          <span className="roster-person"><strong>{student.name}{student.isLeader ? ' · team leader' : ''}</strong><small>{student.teamName ? `${student.teamName} · ${student.email}` : student.email}</small></span>
                          <span className="roster-date">Registered {new Date(student.registeredAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                    )
                  ) : <EmptyState title={selectedEvent.gameType === 'team' ? 'No teams registered yet' : 'No registrations yet'} message={selectedEvent.gameType === 'team' ? 'Teams that register for this event will appear here.' : 'Students who register for this event will appear here.'} />}
                </div>
              )}
            </section>
          )}

          {!isAdmin && (view === 'events' || (user && view === 'my-events')) && (
            <>
              {user && <section className="student-summary">
                <div className="student-summary-icon"><Ticket size={19} /></div>
                <div><strong>{view === 'my-events' ? `${myEvents.length} registered ${myEvents.length === 1 ? 'event' : 'events'}` : `${myEvents.length} upcoming ${myEvents.length === 1 ? 'registration' : 'registrations'}`}</strong><span>{view === 'my-events' ? 'Your event registrations are listed below.' : 'Your reminders will appear in Notifications.'}</span></div>
                {view === 'events' && <button type="button" onClick={() => setView('my-events')}>My registrations <ArrowRight size={14} /></button>}
              </section>}
              <section className="events-section role-page-section">
                <SectionHeading title={!user ? 'Upcoming campus events' : view === 'my-events' ? 'My registrations' : 'All campus events'} subtitle={view === 'my-events' ? 'Events you have signed up for.' : user ? 'Find an event and register to join in.' : 'Explore what’s happening around campus.'} count={visibleEvents.length} />
                {view === 'events' && <div className="role-toolbar"><FilterTabs filter={filter} onChange={setFilter} /></div>}
                  {eventsLoading ? <p className="loading-message">Loading events…</p> : <EventGrid
                  events={visibleEvents}
                  role={role}
                  registeredEventIds={registeredEventIds}
                  scheduleConflicts={scheduleConflicts}
                    onRegister={handleRegistrationClick}
                  onRequestAuth={() => openAuth('login', 'student')}
                  onDetails={(event) => setDialog({ mode: 'details', event })}
                  onClear={() => { setFilter('All events'); setSearch(''); }}
                  />}
              </section>
            </>
          )}

          {!isAdmin && user && view === 'notifications' && (
            <section className="notifications-section">
              <SectionHeading title="Notifications" subtitle="Event reminders and updates about your team join and withdrawal requests." count={notificationCount} />
              {(withdrawalNotifications.length > 0 || joinNotifications.length > 0) && (
                <section className="withdrawal-notifications">
                  <h2>Team request updates</h2>
                  <div className="withdrawal-notification-list">
                    {[...joinNotifications, ...withdrawalNotifications].map((notification) => (
                      <article className="withdrawal-notification" key={notification.id}>
                        <span className="notification-icon"><Users size={16} /></span>
                        <div className="withdrawal-notification-copy">
                          <strong>{notification.kind === 'incoming'
                            ? `${notification.studentName} requested to leave ${notification.teamName}`
                            : notification.kind === 'join-incoming'
                              ? `${notification.studentName} wants to join ${notification.teamName}`
                              : notification.kind === 'join-mine'
                                ? `${notification.teamName} join request ${notification.status}`
                                : `Withdrawal request ${notification.status}`}</strong>
                          <span>{notification.kind === 'incoming' || notification.kind === 'join-incoming'
                            ? `${notification.eventName} · Review this request as team leader.`
                            : `${notification.eventName} · ${notification.status === 'pending' ? 'Pending team leader approval.' : `Your team leader ${notification.status} your request.`}`}</span>
                          {(notification.kind === 'mine' || notification.kind === 'join-mine') && notification.status === 'pending' && <b className="withdrawal-pending-status">PENDING APPROVAL</b>}
                        </div>
                        {(notification.kind === 'incoming' || notification.kind === 'join-incoming') && (
                          <button type="button" className="button button-secondary" onClick={() => setView('teams')}>Review request</button>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <div className="reminder-section-heading">
                <h2>Upcoming event reminders</h2>
                <span>{notificationEvents.length}</span>
              </div>
              {notificationEvents.length ? (
                <div className="reminder-list">
                  {notificationEvents.map((event) => (
                    <article className="reminder-card" key={event.id}>
                      <span className={`reminder-icon ${event.theme}`}><Bell size={18} /></span>
                      <div className="reminder-copy"><span className="reminder-label">YOU’RE REGISTERED</span><h3>{event.name}</h3><p><CalendarDays size={14} /> {event.date} · {event.time} <span>·</span> <MapPin size={14} /> {event.venue}</p>{scheduleConflicts.has(event.id) && <span className="schedule-conflict"><TriangleAlert size={17} /><span><strong>TIME CONFLICT</strong><span>Overlaps with {scheduleConflicts.get(event.id).join(', ')}</span></span></span>}</div>
                      <span className="reminder-badge">Reminder on</span>
                    </article>
                  ))}
                </div>
              ) : <EmptyState title="No upcoming reminders" message="Register for an event and its upcoming date will appear here." />}
            </section>
          )}

          {!isAdmin && user && view === 'teams' && (
            <section className="teams-section">
              <SectionHeading title="My teams" subtitle="Teams you belong to, including their members and event details." count={teams.length} />
              {teamsLoading ? <p className="loading-message">Loading your teams…</p> : teamsError ? <p className="api-error-message" role="alert">{teamsError}</p> : teams.length ? (
                <div className="student-teams-grid">
                  {teams.map((team) => (
                    <article className="student-team-card" key={`${team.id}-${team.eventId}`}>
                      <div className="student-team-heading">
                        <span className="student-team-icon"><Users size={19} /></span>
                        <div>
                          <h3>{team.name}</h3>
                          <p>{team.isMember ? `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}` : `Join request · ${team.myJoinRequests?.[0]?.status ?? 'pending'}`}</p>
                        </div>
                      </div>
                      {team.registrations.map((registration) => (
                        <div className="student-team-event" key={`${team.id}-${registration.event.id}`}>
                          <strong>{registration.event.name}</strong>
                          <span><CalendarDays size={14} /> {registration.event.date} · {registration.event.time}</span>
                          <span><MapPin size={14} /> {registration.event.venue}</span>
                        </div>
                      ))}
                      {team.withdrawalRequests?.length > 0 && (
                        <div className="withdrawal-requests">
                          <strong>Withdrawal requests</strong>
                          {team.withdrawalRequests.map((withdrawal) => (
                            <div className="withdrawal-request" key={withdrawal.id}>
                              <div><b>{withdrawal.studentName}</b><span> wants to leave {withdrawal.eventName}</span><small>{withdrawal.studentEmail}</small></div>
                              <div className="withdrawal-request-actions">
                                <button type="button" className="button button-secondary" onClick={() => void reviewWithdrawalRequest(withdrawal.id, false)}>Reject</button>
                                <button type="button" className="button button-primary" onClick={() => void reviewWithdrawalRequest(withdrawal.id, true)}>Approve</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {team.joinRequests?.length > 0 && (
                        <div className="withdrawal-requests">
                          <strong>Requests to join</strong>
                          {team.joinRequests.map((joinRequest) => (
                            <div className="withdrawal-request" key={joinRequest.id}>
                              <div><b>{joinRequest.studentName}</b><span> wants to join {team.name}</span><small>{joinRequest.studentEmail} · {joinRequest.eventName}</small></div>
                              <div className="withdrawal-request-actions">
                                <button type="button" className="button button-secondary" onClick={() => void reviewJoinRequest(joinRequest.id, false)}>Reject</button>
                                <button type="button" className="button button-primary" onClick={() => void reviewJoinRequest(joinRequest.id, true)}>Approve</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {team.myJoinRequests?.map((joinRequest) => (
                        <div className="team-join-status" key={`${joinRequest.eventId}-${joinRequest.createdAt}`}>
                          Join request for {joinRequest.eventName}: <strong>{joinRequest.status === 'pending' ? 'Pending approval' : joinRequest.status}</strong>
                        </div>
                      ))}
                      <div className="student-team-members">
                        <strong>Team members</strong>
                        {team.members.map((member) => (
                          <div className="student-team-member" key={member.id}>
                            <span className="roster-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span>
                            <span><b>{member.name}{member.id === user.id ? ' · you' : ''}</b><small>{member.email}</small></span>
                            {member.isLeader && <span className="student-team-leader">Leader</span>}
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : <EmptyState title="You’re not in a team yet" message="When you join a team event or a student adds you to their team, it will appear here with the member list." />}
            </section>
          )}

          <footer className="footer-note"><span>Made for moments that matter.</span><span>FIELDHOUSE · NORTHFIELD COLLEGE</span></footer>
        </div>
      </main>

      {notice && <div className="toast" role="status"><Check size={17} />{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}

      {dialog && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
          {dialog.mode === 'create' ? (
            <section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
              <div className="modal-heading"><div><span className="modal-icon"><Plus size={18} /></span><h2 id="modal-title">Create an event</h2><p>Publish an event for students to discover and register for.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button></div>
              <form onSubmit={createEvent}>
                <label className="form-field">Event name<input name="name" placeholder="e.g. Spring Games Kickoff" required autoFocus /></label>
                <label className="form-field">Description<textarea name="description" rows="3" placeholder="Tell students what to expect" /></label>
                <div className="form-row">
                  <label className="form-field">Category<select name="category"><option>Community</option><option>Tournament</option><option>Basketball</option><option>Workshop</option></select></label>
                  <label className="form-field">Game type<select name="gameType" required><option value="single">Individual</option><option value="team">Team</option></select></label>
                </div>
                <div className="form-row">
                  <label className="form-field">Date<input name="date" type="date" required /></label>
                  <label className="form-field">Start time<input name="time" type="time" defaultValue="15:00" /></label>
                </div>
                <div className="form-row">
                  <label className="form-field">Capacity (teams for team events)<input name="capacity" type="number" min="1" defaultValue="100" required /></label>
                  <label className="form-field">Venue<input name="venue" placeholder="Add a location" required /></label>
                </div>
                <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="button button-primary"><Plus size={16} /> Create event</button></div>
              </form>
            </section>
          ) : dialog.mode === 'team-register' ? (
            <section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
              <div className="modal-heading"><div><span className="modal-icon"><Users size={18} /></span><h2 id="modal-title">Join this team event</h2><p>{dialog.event.name} · Create a team or request to join an available one.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button></div>
              <div className="team-choice-tabs" role="tablist" aria-label="Team registration options">
                <button type="button" role="tab" aria-selected={teamRegistrationChoice === 'create'} className={teamRegistrationChoice === 'create' ? 'selected' : ''} onClick={() => setTeamRegistrationChoice('create')}>Create a team</button>
                <button type="button" role="tab" aria-selected={teamRegistrationChoice === 'join'} className={teamRegistrationChoice === 'join' ? 'selected' : ''} onClick={() => setTeamRegistrationChoice('join')}>Join a team</button>
              </div>
              {teamRegistrationChoice === 'create' ? (
                <form onSubmit={submitTeamRegistration}>
                  <label className="form-field">Team name<input name="teamName" maxLength="100" placeholder="Enter a unique team name" required /></label>
                  <label className="form-field">Team member emails<textarea name="memberEmails" rows="4" placeholder="student1@school.edu, student2@school.edu" /></label>
                  <p className="form-hint">Add registered student emails separated by commas or new lines. Your account is included automatically.</p>
                  {getRegisteredCount(dialog.event) >= dialog.event.capacity && <p className="form-hint">No new team places remain for this event, but you can still request to join an existing team.</p>}
                  <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={getRegisteredCount(dialog.event) >= dialog.event.capacity}><Users size={16} /> Register team</button></div>
                </form>
              ) : (
                <div className="available-teams">
                  {availableTeamsLoading ? <p className="loading-message">Loading teams…</p> : availableTeams.length ? availableTeams.map((team) => (
                    <article className="available-team" key={team.id}>
                      <div><strong>{team.name}</strong><span>Leader: {team.leaderName} · {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}</span></div>
                      {team.isMember ? <span className="team-join-status">Already joined</span>
                        : team.requestStatus === 'pending' ? <button type="button" className="button button-secondary" disabled>Request pending</button>
                          : <button type="button" className="button button-primary" onClick={() => void requestToJoinTeam(team.id)}>{team.requestStatus === 'rejected' ? 'Request again' : 'Request to join'}</button>}
                    </article>
                  )) : <EmptyState title="No teams available yet" message="You can create a team for this event, or check back later." />}
                </div>
              )}
            </section>
          ) : dialog.mode === 'withdraw-confirm' ? (
            <section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
              <div className="modal-heading"><div><span className="modal-icon"><Ticket size={18} /></span><h2 id="modal-title">Request withdrawal?</h2><p>{dialog.event.name} · {dialog.event.date} at {dialog.event.time}</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button></div>
              <p className="withdraw-confirm-copy">Your team leader must approve this request before you are removed from the team and event. Your registration stays active until then.</p>
              <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setDialog({ mode: 'details', event: dialog.event })}>Keep registration</button><button type="button" className="button button-danger" onClick={() => void withdrawFromEvent(dialog.event)}>Send request</button></div>
            </section>
          ) : dialog.mode === 'registered-team' ? (
            <section className="event-modal registered-team-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
              <div className="modal-heading"><div><span className="modal-icon"><Users size={18} /></span><h2 id="modal-title">{dialog.team.name}</h2><p>Team details and registered members.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button></div>
              <div className="registered-team-leader">
                <span className="roster-avatar">{dialog.team.leader.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span>
                <span><strong>{dialog.team.leader.name}</strong><small>{dialog.team.leader.email}</small></span>
                <span className="student-team-leader">Team leader</span>
              </div>
              <div className="student-team-members registered-team-members">
                <strong>All team members · {dialog.team.members.length}</strong>
                {dialog.team.members.map((member) => (
                  <div className="student-team-member" key={member.id}>
                    <span className="roster-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span>
                    <span><b>{member.name}</b><small>{member.email}</small></span>
                    {member.isLeader && <span className="student-team-leader">Leader</span>}
                  </div>
                ))}
              </div>
              <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setDialog(null)}>Close</button></div>
            </section>
          ) : (
            <section className="event-modal details-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
              <div className={`detail-modal-cover event-cover ${dialog.event.theme}`}>
                <button type="button" className="icon-button modal-close" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button>
                <div className="cover-art" aria-hidden="true"><Ticket size={46} strokeWidth={1.2} /></div>
              </div>
              <div className="detail-modal-content">
                <span className="event-status"><span className="status-dot" />{getEventStatus(dialog.event)}</span>
                <h2 id="modal-title">{dialog.event.name}</h2>
                <p className="detail-description">{dialog.event.description || 'Join your campus community for this event. Check the event details and register to save your place.'}</p>
                <div className="detail-facts"><span><CalendarDays size={16} />{dialog.event.date} · {dialog.event.time}</span><span><MapPin size={16} />{dialog.event.venue}</span><span><Users size={16} />{getRegisteredCount(dialog.event)} / {dialog.event.capacity} {getRegistrationUnit(dialog.event)}{getRegisteredCount(dialog.event) === 1 ? '' : 's'} registered</span></div>
                <div className="modal-actions">
                  <button type="button" className="button button-secondary" onClick={() => setDialog(null)}>Close</button>
                  {role === 'student' && registeredEventIds.has(dialog.event.id) && dialog.event.gameType === 'single' && <button type="button" className="button button-danger" onClick={() => void withdrawFromEvent(dialog.event)}>Withdraw</button>}
                  {role === 'student' && registeredEventIds.has(dialog.event.id) && dialog.event.gameType === 'team' && (() => {
                    const team = teams.find((item) => item.registrations.some((registration) => registration.event.id === dialog.event.id));
                    const isLeader = team?.members.some((member) => member.id === user.id && member.isLeader);
                    const withdrawalStatus = myWithdrawalStatuses.get(dialog.event.id);
                    if (isLeader && team.members.length > 1) return <button type="button" className="button button-secondary" disabled title="Transfer leadership before leaving the team">Transfer leadership first</button>;
                    if (withdrawalStatus === 'pending') return <button type="button" className="button button-secondary" disabled>Withdrawal pending approval</button>;
                    if (isLeader) return <button type="button" className="button button-danger" onClick={() => void withdrawFromEvent(dialog.event)}>Withdraw</button>;
                    return <button type="button" className="button button-danger" onClick={() => setDialog({ mode: 'withdraw-confirm', event: dialog.event })}>{withdrawalStatus === 'rejected' ? 'Request withdrawal again' : 'Request withdrawal'}</button>;
                  })()}
                  {role === 'student' && !registeredEventIds.has(dialog.event.id) && <button type="button" className="button button-primary" disabled={dialog.event.gameType === 'single' && getRegisteredCount(dialog.event) >= dialog.event.capacity} onClick={() => {
                    if (dialog.event.gameType === 'team') {
                      openTeamRegistration(dialog.event);
                    } else {
                      void registerForEvent(dialog.event);
                    }
                  }}><Ticket size={16} /> {dialog.event.gameType === 'team' ? 'Continue to team registration' : 'Register for event'}</button>}
                  {!user && <button type="button" className="button button-primary" onClick={() => { setDialog(null); openAuth('login', 'student'); }}>Log in to register</button>}
                  {role === 'admin' && <button type="button" className="button button-primary" onClick={() => { setSelectedEventId(dialog.event.id); setView('registrations'); setDialog(null); }}><Users size={16} /> View registrations</button>}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {authOpen && (
        <div className="modal-backdrop auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !authSubmitting) setAuthOpen(false); }}>
          <section className="event-modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <div className="auth-brand"><span className="brand-mark"><Activity size={20} strokeWidth={2.5} /></span><span>fieldhouse<span className="brand-period">.</span></span></div>
            <button type="button" className="icon-button auth-close" aria-label="Close dialog" disabled={authSubmitting} onClick={() => setAuthOpen(false)}><X size={18} /></button>
            <p className="auth-eyebrow">{authMode === 'login' ? 'WELCOME BACK' : 'JOIN YOUR CAMPUS'}</p>
            <h2 id="auth-title">{authMode === 'login' ? 'Log in to Fieldhouse' : 'Create your account'}</h2>
            <p className="auth-subtitle">{authMode === 'login' ? 'Sign in to manage your events and registrations.' : 'One account gets you closer to every campus moment.'}</p>

            <div className="auth-role-tabs" role="group" aria-label="Account type">
              <button type="button" className={authRole === 'student' ? 'selected' : ''} disabled={authSubmitting} onClick={() => { setAuthRole('student'); setAuthError(''); }}><Users size={15} /> Student</button>
              <button type="button" className={authRole === 'admin' ? 'selected' : ''} disabled={authSubmitting} onClick={() => { setAuthRole('admin'); setAuthError(''); }}><Activity size={15} /> Admin</button>
            </div>

            <form className="auth-form" onSubmit={submitAuth}>
              {authMode === 'register' && <label className="form-field">Full name<input name="name" autoComplete="name" placeholder="Your name" maxLength="100" required /></label>}
              <label className="form-field">Email address<input name="email" type="email" autoComplete="email" placeholder="you@school.edu" required /></label>
              <label className="form-field">Password<span className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} placeholder={authMode === 'register' ? 'At least 8 characters' : 'Enter your password'} minLength={authMode === 'register' ? 8 : undefined} required /><button type="button" className="password-visibility" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
              {authError && <p className="auth-error" role="alert">{authError}</p>}
              <button type="submit" className="button button-primary auth-submit" disabled={authSubmitting}>
                {authSubmitting ? 'Please wait…' : authMode === 'login' ? 'Log in' : 'Create account'} {!authSubmitting && <ArrowRight size={16} />}
              </button>
            </form>

            <p className="auth-switch">
              {authMode === 'login' ? 'New to Fieldhouse?' : 'Already have an account?'}
              <button type="button" disabled={authSubmitting} onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(''); }}>
                {authMode === 'login' ? 'Sign up' : 'Log in'}
              </button>
            </p>
            <p className="auth-disclaimer">Accounts are securely managed by Supabase. Anyone can register as an admin.</p>
          </section>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, tone }) {
  return (
    <article className="stat-card">
      <div className="stat-top"><span className={`stat-icon ${tone}`}>{icon}</span></div>
      <p className="stat-label">{label}</p>
      <div className="stat-value">{value}</div>
    </article>
  );
}

function SectionHeading({ title, subtitle, count }) {
  return (
    <div className="section-heading">
      <div><div className="heading-title"><h2>{title}</h2><span className="event-count">{count}</span></div><p>{subtitle}</p></div>
    </div>
  );
}

function FilterTabs({ filter, onChange }) {
  return (
    <div className="filter-tabs" role="group" aria-label="Filter events">
      {filters.map((item) => <button type="button" key={item} className={filter === item ? 'filter-tab selected' : 'filter-tab'} onClick={() => onChange(item)}>{item}</button>)}
    </div>
  );
}

function EventGrid({ events, role, registeredEventIds, scheduleConflicts = new Map(), onRegister, onRequestAuth, onDetails, onClear }) {
  if (!events.length) {
    return <EmptyState title="No events found" message="Try a different search or filter, or check back later." onClear={onClear} />;
  }

  return (
    <div className="event-grid">
      {events.map((event) => {
        const registered = registeredEventIds.has(event.id);
        const full = event.gameType === 'single' && getRegisteredCount(event) >= event.capacity;
        const conflictingEvents = registered ? scheduleConflicts.get(event.id) : null;
        return (
          <article className="event-card" key={event.id}>
            <div className={`event-cover ${event.theme}`}>
              <span className="cover-category">{event.category}</span>
              <div className="cover-art" aria-hidden="true">{event.theme === 'soccer' ? <Activity size={43} strokeWidth={1.2} /> : event.theme === 'basketball' ? <Ticket size={43} strokeWidth={1.2} /> : <Users size={43} strokeWidth={1.2} />}</div>
              <div className="cover-date"><strong>{event.date.split(' ')[1].replace(',', '')}</strong><span>{event.date.split(' ')[0]}</span></div>
            </div>
            <div className="event-card-body">
              <div className="event-status"><span className={`status-dot ${getEventStatus(event) === 'Almost full' ? 'full' : ''}`} />{getEventStatus(event)}</div>
              {conflictingEvents?.length > 0 && <div className="schedule-conflict"><TriangleAlert size={17} /><span><strong>TIME CONFLICT</strong><span>Overlaps with {conflictingEvents.join(', ')}</span></span></div>}
              <h3>{event.name}</h3>
              <div className="event-detail"><Clock3 size={14} /><span>{event.date} <i>·</i> {event.time}</span></div>
              <div className="event-detail"><MapPin size={14} /><span>{event.venue}</span></div>
              <div className="event-card-footer">
                <div className="attendees"><span><strong>{getRegisteredCount(event)}</strong> / {event.capacity} {getRegistrationUnit(event)}{getRegisteredCount(event) === 1 ? '' : 's'} registered</span></div>
                {role === 'admin' ? (
                  <button type="button" className="card-arrow" aria-label={`View registrations for ${event.name}`} onClick={() => onDetails(event)}><Users size={16} /></button>
                ) : (
                  <button
                    type="button"
                    className={`register-button ${registered ? 'is-registered' : ''}`}
                    disabled={role === 'student' && !registered && full}
                    onClick={() => registered ? onDetails(event) : role === 'student' ? onRegister(event) : onRequestAuth(event)}
                  >
                    {registered ? <><Check size={13} /> View registration</> : full ? 'Full' : role === 'student' ? event.gameType === 'team' ? 'Register team' : 'Register' : 'Log in to register'}
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function EmptyState({ title, message, onClear }) {
  return (
    <div className="empty-state">
      <span><Search size={20} /></span>
      <strong>{title}</strong>
      <p>{message}</p>
      {onClear && <button type="button" className="text-button" onClick={onClear}>Clear filters</button>}
    </div>
  );
}

export default App;
