// scimkit/verify: replay the requests real provisioning clients send against a SCIM endpoint.

import { PROFILES } from './profiles.js';
import {
  type CheckResult,
  type ProfileName,
  runProfiles,
  type VerifyOptions,
  type VerifyReport,
} from './runner.js';

export type { CheckResult, ProfileName, VerifyOptions, VerifyReport } from './runner.js';
export { entraProfile, oktaProfile, rfcProfile } from './profiles.js';

export const PROFILE_NAMES: readonly ProfileName[] = ['rfc', 'okta', 'entra'];

/**
 * Runs the checks of the chosen profiles against a SCIM endpoint: `rfc` (the
 * core protocol), `okta` and `entra` (the request sequences those identity
 * providers send). Resources the checks create are deleted afterwards.
 *
 * The profiles reproduce the documented request shapes of each client; they
 * are not a substitute for testing with a real tenant before you go live.
 */
export function verifyScimEndpoint(options: VerifyOptions): Promise<VerifyReport> {
  const names = options.profiles ?? PROFILE_NAMES;
  for (const name of names) {
    if (!PROFILE_NAMES.includes(name))
      throw new TypeError(`Unknown profile "${name}"; use rfc, okta or entra.`);
  }
  return runProfiles(
    names.map((name) => PROFILES[name]),
    options,
  );
}

const TITLES: Record<ProfileName, string> = {
  rfc: 'SCIM 2.0 core protocol (RFC 7643, RFC 7644)',
  okta: 'Okta provisioning',
  entra: 'Microsoft Entra ID provisioning',
};

/** A human-readable report, grouped by profile. */
export function formatReport(report: VerifyReport, options: { color?: boolean } = {}): string {
  const paint = (code: string) => (text: string) =>
    options.color === true ? `\u001b[${code}m${text}\u001b[0m` : text;
  const green = paint('32');
  const red = paint('31');
  const dim = paint('2');
  const bold = paint('1');
  const lines: string[] = [bold(`SCIM checks against ${report.baseUrl}`)];
  let profile: ProfileName | undefined;
  for (const check of report.checks) {
    if (check.profile !== profile) {
      profile = check.profile;
      lines.push('', bold(TITLES[profile]));
    }
    const mark = check.status === 'passed' ? green('✔') : check.status === 'failed' ? red('✖') : dim('–');
    const time = check.durationMs > 0 ? dim(` ${check.durationMs}ms`) : '';
    lines.push(`  ${mark} ${check.name}${time}`);
    if (check.detail !== undefined && check.status !== 'passed') {
      lines.push(`      ${check.status === 'failed' ? red(check.detail) : dim(check.detail)}`);
    }
  }
  lines.push('');
  const summary = `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped in ${(report.durationMs / 1000).toFixed(1)}s`;
  lines.push(report.failed > 0 ? red(summary) : green(summary));
  if (report.cleanup.failed.length > 0) {
    lines.push(red(`Could not delete: ${report.cleanup.failed.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}

/** Narrows a check result list to the failures. */
export function failures(report: VerifyReport): CheckResult[] {
  return report.checks.filter((check) => check.status === 'failed');
}
