/**
 * Notification Service
 * Runs a cron-like scheduler (every 60 seconds) that checks for pending
 * reminders and dispatches them to configured integrations.
 *
 * The server only knows TIMING metadata (slot_start, week_start, etc.) —
 * never event labels unless the user has set an integration_hint.
 */
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';
import { pocketbaseHabitCompletions, pocketbaseHabits } from '../lib/pocketbaseHabits.js';
import { pocketbaseEvents } from '../lib/pocketbaseEvents.js';
import { pocketbaseUsers } from '../lib/pocketbaseInternal.js';
import { pocketbaseNotificationSchedules, pocketbaseUserIntegrations } from '../lib/pocketbaseNotifications.js';
import { pocketbaseNotificationLog, pocketbasePushSubscriptions } from '../lib/pocketbaseOperational.js';

// ── VAPID setup ───────────────────────────────────────────────────────────────

let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  vapidConfigured = true;
}

// ── SMTP (e-mail) setup ────────────────────────────────────────────────────────
// A single shared transport, built lazily from env. Self-hosters set SMTP_*;
// when unset, e-mail integrations are simply skipped (like unconfigured VAPID).

let mailTransport = null;
let mailConfigured = false;

if (process.env.SMTP_HOST) {
  // `||`, not `??`: an env var supplied but left blank (docker-compose renders an
  // unset passthrough as "") has to fall back like an absent one.
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Implicit TLS on 465, STARTTLS otherwise — the usual convention.
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === 'true'
      : port === 465,
    auth: (process.env.SMTP_USER || process.env.SMTP_PASS)
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  mailConfigured = true;
}

const MAIL_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'PLS Calendar <no-reply@example.com>';

// ── SMS (Twilio) setup ─────────────────────────────────────────────────────────
// Delivered over Twilio's REST API with a plain fetch (no extra dependency), the
// same lightweight approach used for Expo push. Self-hosters set TWILIO_*; when
// unset, SMS integrations are skipped just like unconfigured VAPID/SMTP.

const smsConfigured = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_FROM_NUMBER
);

// ── Timezone helpers ──────────────────────────────────────────────────────────

function nowInTz(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: parseInt(parts.hour, 10),
      minute: parseInt(parts.minute, 10),
      dayOfWeek: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`).getDay(),
      timeStr: `${parts.hour}:${parts.minute}`,
    };
  } catch {
    const now = new Date();
    return {
      date: now.toISOString().slice(0, 10),
      hour: now.getHours(),
      minute: now.getMinutes(),
      dayOfWeek: now.getDay(),
      timeStr: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
    };
  }
}

function addDaysToDate(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Wall-clock time (a local date + minutes-into-day) as epoch-style ms in a fixed
// UTC frame. Two such values differ by exactly their wall-clock gap, DST-free —
// so reminder offsets can safely cross midnight / week boundaries.
function wallClockMs(dateStr, minutesIntoDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + minutesIntoDay * 60_000;
}

// Human-readable lead time for reminder copy: 20160 → "2 weeks", 60 → "1 hour".
function formatLeadTime(minutes) {
  const m = Math.round(Math.abs(minutes) || 0);
  if (m <= 0) return 'now';
  for (const [name, size] of [['week', 10080], ['day', 1440], ['hour', 60], ['minute', 1]]) {
    if (m % size === 0) {
      const n = m / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${m} minutes`;
}

// ── Dispatch functions ────────────────────────────────────────────────────────

function discordPayload(title, body) {
  return { embeds: [{ title, description: body, color: 0x6d28d9, footer: { text: 'PLS Calendar' } }] };
}

function slackPayload(title, body) {
  return { text: `*${title}*\n${body}` };
}

