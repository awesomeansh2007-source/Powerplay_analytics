/**
 * Shared contract for the Powerplay Analytics dashboard.
 *
 * Three layers talk through these types and nothing else:
 *
 *   server/repository  (ClickHouse)  ─┐
 *                                      ├─► Dataset ─► shared/metrics ─► DashboardPayload / SiteDetail / PersonDetail ─► src/ (UI)
 *   shared/demo        (generated)   ─┘
 *
 * All calendar dates are ISO `YYYY-MM-DD` strings on the Indian (IST, Asia/Kolkata)
 * calendar — Powerplay stores task-log dates as IST midnight (18:30 UTC the previous
 * day), so a UTC date would put every log on the wrong day.
 */

/** `YYYY-MM-DD` on the IST calendar. */
export type ISODate = string;

// ─────────────────────────────────────────────────────────────────────────────
// Normalised source rows (what the repository / demo generator produce)
// ─────────────────────────────────────────────────────────────────────────────

export interface Org {
  id: string; // ORG…
  name: string;
  projectCount: number;
}

export interface Project {
  id: string; // PRJ…
  name: string;
  isActive: boolean;
  /** Raw platform project status (numeric code or label), shown only as metadata. */
  status: string | null;
  startDate: ISODate | null;
  endDate: ISODate | null;
  /** `projects.project_progress` — the platform's own duration-weighted actual %. */
  platformProgress: number | null;
}

export interface Person {
  id: string; // USR… or, when the source only has names, the name itself
  name: string;
}

/** One active LEAF task (task.type = 0) on the current schedule. */
export interface Task {
  id: string; // TSK…
  projectId: string;
  name: string;
  displayId: string | null; // TSK000123 — schedule order
  /** WBS ancestry, outermost first (parent_task_level_1..n), blanks removed. */
  path: string[];
  workCategory: string | null;
  /** Working-day duration from the platform; used as the progress weight. */
  duration: number;
  start: ISODate | null;
  end: ISODate | null;
  actualStart: ISODate | null;
  actualEnd: ISODate | null;
  /** Current % complete, clamped to 0–100 (source can exceed 100). */
  pct: number;
  /**
   * % complete at the start of the loaded log window (last log before `Dataset.logsFrom`,
   * or 0 when none). Lets the engine rebuild actual % on any day inside the window.
   */
  pctAtLogsFrom: number;
  /** Platform-derived status label: Completed | Delayed | Not Started | In Progress | In Progress (Delayed) | '' */
  platformStatus: string | null;
  assigneeIds: string[];
}

/** One progress update on a task (tasklog row). */
export interface TaskLog {
  id: string; // TL…
  taskId: string;
  projectId: string;
  /** Date the work is reported for (IST calendar). */
  date: ISODate;
  /** When the entry was actually made (ISO datetime, UTC). Null when the source lacks it. */
  createdAt: string | null;
  /** Person who made the entry (tasklog.updated_by / created_by). */
  userId: string | null;
  /** percent_work_done_till_now after this entry, clamped 0–100. */
  pct: number | null;
  note: string | null;
  photos: number;
}

export interface Issue {
  id: string; // THD…
  projectId: string;
  title: string;
  isOpen: boolean;
  createdAt: ISODate | null;
  closedAt: ISODate | null;
  tags: string[];
  creatorName: string | null;
  taskId: string | null;
}

export type PoStage =
  | 'draft'
  | 'pending' // APPROVAL PENDING
  | 'ordered' // approved, nothing received
  | 'partially_delivered'
  | 'delivered'
  | 'rejected'
  | 'other';

export interface PurchaseOrder {
  id: string;
  displayId: string;
  projectId: string;
  stage: PoStage;
  rawStatus: string;
  /** Total incl. tax, INR. */
  amount: number;
  createdAt: ISODate;
  updatedAt: ISODate | null;
  vendorName: string | null;
  creatorName: string | null;
}

