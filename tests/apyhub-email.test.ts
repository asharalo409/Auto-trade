import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APYHUB_EMAIL_URL,
  verifyEmailWithApyhub,
} from '../server.ts';

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('sends the documented request and returns data:true as valid', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: true }));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'test-token' });

    assert.deepEqual(result, { ok: true, status: 'valid', data: true });
    assert.equal(stub.calls.length, 1);
    const [{ url, init }] = stub.calls;
    assert.equal(url, 'https://api.eu.apyhub.com/apyhub/verify-email-validity-and-deliverability');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['apy-token'], 'test-token');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      email: 'operator@aegis.dev',
      disposable_checks: true,
    });
  } finally {
    stub.restore();
  }
});

test('returns data:false as invalid without treating it as an error', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: false }));
  try {
    const result = await verifyEmailWithApyhub('throwaway@mailinator.com', { token: 'test-token' });
    assert.deepEqual(result, { ok: true, status: 'invalid', data: false });
  } finally {
    stub.restore();
  }
});

test('honours an explicit disposable_checks opt-out', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: true }));
  try {
    await verifyEmailWithApyhub('user@temp-mail.org', {
      token: 'test-token',
      disposableChecks: false,
    });
    assert.deepEqual(JSON.parse(String(stub.calls[0].init?.body)), {
      email: 'user@temp-mail.org',
      disposable_checks: false,
    });
  } finally {
    stub.restore();
  }
});

test('reports a 429 rate limit as unavailable, not as an invalid address', async () => {
  const stub = stubFetch(async () => jsonResponse({ message: 'Too many requests' }, 429));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'test-token' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.upstreamStatus, 429);
  } finally {
    stub.restore();
  }
});

test('reports a 5xx upstream failure as unavailable', async () => {
  const stub = stubFetch(async () => jsonResponse({ message: 'boom' }, 503));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'test-token' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.match(String(result.detail), /503/);
  } finally {
    stub.restore();
  }
});

test('reports a timeout as unavailable', async () => {
  const stub = stubFetch(async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'test-token' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.upstreamStatus, 504);
  } finally {
    stub.restore();
  }
});

test('reports a rejected token as unavailable', async () => {
  const stub = stubFetch(async () => jsonResponse({ message: 'Unauthorized' }, 401));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'bad-token' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.match(String(result.detail), /APY_TOKEN/);
  } finally {
    stub.restore();
  }
});

test('skips the network call and reports not_configured when APY_TOKEN is empty', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: true }));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: '' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_configured');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('reports a non-boolean data payload as unavailable', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: 'yes' }));
  try {
    const result = await verifyEmailWithApyhub('operator@aegis.dev', { token: 'test-token' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
  } finally {
    stub.restore();
  }
});
