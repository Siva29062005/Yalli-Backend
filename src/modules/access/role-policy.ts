import { Permission, RoleName } from './permissions.js';

export interface PolicyActor {
  userId: string;
  maxRank: number;
  roleNames: readonly string[];
  permissions: ReadonlySet<string>;
}

export interface RoleRef {
  name: string;
  rank: number;
  permissions: readonly string[];
}

export type PolicyDecision =
  { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
const ALLOW: PolicyDecision = { allowed: true };

const isSuperAdmin = (a: PolicyActor) =>
  a.roleNames.includes(RoleName.SuperAdmin);

/**
 * Pure decision logic for changing another user's roles. Prevents:
 *  - self-escalation (nobody edits their own roles),
 *  - vertical escalation (cannot grant/revoke a role ranked >= your own, nor touch a user ranked >= you),
 *  - permission laundering (cannot hand out a role that carries permissions you do not hold).
 * SUPER_ADMIN is the only actor allowed to manage equal-or-higher ranks.
 */
export function canChangeRole(
  actor: PolicyActor,
  target: { userId: string; currentMaxRank: number },
  role: RoleRef,
): PolicyDecision {
  if (!actor.permissions.has(Permission.UsersManage))
    return deny('missing users.manage');
  if (actor.userId === target.userId)
    return deny('cannot change your own roles');
  if (isSuperAdmin(actor)) return ALLOW;
  if (role.rank >= actor.maxRank)
    return deny('role ranks at or above your own');
  if (target.currentMaxRank >= actor.maxRank)
    return deny('target user ranks at or above you');
  const missing = role.permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0)
    return deny('role carries permissions you do not hold');
  return ALLOW;
}

/** Suspending/restoring accounts follows the same rank rules (and never applies to yourself). */
export function canChangeUserStatus(
  actor: PolicyActor,
  target: { userId: string; currentMaxRank: number },
): PolicyDecision {
  if (
    !actor.permissions.has(Permission.UsersManage) &&
    !actor.permissions.has(Permission.CustomersSuspend)
  ) {
    return deny('missing users.manage or customers.suspend');
  }
  if (actor.userId === target.userId)
    return deny('cannot change your own status');
  if (isSuperAdmin(actor)) return ALLOW;
  if (target.currentMaxRank >= actor.maxRank)
    return deny('target user ranks at or above you');
  return ALLOW;
}