export interface Dataset {
  org: Org;
  source: 'clickhouse' | 'demo';
  /** ISO datetime the dataset was assembled. */
  generatedAt: string;
  /** Today on the IST calendar when the dataset was assembled. */
  today: ISODate;
  /** Freshness of the source. `lastLogDate` is the newest task-log date ≤ today. */
  watermark: { lastLogDate: ISODate | null; lastTaskUpdate: string | null };
  /** Task logs are complete from this date through `today` (inclusive). */
  logsFrom: ISODate;
  projects: Project[];
  people: Person[];
  tasks: Task[];
  logs: TaskLog[];
  /** null = the source has no usable issues table for this org. */
  issues: Issue[] | null;
  /** null = the source has no usable purchase-order table for this org. */
  purchaseOrders: PurchaseOrder[] | null;
  /** Human-readable data-quality notes (schema fallbacks, clamped values, etc). */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Query (filters + settings) — mirrored in the URL
// ─────────────────────────────────────────────────────────────────────────────

export interface Settings {
  /** Count open tasks whose planned end has passed as "scheduled" (they still need updates). */
  includeOverdue: boolean;
  /** Working weekdays, 0 = Sunday … 6 = Saturday. Non-working days are not scored. */
  workingDays: number[];
  /** Updation-health band floors, in %. good ≥ good; fair ≥ fair; poor ≥ poor; else critical. */
  bands: { good: number; fair: number; poor: number };
  /** A site / person with no update for this many working days is "silent". */
  silentAfterDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  includeOverdue: false,
  workingDays: [1, 2, 3, 4, 5, 6],
  bands: { good: 80, fair: 50, poor: 25 },
  silentAfterDays: 3,
};

export interface Query {
  org: string;
  /** Empty = all projects (sites) in the org. */
  projects: string[];
  /** Focus day. Defaults to the latest complete day (see `defaultFocusDate`). */
  date: ISODate;
  /** Trend window length in days, ending at `date`. One of 7 | 14 | 30 | 60 | 90. */
  days: number;
  settings: Settings;
}

// ─────────────────────────────────────────────────────────────────────────────
// View models (what the UI renders)
// ─────────────────────────────────────────────────────────────────────────────

export type Band = 'good' | 'fair' | 'poor' | 'critical' | 'none';

/** "X of Y scheduled tasks were updated". pct = null when nothing was scheduled. */
export interface HealthStat {
  scheduled: number;
  updated: number;
  pct: number | null;
  band: Band;
}

export interface DayPoint extends HealthStat {
  date: ISODate;
  /** False for non-working days (still reported, never scored or averaged). */
  working: boolean;
  /** Total updates (log entries) made for that day, any task. */
  entries: number;
}

export type ScheduleHealth = 'on_track' | 'behind' | 'critical' | 'complete' | 'not_started' | 'no_plan';

export interface ProgressStat {
  /** Duration-weighted actual % (0–100). */
  actual: number | null;
  /** Duration-weighted planned % from current schedule dates, as of the focus day. */
  planned: number | null;
  /** actual − planned, percentage points. */
  deviation: number | null;
  /** Earned-schedule days behind: focus day − first day the plan reached today's actual %. */
  daysBehind: number | null;
  /** Change in daysBehind over the last 28 days (+ = slipping). */
  slip28: number | null;
  health: ScheduleHealth;
  /** Planned finish (max task end). */
  plannedFinish: ISODate | null;
}

/** Mutually exclusive task buckets as of the focus day; they sum to `total`. */
export interface StatusCounts {
  total: number;
  /** pct ≥ 100 (or actual end ≤ focus day). */
  completed: number;
  /** Not complete and planned end < focus day. */
  overdue: number;
  /** Not complete, not overdue, and started (pct > 0 or actual start ≤ focus day). */
  ongoing: number;
  /** Not complete, not overdue, not started, but planned start ≤ focus day — should have started. */
  lateStart: number;
  /** Not started, planned start within the next 7 days. */
  upcoming: number;
  /** Not started, planned start more than 7 days out. */
  later: number;
  /** No planned dates. */
  undated: number;
}

export interface SiteRow {
  projectId: string;
  name: string;
  /** Focus-day updation. */
  day: HealthStat;
  /** Window aggregate (sum of updated / sum of scheduled over working days). */
  window: HealthStat;
  /** Previous window of equal length, for the delta. */
  prevWindow: HealthStat;
  /** Aligned to DashboardPayload.trend dates. */
  daily: HealthStat[];
  lastUpdate: ISODate | null;
  /** Working days since the last update, relative to the focus day. */
  daysSinceUpdate: number | null;
  silent: boolean;
  /** Distinct people who logged updates on this site in the window. */
  activeUpdaters: number;
  /** Distinct people assigned to scheduled tasks on this site in the window. */
  assignedPeople: number;
  progress: ProgressStat;
  tasks: StatusCounts;
  openIssues: number | null;
  /** Scheduled on the focus day but not updated. */
  pendingToday: number;
}

export type PersonStatus = 'active' | 'irregular' | 'silent' | 'never';

export interface PersonRow {
  personId: string;
  name: string;
  projectIds: string[];
  /** As assignee: tasks scheduled for them vs updated (window). */
  assigned: HealthStat;
  /** As assignee, focus day. */
  assignedDay: HealthStat;
  /** Log entries this person made in the window (any task). */
  updatesMade: number;
  /** Distinct tasks this person updated in the window. */
  tasksTouched: number;
  /** Working days in the window with ≥ 1 entry by this person. */
  activeDays: number;
  workingDaysInWindow: number;
  lastActive: ISODate | null;
  daysSinceActive: number | null;
  /** Entries on the focus day. */
  dayEntries: number;
  /** Assigned, scheduled on focus day, not updated. */
  pendingToday: number;
  /** Share of entries made > 1 day after the date they report (back-filled). */
  backfilledShare: number | null;
  status: PersonStatus;
}

export interface ActivityItem {
  id: string;
  date: ISODate;
  createdAt: string | null;
  personId: string | null;
  personName: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  taskPath: string;
  pctBefore: number | null;
  pctAfter: number | null;
  note: string | null;
  photos: number;
  /** Entry made more than 1 day after the work date. */
  backfilled: boolean;
}

export type InsightSeverity = 'critical' | 'warning' | 'good' | 'info';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  /** One sentence, plain language, with the number in it. */
  title: string;
  /** Optional second line: who / what to do next. */
  detail: string | null;
  target: { view: ViewId; projectId?: string; personId?: string };
}