async function dispatchWebhook(url, payload, label) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${label} webhook responded ${res.status}`);
  } catch (err) {
    console.warn(`[notify] ${label} webhook failed:`, err.message);
    throw err;
  }
}

async function dispatchWebPush(userId, title, body) {
  if (!vapidConfigured) return;
  const subs = await pocketbasePushSubscriptions.getAll(userId);
  await Promise.allSettled(
    subs.map(({ subscription }) =>
      webpush.sendNotification(subscription, JSON.stringify({ title, body, url: '/' }))
        .catch(err => {
          console.warn('[notify] Web push failed:', err.message);
        })
    )
  );
}

async function dispatchExpoPush(token, title, body) {
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default' }),
    });
    if (!res.ok) throw new Error(`Expo push responded ${res.status}`);
  } catch (err) {
    console.warn('[notify] Expo push failed:', err.message);
    throw err;
  }
}

async function dispatchEmail(to, title, body) {
  if (!mailConfigured) throw new Error('E-mail is not configured on this server (set SMTP_HOST)');
  if (!to) throw new Error('No recipient address on this integration');
  try {
    await mailTransport.sendMail({
      from: MAIL_FROM,
      to,
      subject: title,
      text: body,
      html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px;font-size:18px;color:#6d28d9">${escapeHtml(title)}</h2>
        <p style="margin:0;font-size:15px;line-height:1.5;color:#111">${escapeHtml(body)}</p>
        <p style="margin:20px 0 0;font-size:12px;color:#999">Sent by PLS Calendar</p>
      </div>`,
    });
  } catch (err) {
    console.warn('[notify] E-mail send failed:', err.message);
    throw err;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function dispatchSms(to, title, body) {
  if (!smsConfigured) throw new Error('SMS is not configured on this server (set TWILIO_ACCOUNT_SID)');
  if (!to) throw new Error('No phone number on this integration');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const form = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_FROM_NUMBER,
    Body: title ? `${title}\n${body}` : body,
  });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      let detail = String(res.status);
      try { const j = await res.json(); detail = j.message ?? detail; } catch { /* non-JSON error body */ }
      throw new Error(`Twilio responded ${detail}`);
    }
  } catch (err) {
    console.warn('[notify] SMS send failed:', err.message);
    throw err;
  }
}

// ── Dispatch router ───────────────────────────────────────────────────────────

async function dispatchToIntegration(integration, title, body, entityId, userId) {
  const alreadySent = await pocketbaseNotificationLog.wasFiredToday(integration.id, entityId, title);
  if (alreadySent) return;

  let status = 'sent';
  try {
    if (integration.type === 'discord_webhook' && integration.endpoint_url) {
      await dispatchWebhook(integration.endpoint_url, discordPayload(title, body), 'Discord');
    } else if (integration.type === 'slack_webhook' && integration.endpoint_url) {
      await dispatchWebhook(integration.endpoint_url, slackPayload(title, body), 'Slack');
    } else if (integration.type === 'generic_webhook' && integration.endpoint_url) {
      await dispatchWebhook(integration.endpoint_url, { title, body, entity_id: entityId, timestamp: new Date().toISOString() }, 'Generic');
    } else if (integration.type === 'web_push') {
      await dispatchWebPush(userId, title, body);
    } else if (integration.type === 'expo_push' && integration.push_token) {
      await dispatchExpoPush(integration.push_token, title, body);
    } else if (integration.type === 'email' && integration.email_address) {
      await dispatchEmail(integration.email_address, title, body);
    } else if (integration.type === 'sms' && integration.phone_number) {
      await dispatchSms(integration.phone_number, title, body);
    }
  } catch {
    status = 'failed';
  }

  await pocketbaseNotificationLog.record(randomUUID(), userId, integration.id, title, entityId, status);
}

// ── Label helper (respects ZK) ────────────────────────────────────────────────

function resolveLabel(entity, integration) {
  if (integration.include_hints && entity.integration_hint) return entity.integration_hint;
  return null;
}

// ── Trigger checkers ──────────────────────────────────────────────────────────

async function getEventsDueForReminder(userId, tzNow, offsetMinutes) {
  const allEvents = (await pocketbaseEvents.getAll(userId)).filter(e => e.calendar === 'plan' && !e.is_all_day);
  // Compare "now" and each event as wall-clock minutes in the user's timezone.
  // offsetMinutes is negative for "before", so the reminder is due at
  // (event start + offset). Working in absolute minutes lets the offset cross
  // midnight and week boundaries — the old same-day hour math could not, so any
  // lead time longer than the event's time-of-day silently never fired.
  const nowMinute = Math.floor(wallClockMs(tzNow.date, tzNow.hour * 60 + tzNow.minute) / 60_000);
  const results = [];
  for (const ev of allEvents) {
    const eventDate = addDaysToDate(ev.week_start, ev.day_of_week);
    // slot_start is counted in the event's own precision (0.5h or 1h per slot),
    // not fixed 30-min slots — so convert with precision, or an hourly-precision
    // event reminds at the wrong time (e.g. a 10:00 event treated as 05:00).
    const slotMinutes = (ev.slot_start ?? 0) * (ev.precision || 0.5) * 60;
    const reminderMinute = Math.floor((wallClockMs(eventDate, slotMinutes) + offsetMinutes * 60_000) / 60_000);
    if (nowMinute === reminderMinute) results.push(ev);
  }
  return results;
}

async function getHabitsNotDoneToday(userId, tzNow) {
  const allHabits = (await pocketbaseHabits.getAll(userId)).filter(h => h.active && (h.target_days ?? [0,1,2,3,4,5,6]).includes(tzNow.dayOfWeek));
  const done = new Set(
    (await pocketbaseHabitCompletions.getAll(userId)).filter(c => c.date === tzNow.date).map(c => c.habit_id)
  );
  return allHabits.filter(h => !done.has(h.id));
}

