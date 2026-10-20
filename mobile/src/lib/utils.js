export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DEFAULT_CATEGORIES = [
  { id: 'sleep',      label: 'Sleep',      color: '#3B82F6' },
  { id: 'work',       label: 'Work',       color: '#F59E0B' },
  { id: 'school',     label: 'School',     color: '#22C55E' },
  { id: 'personal',   label: 'Personal',   color: '#A855F7' },
  { id: 'free-time',  label: 'Free Time',  color: '#6B7280' },
  { id: 'drive-time', label: 'Travel Buffer', color: '#F97316' },
];

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return toDateStr(d);
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// Expand a base event into a linked recurring series. Mirrors the web app so
// both platforms produce identical instances (and the same shared series_id).
export function generateRepeatInstances(baseEvent, repeat) {
  const baseDate = new Date(baseEvent.week_start + 'T00:00:00');
  baseDate.setDate(baseDate.getDate() + baseEvent.day_of_week);

  const step = { daily: 1, weekly: 7, biweekly: 14, monthly: 28, yearly: 364 }[repeat];
  const total = { daily: 365, weekly: 52, biweekly: 26, monthly: 12, yearly: 3 }[repeat];

  const { slot_start, slot_duration, precision, calendar, label, category, color, is_all_day, source, series_id } = baseEvent;

  return Array.from({ length: total }, (_, i) => {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i * step);
    const ws = getWeekStart(d);
    return {
      label, category, color,
      week_start: ws, day_of_week: d.getDay(),
      slot_start, slot_duration, precision, calendar,
      ...(is_all_day && { is_all_day: true }),
      ...(source && { source }),
      ...(series_id && { series_id }),
    };
  });
}

/** Absolute calendar date (ms) an occurrence falls on, from its week + weekday. */
export function eventAbsMs(e) {
  const d = new Date(e.week_start + 'T00:00:00');
  d.setDate(d.getDate() + (e.day_of_week ?? 0));
  return d.getTime();
}

export function todayStr() {
  return toDateStr(new Date());
}

export function slotToTime(slot, precision = 0.5, military = false) {
  const minutes = Math.round(slot * (precision <= 0.5 ? 30 : 60));
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  if (military) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 || 12;
  if (m === 0) return `${displayH}${period}`;
  return `${displayH}:${String(m).padStart(2, '0')}${period}`;
}

export function formatWeekRange(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(weekStart + 'T00:00:00');
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  if (start.getMonth() === end.getMonth()) {
    return `${start.toLocaleDateString('en-US', { month: 'short' })} ${start.getDate()}â€“${end.getDate()}`;
  }
  return `${start.toLocaleDateString('en-US', opts)} â€“ ${end.toLocaleDateString('en-US', opts)}`;
}

/** Convert event slot coords to pixels in a 30-min (SLOT_H px per slot) grid. */
export function eventToPixels(event, slotH) {
  const factor = 2 * (event.precision || 0.5);
  return {
    top:    event.slot_start    * factor * slotH,
    height: event.slot_duration * factor * slotH,
  };
}

export function slotsToHours(slots, precision = 0.5) {
  return slots * (precision <= 0.5 ? 0.5 : 1);
}

/** Wall-clock end time of an event (its date + start time + duration). */
export function getEventEndDateTime(event) {
  const dateStr = addDays(event.week_start, event.day_of_week);
  const startHours = slotsToHours(event.slot_start, event.precision);
  const durationHours = slotsToHours(event.slot_duration, event.precision);
  const d = new Date(dateStr + 'T00:00:00');
  d.setTime(d.getTime() + (startHours + durationHours) * 3600000);
  return d;
}

