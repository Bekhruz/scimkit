import { randomBytes } from 'node:crypto';
import { ScimClient, type CheckResponse } from './client.js';

export type ProfileName = 'rfc' | 'okta' | 'entra';

export interface CheckResult {
  readonly profile: ProfileName;
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly detail?: string;
  readonly durationMs: number;
}

export interface VerifyReport {
  readonly baseUrl: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly checks: readonly CheckResult[];
  /** Resources the checks created and then deleted, and the ones that could not be deleted. */
  readonly cleanup: { readonly deleted: number; readonly failed: readonly string[] };
}

export interface VerifyOptions {
  /** Absolute URL of the SCIM root, such as `https://app.example.com/scim/v2`. */
  baseUrl: string;
  /** Bearer token sent with every request. */
  token?: string;
  /** Extra headers sent with every request. */
  headers?: Readonly<Record<string, string>>;
  /** Which client behaviours to replay. Default all: rfc, okta, entra. */
  profiles?: readonly ProfileName[];
  /** Fetch implementation, for example to call an in-process handler. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Leave created resources in place. Default false. */
  keep?: boolean;
  /** Prefix of the names of created resources. Default `scimkit-verify-<random>`. */
  prefix?: string;
  /** Called after each check, for progress output. */
  onCheck?: (result: CheckResult) => void;
}

/** Fails the current check. */
export class CheckFailure extends Error {}
/** Skips the current check, for example when the server does not advertise a feature. */
export class CheckSkipped extends Error {}

export interface StepContext {
  readonly client: ScimClient;
  /** Values earlier steps of the same profile recorded, such as ids. */
  readonly state: Map<string, string>;
  readonly endpoints: { readonly users: string; readonly groups: string };
  readonly features: { readonly etag: boolean };
  /** A unique name for a test resource. */
  name(label: string): string;
  /** Records a created resource for cleanup, by path such as `/Users/<id>`. */
  created(path: string): void;
  /** Records that a resource was deleted by the checks themselves. */
  deleted(path: string): void;
}

export interface Step {
  readonly name: string;
  /** State keys this step needs; when one is missing the step is skipped. */
  readonly needs?: readonly string[];
  run(context: StepContext): Promise<void>;
}

export interface Profile {
  readonly name: ProfileName;
  readonly title: string;
  readonly steps: readonly Step[];
}

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';

async function discover(
  client: ScimClient,
): Promise<{ endpoints: StepContext['endpoints']; features: StepContext['features'] }> {
  const endpoints = { users: '/Users', groups: '/Groups' };
  const features = { etag: false };
  const safely = async (path: string): Promise<CheckResponse | undefined> => {
    try {
      return await client.request('GET', path);
    } catch {
      return undefined;
    }
  };
  const types = await safely('/ResourceTypes');
  const resources = (types?.body as { Resources?: unknown } | undefined)?.Resources;
  if (Array.isArray(resources)) {
    for (const resource of resources as { schema?: unknown; endpoint?: unknown }[]) {
      if (typeof resource.endpoint !== 'string') continue;
      if (resource.schema === USER) endpoints.users = resource.endpoint;
      if (resource.schema === GROUP) endpoints.groups = resource.endpoint;
    }
  }
  const config = await safely('/ServiceProviderConfig');
  features.etag = (config?.body as { etag?: { supported?: unknown } } | undefined)?.etag?.supported === true;
  return { endpoints, features };
}

/** Runs profiles of checks against a SCIM endpoint and reports the results. */
export async function runProfiles(
  profiles: readonly Profile[],
  options: VerifyOptions,
): Promise<VerifyReport> {
  const started = Date.now();
  const client = new ScimClient({
    baseUrl: options.baseUrl,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  const prefix = options.prefix ?? `scimkit-verify-${randomBytes(3).toString('hex')}`;
  const { endpoints, features } = await discover(client);
  const created: string[] = [];
  const checks: CheckResult[] = [];

  for (const profile of profiles) {
    const state = new Map<string, string>();
    const context: StepContext = {
      client,
      state,
      endpoints,
      features,
      name: (label) => `${prefix}-${profile.name}-${label}`,
      created: (path) => {
        if (!created.includes(path)) created.push(path);
      },
      deleted: (path) => {
        const index = created.indexOf(path);
        if (index !== -1) created.splice(index, 1);
      },
    };
    for (const step of profile.steps) {
      const missing = (step.needs ?? []).filter((key) => !state.has(key));
      const stepStarted = Date.now();
      let result: CheckResult;
      if (missing.length > 0) {
        result = {
          profile: profile.name,
          name: step.name,
          status: 'skipped',
          detail: `needs ${missing.join(', ')} from an earlier check`,
          durationMs: 0,
        };
      } else {
        try {
          await step.run(context);
          result = {
            profile: profile.name,
            name: step.name,
            status: 'passed',
            durationMs: Date.now() - stepStarted,
          };
        } catch (error) {
          const skipped = error instanceof CheckSkipped;
          result = {
            profile: profile.name,
            name: step.name,
            status: skipped ? 'skipped' : 'failed',
            detail: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - stepStarted,
          };
        }
      }
      checks.push(result);
      options.onCheck?.(result);
    }
  }

  const cleanup = { deleted: 0, failed: [] as string[] };
  if (!(options.keep ?? false)) {
    // Groups first, so that deleting users does not fight with memberships.
    const ordered = [...created].sort(
      (a, b) => Number(b.startsWith(endpoints.groups)) - Number(a.startsWith(endpoints.groups)),
    );
    for (const path of ordered) {
      try {
        const response = await client.request('DELETE', path);
        if (response.status === 204 || response.status === 200 || response.status === 404) cleanup.deleted++;
        else cleanup.failed.push(`${path} (HTTP ${response.status})`);
      } catch (error) {
        cleanup.failed.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  return {
    baseUrl: options.baseUrl,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
    checks,
    cleanup,
  };
}