// ── Main scheduler tick ───────────────────────────────────────────────────────

async function tick() {
  try {
    const allUsers = await pocketbaseUsers.getAllForScheduler();
    for (const user of allUsers) {
      const tz = user.user_timezone ?? 'UTC';
      const tzNow = nowInTz(tz);
      const [integrations, schedules] = await Promise.all([
        pocketbaseUserIntegrations.getAll(user.id),
        pocketbaseNotificationSchedules.getAllActive(user.id),
      ]);
      const enabledIntegrations = integrations.filter(i => i.enabled);

      if (!enabledIntegrations.length || !schedules.length) continue;

      for (const sched of schedules) {
        if (!sched.days_of_week.includes(tzNow.dayOfWeek)) continue;

        const targets = sched.integration_id
          ? enabledIntegrations.filter(i => i.id === sched.integration_id)
          : enabledIntegrations;

        if (sched.trigger_type === 'event_reminder') {
          const dueEvents = await getEventsDueForReminder(user.id, tzNow, sched.offset_minutes);
          const lead = formatLeadTime(sched.offset_minutes);
          for (const ev of dueEvents) {
            for (const integration of targets) {
              const hint = resolveLabel(ev, integration);
              const title = 'Upcoming Event';
              const body  = hint
                ? `${hint} starts in ${lead}`
                : `You have an event starting in ${lead}`;
              // Key the de-dupe log by (event, offset) so several lead times for
              // the same event that happen to land on the same day each fire.
              await dispatchToIntegration(integration, title, body, `${ev.id}:${sched.offset_minutes}`, user.id);
            }
          }
        }

        if (sched.trigger_type === 'habit_reminder') {
          const hhmm = tzNow.timeStr;
          if (sched.time_of_day && Math.abs(parseInt(hhmm.replace(':',''),10) - parseInt((sched.time_of_day ?? '').replace(':',''),10)) > 1) continue;
          const pending = await getHabitsNotDoneToday(user.id, tzNow);
          if (!pending.length) continue;
          for (const integration of targets) {
            const hints = pending.map(h => resolveLabel(h, integration)).filter(Boolean);
            const title = 'Habit Check-in';
            const body  = hints.length
              ? `Still pending: ${hints.join(', ')}`
              : `You have ${pending.length} habit${pending.length > 1 ? 's' : ''} pending today`;
            const entityKey = `habits-${tzNow.date}`;
            await dispatchToIntegration(integration, title, body, entityKey, user.id);
          }
        }

        if (sched.trigger_type === 'daily_summary') {
          const hhmm = tzNow.timeStr;
          if (sched.time_of_day && Math.abs(parseInt(hhmm.replace(':',''),10) - parseInt((sched.time_of_day ?? '').replace(':',''),10)) > 1) continue;
          const todayEvents = (await pocketbaseEvents.getAll(user.id))
            .filter(e => e.calendar === 'plan' && addDaysToDate(e.week_start, e.day_of_week) === tzNow.date);
          const pending = await getHabitsNotDoneToday(user.id, tzNow);
          for (const integration of targets) {
            const title = `Daily Summary — ${tzNow.date}`;
            const body  = `${todayEvents.length} event${todayEvents.length !== 1 ? 's' : ''} planned · ${pending.length} habit${pending.length !== 1 ? 's' : ''} pending`;
            await dispatchToIntegration(integration, title, body, `daily-${tzNow.date}`, user.id);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[notify] Scheduler tick error:', err.message);
  }
}

// ── Streak milestone check (called directly from habits route) ─────────────────

export async function checkStreakMilestone(userId, habitId, currentStreak) {
  const milestones = [7, 30, 100, 365];
  if (!milestones.includes(currentStreak)) return;
  const emojis = { 7: '🔥', 30: '⭐', 100: '💎', 365: '👑' };
  const integrations = (await pocketbaseUserIntegrations.getAll(userId)).filter(i => i.enabled);
  const habit = await pocketbaseHabits.getById(userId, habitId);
  for (const integration of integrations) {
    const hint = resolveLabel(habit ?? {}, integration);
    const title = `Streak Milestone ${emojis[currentStreak]}`;
    const body  = hint
      ? `${hint}: ${currentStreak}-day streak!`
      : `You hit a ${currentStreak}-day streak on one of your habits!`;
    await dispatchToIntegration(integration, title, body, `streak-${habitId}-${currentStreak}`, userId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let intervalHandle = null;

export function startScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tick, 60_000);
  console.log('[notify] Notification scheduler started (60s interval)');
}

export { dispatchToIntegration, dispatchWebhook, discordPayload, slackPayload, dispatchWebPush, dispatchExpoPush, dispatchEmail, dispatchSms };
