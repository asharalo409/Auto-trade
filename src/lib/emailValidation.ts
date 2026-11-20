// Server-side email checks via ApyHub (format, MX/domain and disposable domains).
// The APY_TOKEN stays on the server; this module only talks to our own proxy route.
// NOTE: this confirms the address can receive mail — it does NOT verify mailbox ownership.

export type EmailCheckStatus =
  | 'valid'
  | 'invalid'
  | 'unavailable'
  | 'not_configured'
  | 'invalid_input';

export interface EmailCheckResult {
  ok: boolean;
  status: EmailCheckStatus;
  data: boolean | null;
  detail?: string;
  upstreamStatus?: number | null;
}

export async function checkEmailWithApyhub(
  email: string,
  options: { disposableChecks?: boolean } = {}
): Promise<EmailCheckResult> {
  try {
    const res = await fetch('/api/email/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        disposable_checks: options.disposableChecks !== false,
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Partial<EmailCheckResult>;
    if (!payload || typeof payload.status !== 'string') {
      return {
        ok: false,
        status: 'unavailable',
        data: null,
        detail: `Validation service returned HTTP ${res.status}`,
      };
    }
    return {
      ok: Boolean(payload.ok),
      status: payload.status,
      data: typeof payload.data === 'boolean' ? payload.data : null,
      detail: payload.detail,
      upstreamStatus: payload.upstreamStatus ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'unavailable',
      data: null,
      detail: err instanceof Error ? err.message : 'Validation service unreachable',
    };
  }
}
