// Plans bound what one workspace may consume. `null` means unlimited. A self-hosted deployment keeps the default `enterprise`
// plan (no per-workspace limits); a SaaS operator sets DEFAULT_PLAN=free and moves customers with the admin CLI.
export const PLANS = Object.freeze({
  free: { members: 3, gateways: 1, apiKeys: 2, webhooks: 1, queuedJobs: 50, jobsPerMonth: 500, reportsPerMonth: 100, requestsPerMinute: 120 },
  team: { members: 15, gateways: 5, apiKeys: 10, webhooks: 5, queuedJobs: 500, jobsPerMonth: 10_000, reportsPerMonth: 2_000, requestsPerMinute: 600 },
  business: { members: 100, gateways: 50, apiKeys: 50, webhooks: 25, queuedJobs: 5_000, jobsPerMonth: 200_000, reportsPerMonth: 50_000, requestsPerMinute: 3_000 },
  enterprise: { members: null, gateways: null, apiKeys: null, webhooks: null, queuedJobs: null, jobsPerMonth: null, reportsPerMonth: null, requestsPerMinute: null }
});

export const PLAN_NAMES = Object.freeze(Object.keys(PLANS));
export const isPlan = (name) => Object.hasOwn(PLANS, name);
// A plan name stored by a newer version must not make the workspace unusable: unknown plans get the most restrictive limits.
export const limitsFor = (name) => PLANS[isPlan(name) ? name : "free"];
