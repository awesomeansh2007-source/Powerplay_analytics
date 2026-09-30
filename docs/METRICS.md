# Metric definitions

Every number on the dashboard is defined here. The engine in `shared/metrics/` implements
exactly these rules, and the in-app "How is this calculated?" panels quote them. If a
rule changes, change it here first.

Conventions:

- **Dates** are on the IST calendar (`Asia/Kolkata`). Powerplay stores a task-log date
  as IST midnight (18:30 UTC the day before), so converting to IST before taking the
  date is mandatory.
- **Focus day (D)** is the day being reviewed. It defaults to the *latest complete day*:
  `min(today − 1, newest task-log date)`. The analytics copy of the database trails the
  app by about one day, so "today" would always look empty.
- **Window** is the N days ending on D (N = 7 / 14 / 30 / 60 / 90, default 14). The
  **previous window** is the N days immediately before it.
- **Working days** default to Monday–Saturday (configurable). Non-working days are shown
  but never scored, and they never count toward "days since last update".
- **Leaf tasks only.** A task is included when it is active (`is_active != false`) and a
  leaf of the schedule (`type = 0`). Parent rows are roll-ups and would double-count.
- **Percent complete** is clamped to 0–100, because the source can exceed 100.

---

## 1. Updation health — "are sites updating their tasks?"

### Scheduled task (on working day `d`)

A leaf task is **scheduled on `d`** when all of these hold:

1. It has planned `start` and `end` dates, and `start ≤ d`.
2. `d ≤ end`. If *Include overdue tasks* is on (it is off by default), a task past its
   planned end also stays scheduled while it is still open.
3. It was not already complete before `d`. The completion date is the first of these
   that exists:
   - the actual end date;
   - the date of the first log that reached 100%;
   - `logsFrom − 1`, when the task is at 100% with no log in the loaded window.

   If the task was completed *on* `d`, it still counts as scheduled that day.

### Updated task (on `d`)

A scheduled task is **updated on `d`** when it has at least one task-log entry dated `d`,
entered by anyone. A "no progress" entry (0% change) counts: the site reported, and
reporting is the thing being measured.

### Updation health %

```
day health    = updated tasks on D / scheduled tasks on D
window health = Σ updated / Σ scheduled, summed over every working day in the window (task-days)
```

It is shown as "**20 of 100** scheduled tasks updated · **20%**".

- If nothing is scheduled, the health is `—` (null), not 0%.
- **Bands** (configurable): Good ≥ 80% · Fair ≥ 50% · Poor ≥ 25% · Critical < 25%.
- The **delta** is window health compared with the previous window, in percentage points.

### Site freshness

- **Last update** is the newest log date ≤ D for the site, counting any task.
- **Days since update** is the number of working days after the last update, up to and
  including D. A site that updated on D shows 0.
- A site is **Silent** when its days since update ≥ the silent threshold (default 3
  working days), or when it had scheduled work in the window and never logged.
- A site is **Reporting** when it has at least one update dated D.

## 2. People — "who is updating, and who isn't?"

A person enters the list if either is true:
- they are assigned to a task that was scheduled in the window, on the selected sites; or
- they made a log entry there in the window.

| Metric | Rule |
|---|---|
| **Assigned health** | Updation health over only the tasks this person is assigned to. The update can come from anyone. |
| **Updates made** | The person's log entries in the window, on any task. |
| **Tasks touched** | Distinct tasks the person updated in the window. |
| **Active days** | Working days in the window on which the person made at least one entry. |
| **Last active** | Newest entry date ≤ D. **Days since active** is counted in working days, as for sites. |
| **Pending today** | Assigned tasks that were scheduled on D and not updated. This is the follow-up list. |
| **Back-filled share** | Entries made more than one day after the date they report, divided by entries whose entry time is known. |

**Status**, checked in this order:
1. **Never logged**: assigned scheduled work, but no entries at all in the loaded history.
2. **Silent**: days since active ≥ the silent threshold.
3. **Irregular**: active on fewer than half the working days in the window.
4. **Active**: everyone else.

## 3. Progress — "where does each site stand against plan?"

These are the same formulas used by the Adarsh and Continuum dashboards, reconciled
against the app.

- **Actual %** = Σ(duration × % complete) / Σ duration, over leaf tasks. It equals
  `projects.project_progress` in the app. On a past focus day, each task's % is its last
  logged value on or before that day.
- **Planned %** as of D = Σ(duration × f) / Σ duration, over leaf tasks with dates.
  f is worked out per task:
  - 0 when D < start;
  - 1 when D ≥ end;
  - otherwise `(D − start + 1) / (end − start + 1)`, counting calendar days inclusively.
- **Deviation** = Actual − Planned, in percentage points.
- **Days behind** (earned schedule) = D − the first date on which Planned % ≥ today's
  Actual %. It is 0 when the site is at or ahead of plan.
- **Slip (4 weeks)** = days behind today − days behind 28 days ago. A positive number
  means the site is slipping.
- **Schedule health:**
  - *No plan*: no dated tasks.
  - *Complete*: Actual % reaches 100.
  - *Not due*: nothing is planned yet (Planned % = 0).
  - Otherwise, by days behind: *On track* ≤ 30 · *Behind* 31–90 · *Critical* > 90.

  These are the bands already agreed with Continuum.

### Task status buckets (as of D; mutually exclusive)

| Bucket | Rule |
|---|---|
| Completed | % complete = 100, or actual end ≤ D |
| Overdue | not complete, and planned end < D |
| Ongoing | not complete, not overdue, and started (% > 0 or actual start ≤ D) |
| Late start | not started, planned start ≤ D, and not overdue |
| Upcoming | not started, planned start in (D, D + 7] |
| Later | not started, planned start > D + 7 |
| Undated | no planned dates |

For an overdue task, **Days late** is the working days from its planned end to D.

## 4. Issues

Issues are open and closed **threads**, counted per site. **Aged** means open for more
than 30 days.

## 5. Procurement (purchase orders)

Each purchase order is placed in a stage based on its `po_status_value`:

| Stage | Raw values (case-insensitive) |
|---|---|
| Draft | DRAFT |
| Pending approval | APPROVAL PENDING, PENDING |
| Ordered | ORDERED, APPROVED |
| Partially delivered | PARTIALLY DELIVERED, PARTIALLY_DELIVERED |
| Delivered | DELIVERED |
| Rejected | REJECTED |

- **Approved** means Ordered, Partially delivered or Delivered, which matches the Dhinwa
  ledger.
- **Amount** is the PO total including tax (`financial_details_total_amount`).
- **Pending approval age** is D minus the date the PO was created.
- **Open deliveries** are POs that are Ordered or Partially delivered.

## 6. Insights

Insights are short sentences generated by rules. Each one carries its number and links to
the view where you can act on it. They are ranked critical → warning → good → info, with
at most 8 shown.

| Rule | Severity |
|---|---|
| Sites silent for ≥ threshold working days (names listed) | critical |
| Worst site on D with ≥ 5 scheduled tasks and a Critical band, plus who has most pending | critical |
| People with pending tasks who have been silent ≥ threshold | warning |
| Window health vs previous window moved ≥ 10 pp | warning (down) / good (up) |
| Sites more than 90 days behind plan | critical |
| Site that slipped ≥ 7 days in 4 weeks (worst one) | warning |
| Late-start tasks on the selected sites | warning (≥ 10) |
| POs waiting for approval longer than 3 days | warning |
| Open issues older than 30 days | warning |
| A site that updated ≥ 95% of ≥ 5 scheduled tasks on D | good |
