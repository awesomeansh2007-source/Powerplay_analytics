/**
 * Query <-> URL search params. The same encoding is used by the browser (hash URL, so
 * every view is a shareable link) and by the server (API query string), so a filter
 * never means two different things on the two sides.
 */
import { DEFAULT_SETTINGS, type ISODate, type Query, type Settings } from './types.ts';
import { isISODate } from './dates.ts';

export const WINDOW_OPTIONS = [7, 14, 30, 60, 90] as const;
export const DEFAULT_WINDOW = 14;

export interface PartialQuery {
  org?: string;
  projects?: string[];
  date?: ISODate;
  days?: number;
  settings?: Partial<Settings>;
}

function intList(s: string | null): number[] | null {
  if (!s) return null;
  const out = s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x));
  return out.length ? out : null;
}

/** Parse whatever is present; absent keys stay undefined so callers can apply defaults. */
export function parseQueryParams(p: URLSearchParams): PartialQuery {
  const q: PartialQuery = {};
  const org = p.get('org');
  if (org && /^[A-Za-z0-9_-]{1,64}$/.test(org)) q.org = org;
  const projects = p.get('projects');
  if (projects) {
    q.projects = projects
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
  }
  const date = p.get('date');
  if (isISODate(date)) q.date = date;
  const days = Number(p.get('days'));
  if ((WINDOW_OPTIONS as readonly number[]).includes(days)) q.days = days;

  const s: Partial<Settings> = {};
  const overdue = p.get('overdue');
  if (overdue === '1' || overdue === '0') s.includeOverdue = overdue === '1';
  const wd = intList(p.get('wd'));
  if (wd) {
    const valid = [...new Set(wd.filter((d) => d >= 0 && d <= 6))].sort();
    if (valid.length) s.workingDays = valid;
  }
  const bands = intList(p.get('bands'));
  if (bands && bands.length === 3) {
    const [good, fair, poor] = bands.map((b) => Math.max(0, Math.min(100, b)));
    if (good >= fair && fair >= poor) s.bands = { good, fair, poor };
  }
  const silent = Number(p.get('silent'));
  if (Number.isInteger(silent) && silent >= 1 && silent <= 30) s.silentAfterDays = silent;
  if (Object.keys(s).length) q.settings = s;
  return q;
}

export function resolveSettings(s?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    bands: { ...DEFAULT_SETTINGS.bands, ...(s?.bands ?? {}) },
    workingDays: s?.workingDays?.length ? s.workingDays : DEFAULT_SETTINGS.workingDays,
  };
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Serialise, omitting values equal to their defaults so links stay short. */
export function toQueryParams(q: PartialQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.org) p.set('org', q.org);
  if (q.projects?.length) p.set('projects', q.projects.join(','));
  if (q.date) p.set('date', q.date);
  if (q.days && q.days !== DEFAULT_WINDOW) p.set('days', String(q.days));
  const s = q.settings;
  if (s) {
    if (s.includeOverdue !== undefined && s.includeOverdue !== DEFAULT_SETTINGS.includeOverdue)
      p.set('overdue', s.includeOverdue ? '1' : '0');
    if (s.workingDays && !sameList([...s.workingDays].sort(), DEFAULT_SETTINGS.workingDays))
      p.set('wd', [...s.workingDays].sort().join(','));
    if (s.bands) {
      const b = { ...DEFAULT_SETTINGS.bands, ...s.bands };
      const d = DEFAULT_SETTINGS.bands;
      if (b.good !== d.good || b.fair !== d.fair || b.poor !== d.poor) p.set('bands', `${b.good},${b.fair},${b.poor}`);
    }
    if (s.silentAfterDays !== undefined && s.silentAfterDays !== DEFAULT_SETTINGS.silentAfterDays)
      p.set('silent', String(s.silentAfterDays));
  }
  return p;
}

/** Complete a partial query given org fallback and the dataset's default focus date. */
export function resolveQuery(q: PartialQuery, fallback: { org: string; date: ISODate }): Query {
  return {
    org: q.org ?? fallback.org,
    projects: q.projects ?? [],
    date: q.date ?? fallback.date,
    days: q.days ?? DEFAULT_WINDOW,
    settings: resolveSettings(q.settings),
  };
}
