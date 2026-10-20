import { storage } from './storage.js';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

const ADMIN_TOKEN_KEY = 'lc-admin-token';

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = storage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    let msg = `${method} ${path} â†’ ${res.status}`;
    try { const j = await res.json(); msg = j.error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  auth: {
    status:           ()                          => request('GET',  '/auth/status'),
    prelogin:         (email)                     => request('POST', '/auth/prelogin', { email }),
    register:         (email, authVerifier, envelope, turnstile_token) =>
                        request('POST', '/auth/register', { email, authVerifier, envelope, turnstile_token }),
    login:            (email, authVerifier)       => request('POST', '/auth/login', { email, authVerifier }),
    recoveryEnvelope: (email)                     => request('POST', '/auth/recovery-envelope', { email }),
    resetPassword:    (email, recoveryVerifier, envelope) =>
                        request('POST', '/auth/reset-password', { email, recoveryVerifier, envelope }),
    setEmail:         (email)                     => request('PUT',  '/auth/email',    { email }),
    setTimezone:      (timezone)                  => request('PUT',  '/auth/timezone', { timezone }),
    deleteAccount:    (authVerifier)              => request('DELETE', '/auth/account', { authVerifier }),
  },

  /** "Sign in with Google" as a linked login provider. */
  authGoogle: {
    // Linking (must be signed in): get the consent URL, then finalize the DEK wrap.
    linkUrl:      ()    => request('GET',  '/auth/google/link/connect'),
    linkFinalize: (env) => request('POST', '/auth/google/link/finalize', env),
    // Login (public): get the consent URL, then exchange the returned ticket.
    loginUrl:     ()      => request('GET',  '/auth/google/login/connect'),
    loginComplete:(ticket)=> request('POST', '/auth/google/login/complete', { ticket }),
    // Management.
    status:       ()    => request('GET',    '/auth/google/status'),
    unlink:       ()    => request('DELETE', '/auth/google/link'),
  },

  admin: {
    clearAdminToken: () => sessionStorage.removeItem(ADMIN_TOKEN_KEY),
  },


  /** Full data snapshot â€” called once on startup */
  sync: () => request('GET', '/sync'),

  events: {
    create:           (event)             => request('POST',   '/events',                   event),
    update:           (id, updates)       => request('PUT',    `/events/${id}`,             updates),
    clearAll:         (authVerifier)      => request('DELETE', '/events',                   { authVerifier }),
    delete:           (id)                => request('DELETE', `/events/${id}`),
    batch:            (eventsArr)         => request('POST',   '/events/batch',             { events: eventsArr }),
    replaceBySource:  (source, eventsArr) => request('POST',   '/events/replace-by-source', { source, events: eventsArr }),
    replaceBySourceCalendar: (sourceCalendarId, eventsArr) =>
      request('POST', '/events/replace-by-source-calendar', { sourceCalendarId, events: eventsArr }),
  },

  ical: {
    fetch: (url) => request('POST', '/ical-fetch', { url }),
  },

  oauth: {
    /** Returns { url } to redirect the browser to for provider consent. */
    connectUrl: (provider) => request('GET', `/oauth/${provider}/connect`),
  },

  calendarConnections: {
    list:          ()   => request('GET',    '/calendar-connections'),
    delete:        (id) => request('DELETE', `/calendar-connections/${id}`),
    listCalendars: (id) => request('GET',    `/calendar-connections/${id}/calendars`),
    listEvents:    (id, externalCalendarId) =>
      request('GET', `/calendar-connections/${id}/events?externalCalendarId=${encodeURIComponent(externalCalendarId)}`),
  },

  feed: {
    status:  () => request('GET',    '/feed/status'),
    enable:  () => request('POST',   '/feed/enable'),
    disable: () => request('DELETE', '/feed'),
  },

  categories: {
    create:  (cat)            => request('POST',   '/categories',      cat),
    update:  (id, updates)    => request('PUT',    `/categories/${id}`, updates),
    delete:  (id)             => request('DELETE', `/categories/${id}`),
  },

  linkedCalendars: {
    create:  (cal)         => request('POST',   '/linked-calendars',      cal),
    update:  (id, updates) => request('PUT',    `/linked-calendars/${id}`, updates),
    delete:  (id)          => request('DELETE', `/linked-calendars/${id}`),
  },

  habits: {
    create:         (habit)     => request('POST',   '/habits',                     habit),
    update:         (id, upd)   => request('PUT',    `/habits/${id}`,               upd),
    delete:         (id)        => request('DELETE', `/habits/${id}`),
    complete:       (id, date, completionId) => request('POST', `/habits/${id}/complete`, { date, completionId }),
    uncomplete:     (id, date)  => request('DELETE', `/habits/${id}/complete/${date}`),
  },

  budgets: {
    set:    (categoryId, weeklyHours) => request('PUT',    `/budgets/${categoryId}`, { weeklyHours }),
    delete: (categoryId)              => request('DELETE', `/budgets/${categoryId}`),
  },

  integrations: {
    list:           ()         => request('GET',    '/integrations'),
    create:         (data)     => request('POST',   '/integrations',              data),
    update:         (id, data) => request('PUT',    `/integrations/${id}`,        data),
    delete:         (id)       => request('DELETE', `/integrations/${id}`),
    test:           (id)       => request('POST',   `/integrations/${id}/test`),
    listSchedules:  ()         => request('GET',    '/integrations/schedules'),
    createSchedule: (data)     => request('POST',   '/integrations/schedules',    data),
    updateSchedule: (id, data) => request('PUT',    `/integrations/schedules/${id}`, data),
    deleteSchedule: (id)       => request('DELETE', `/integrations/schedules/${id}`),
  },

  push: {
    getVapidKey: ()           => request('GET',    '/push/vapid-public-key'),
    subscribe:   (sub)        => request('POST',   '/push/subscribe',   { subscription: sub }),
    unsubscribe: (endpoint)   => request('DELETE', '/push/subscribe',   { endpoint }),
    expoToken:   (token)      => request('POST',   '/push/expo-token',  { token }),
  },

  profile: {
    get: ()     => request('GET', '/profile'),
    set: (data) => request('PUT', '/profile', data),
  },

  categoryKeywords: {
    get: () => request('GET', '/category-keywords'),
  },

  llmSettings: {
    get: ()     => request('GET', '/llm-settings'),
    set: (data) => request('PUT', '/llm-settings', data),
  },

  appearance: {
    get: ()     => request('GET', '/appearance'),
    set: (data) => request('PUT', '/appearance', data),
  },

  travelTime: {
    /** Estimate travel minutes between two plaintext addresses.
     *  mode ∈ { car, walk, bike } picks the routing profile (default car). */
    estimate: (origin, destination, mode = 'car') => request('POST', '/travel-time', { origin, destination, mode }),
  },

};

