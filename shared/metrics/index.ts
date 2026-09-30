/**
 * Metrics engine public API. Pure functions: Dataset + Query in, view models out.
 * Implements docs/METRICS.md exactly. (Implementation in progress.)
 */
import type { Dataset, DashboardPayload, ISODate, PersonDetail, Query, SiteDetail } from '../types.ts';

export declare function defaultFocusDate(ds: Dataset): ISODate;
export declare function buildDashboard(ds: Dataset, q: Query): DashboardPayload;
export declare function buildSiteDetail(ds: Dataset, q: Query, projectId: string): SiteDetail;
export declare function buildPersonDetail(ds: Dataset, q: Query, personId: string): PersonDetail;
