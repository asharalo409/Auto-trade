/**
 * Turns Supabase Auth's terse messages into the actual reason a registration or
 * login failed. The raw text is always included verbatim so nothing is hidden.
 */
export function describeAuthError(
  message: string | null | undefined,
  context: 'signin' | 'signup'
): string {
  const raw = String(message || '').trim();
  if (!raw) {
    return context === 'signup'
      ? 'Registration failed for an unknown reason (Supabase returned no message).'
      : 'Sign-in failed for an unknown reason (Supabase returned no message).';
  }
  const lower = raw.toLowerCase();

  if (lower.includes('database error saving new user')) {
    return (
      `Supabase could not save your profile row (public.users) while creating the account.\n` +
      `Exact reason reported: “${raw}”.\n` +
      'It was a duplicate email / Telegram chat id left by an earlier rejected registration. ' +
      'That uniqueness rule is now removed and stale rows are cleaned automatically — press Create Account once more. ' +
      'If it still fails, the Postgres detail appears in the worker logs.'
    );
  }

  if (lower.includes('invalid login credentials')) {
    return (
      `Supabase Auth rejected these credentials — exact reason: “${raw}”.\n` +
      'That means no account matches this email + password. If you registered moments ago the profile row may not have been saved; ' +
      'register again with the same email or use “Forgot password” to set a password over Telegram.'
    );
  }

  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return `This email already has an account — exact reason: “${raw}”. Switch to Sign In, or use “Forgot password”.`;
  }

  if (lower.includes('email not confirmed')) {
    return `Your email is not confirmed yet — exact reason: “${raw}”. Use “Forgot password” to set a password over Telegram, or confirm from the email Supabase sent.`;
  }

  if (lower.includes('password') && (lower.includes('weak') || lower.includes('at least'))) {
    return `Password rejected — exact reason: “${raw}”. Use at least 8 characters with a mix of letters and numbers.`;
  }

  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return `Too many attempts — exact reason: “${raw}”. Wait a minute and try again.`;
  }

  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return `Cannot reach Supabase — exact reason: “${raw}”. Check the connection / VITE_SUPABASE_URL and retry.`;
  }

  // Already specific: show it exactly as the server reported it.
  return raw;
}
