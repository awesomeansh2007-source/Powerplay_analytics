/** Deterministic demo data (implementation in progress). */
import type { Dataset, ISODate, Org } from '../types.ts';

export declare function demoOrgs(): Org[];
export declare function demoDataset(orgId: string, today: ISODate): Dataset;