export type ViewId = 'overview' | 'updates' | 'sites' | 'team' | 'activity' | 'procurement';

export interface ProcurementBlock {
  stages: { stage: PoStage; label: string; count: number; amount: number }[];
  pendingApproval: { count: number; amount: number; oldestDays: number | null };
  /** Approved (ordered + partially + delivered) in the window, by created date. */
  approvedInWindow: { count: number; amount: number };
  openDeliveries: { count: number; amount: number };
  byProject: {
    projectId: string;
    name: string;
    count: number;
    amount: number;
    pending: number;
    pendingAmount: number;
  }[];
  /** Pending-approval POs, oldest first (max 50). */
  pendingList: (PurchaseOrder & { projectName: string; ageDays: number })[];
  /** Weekly count/amount of POs created, aligned to the window. */
  weekly: { weekStart: ISODate; count: number; amount: number }[];
}

export interface DashboardPayload {
  meta: {
    org: Org;
    source: Dataset['source'];
    generatedAt: string;
    today: ISODate;
    /** The focus day actually used. */
    date: ISODate;
    /** Latest day with complete data (min(today − 1, watermark)). */
    latestCompleteDate: ISODate;
    windowFrom: ISODate;
    windowTo: ISODate;
    /** Earliest selectable focus date (logsFrom + 28 so slip math is valid). */
    minDate: ISODate;
    watermark: Dataset['watermark'];
    warnings: string[];
    projects: { id: string; name: string }[];
    query: Query;
  };
  headline: {
    /** Focus day, all selected sites. */
    day: HealthStat;
    window: HealthStat;
    prevWindow: HealthStat;
    progress: ProgressStat;
    sites: { total: number; reporting: number; silent: number; critical: number };
    people: { total: number; active: number; silent: number };
    tasks: StatusCounts;
    issues: { open: number; agedOver30: number } | null;
    procurement: { pendingCount: number; pendingAmount: number } | null;
  };
  insights: Insight[];
  /** One point per calendar day in the window (non-working days flagged). */
  trend: DayPoint[];
  sites: SiteRow[];
  people: PersonRow[];
  /** Newest first, entries dated ≤ focus day within the window (max 300). */
  activity: ActivityItem[];
  procurement: ProcurementBlock | null;
}

export interface TaskRef {
  id: string;
  name: string;
  path: string;
  projectId: string;
  projectName: string;
  assignees: { id: string; name: string }[];
  start: ISODate | null;
  end: ISODate | null;
  pct: number;
  /** Working days past planned end (overdue) — 0 when not late. */
  daysLate: number;
  lastUpdate: ISODate | null;
  lastUpdatedBy: string | null;
}

export interface IssueRef {
  id: string;
  title: string;
  isOpen: boolean;
  createdAt: ISODate | null;
  ageDays: number | null;
  creatorName: string | null;
  tags: string[];
}

export interface SiteDetail {
  site: SiteRow;
  /** Weekly planned vs actual over the window (+ planned to finish). */
  curve: { date: ISODate; planned: number | null; actual: number | null }[];
  /** Scheduled on focus day, not updated. Sorted by assignee then schedule order. */
  pending: TaskRef[];
  /** Scheduled on focus day and updated. */
  updated: TaskRef[];
  /** Worst first, max 100. */
  overdue: TaskRef[];
  /** Starting in the next 7 days. */
  upcoming: TaskRef[];
  team: PersonRow[];
  activity: ActivityItem[];
  issues: IssueRef[] | null;
}

export interface PersonDetail {
  person: PersonRow;
  pending: TaskRef[];
  overdue: TaskRef[];
  daily: DayPoint[];
  activity: ActivityItem[];
  bySite: { projectId: string; name: string; assigned: HealthStat; updatesMade: number }[];
}

export interface HealthResponse {
  ok: boolean;
  source: 'clickhouse' | 'demo';
  clickhouse: {
    configured: boolean;
    host: string | null;
    database: string;
    reachable: boolean | null;
    error: string | null;
  };
  /** Per-table: resolved column mapping + missing optional columns. */
  schema: Record<string, { present: boolean; resolved: Record<string, string | null>; notes: string[] }>;
  cache: { org: string; ageSeconds: number; rows: Record<string, number> }[];
}
