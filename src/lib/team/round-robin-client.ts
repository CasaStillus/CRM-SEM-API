/**
 * Browser-side calls for the lead rotation (migration 053).
 *
 * Both settings change only through database functions that check who
 * may change what: anyone can mark themselves unavailable, an admin can
 * do it for anyone, and only an admin decides who is in the rotation.
 */

import { createClient } from '@/lib/supabase/client';

export interface RotationMember {
  user_id: string;
  full_name: string | null;
  account_role: string;
  round_robin_enabled: boolean;
  is_available: boolean;
}

/** PostgREST / Postgres codes for "this column or function does not exist". */
function isMissingSchema(error: { code?: string } | null): boolean {
  return (
    !!error &&
    ['42703', 'PGRST204', 'PGRST202', '42883'].includes(error.code ?? '')
  );
}

export type RotationLoad =
  | { status: 'ok'; members: RotationMember[] }
  | { status: 'migration_missing' }
  | { status: 'error' };

export async function loadRotationMembers(accountId: string): Promise<RotationLoad> {
  const { data, error } = await createClient()
    .from('profiles')
    .select('user_id, full_name, account_role, round_robin_enabled, is_available, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (isMissingSchema(error)) return { status: 'migration_missing' };
  if (error || !data) return { status: 'error' };
  return { status: 'ok', members: data as RotationMember[] };
}

export async function loadOwnAvailability(
  userId: string
): Promise<boolean | null> {
  const { data, error } = await createClient()
    .from('profiles')
    .select('is_available')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { is_available: boolean }).is_available;
}

export async function setAvailability(
  userId: string,
  available: boolean
): Promise<boolean> {
  const { error } = await createClient().rpc('set_member_availability', {
    p_user_id: userId,
    p_available: available,
  });
  if (error) console.error('[round-robin] availability change failed:', error.message);
  return !error;
}

export async function setInRotation(
  userId: string,
  enabled: boolean
): Promise<boolean> {
  const { error } = await createClient().rpc('set_member_round_robin', {
    p_user_id: userId,
    p_enabled: enabled,
  });
  if (error) console.error('[round-robin] rotation change failed:', error.message);
  return !error;
}
