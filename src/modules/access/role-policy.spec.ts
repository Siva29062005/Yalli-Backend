import {
  ALL_PERMISSIONS,
  Permission,
  ROLE_DEFINITIONS,
  RoleName,
  type RoleNameValue,
} from './permissions.js';
import {
  canAssignRole,
  canChangeRole,
  canChangeUserStatus,
  type PolicyActor,
  type RoleRef,
} from './role-policy.js';

const actorFor = (role: RoleNameValue, userId = 'actor'): PolicyActor => ({
  userId,
  maxRank: ROLE_DEFINITIONS[role].rank,
  roleNames: [role],
  permissions: new Set(ROLE_DEFINITIONS[role].permissions),
});
const roleRef = (role: RoleNameValue): RoleRef => ({
  name: role,
  rank: ROLE_DEFINITIONS[role].rank,
  permissions: ROLE_DEFINITIONS[role].permissions,
});
const target = (role: RoleNameValue, userId = 'target') => ({
  userId,
  currentMaxRank: ROLE_DEFINITIONS[role].rank,
});

describe('role matrix invariants', () => {
  it('SUPER_ADMIN holds every permission', () => {
    expect([...ROLE_DEFINITIONS.SUPER_ADMIN.permissions].sort()).toEqual(
      [...ALL_PERMISSIONS].sort(),
    );
  });
  it('CUSTOMER holds no permission', () => {
    expect(ROLE_DEFINITIONS.CUSTOMER.permissions).toHaveLength(0);
  });
  it('only SUPER_ADMIN may manage roles/permissions', () => {
    for (const [name, def] of Object.entries(ROLE_DEFINITIONS)) {
      const has =
        def.permissions.includes(Permission.RolesManage) ||
        def.permissions.includes(Permission.PermissionsManage);
      expect(has).toBe(name === RoleName.SuperAdmin);
    }
  });
  it('refund approval is limited to FINANCE_MANAGER and SUPER_ADMIN', () => {
    const holders = Object.entries(ROLE_DEFINITIONS)
      .filter(([, d]) => d.permissions.includes(Permission.RefundsApprove))
      .map(([n]) => n);
    expect(holders.sort()).toEqual(['FINANCE_MANAGER', 'SUPER_ADMIN']);
  });
  it('support can request but not approve refunds', () => {
    expect(ROLE_DEFINITIONS.CUSTOMER_SUPPORT.permissions).toContain(
      Permission.RefundsCreate,
    );
    expect(ROLE_DEFINITIONS.CUSTOMER_SUPPORT.permissions).not.toContain(
      Permission.RefundsApprove,
    );
  });
  it('every permission referenced by a role exists in the catalogue', () => {
    for (const def of Object.values(ROLE_DEFINITIONS))
      for (const p of def.permissions) expect(ALL_PERMISSIONS).toContain(p);
  });
});

describe('canChangeRole', () => {
  it('lets ADMIN grant a lower-ranked staff role to a customer', () => {
    expect(
      canChangeRole(
        actorFor('ADMIN'),
        target('CUSTOMER'),
        roleRef('PRODUCT_MANAGER'),
      ).allowed,
    ).toBe(true);
  });
  it('blocks self-change, even for SUPER_ADMIN', () => {
    expect(
      canChangeRole(
        actorFor('SUPER_ADMIN', 'me'),
        target('CUSTOMER', 'me'),
        roleRef('ADMIN'),
      ),
    ).toMatchObject({ allowed: false });
  });
  it('blocks ADMIN from granting ADMIN or SUPER_ADMIN (vertical escalation)', () => {
    expect(
      canChangeRole(actorFor('ADMIN'), target('CUSTOMER'), roleRef('ADMIN'))
        .allowed,
    ).toBe(false);
    expect(
      canChangeRole(
        actorFor('ADMIN'),
        target('CUSTOMER'),
        roleRef('SUPER_ADMIN'),
      ).allowed,
    ).toBe(false);
  });
  it('blocks ADMIN from modifying a peer or a SUPER_ADMIN', () => {
    expect(
      canChangeRole(actorFor('ADMIN'), target('ADMIN'), roleRef('CUSTOMER'))
        .allowed,
    ).toBe(false);
    expect(
      canChangeRole(
        actorFor('ADMIN'),
        target('SUPER_ADMIN'),
        roleRef('CUSTOMER'),
      ).allowed,
    ).toBe(false);
  });
  it('blocks actors without users.manage', () => {
    expect(
      canChangeRole(
        actorFor('PRODUCT_MANAGER'),
        target('CUSTOMER'),
        roleRef('CUSTOMER'),
      ).allowed,
    ).toBe(false);
    expect(
      canChangeRole(
        actorFor('CUSTOMER'),
        target('CUSTOMER'),
        roleRef('CUSTOMER'),
      ).allowed,
    ).toBe(false);
  });
  it('blocks handing out permissions the actor lacks even at a lower rank', () => {
    // ADMIN lacks refunds.approve, which FINANCE_MANAGER (rank 50 < 80) carries.
    const res = canChangeRole(
      actorFor('ADMIN'),
      target('CUSTOMER'),
      roleRef('FINANCE_MANAGER'),
    );
    expect(res).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('permissions you do not hold'),
    });
  });
  it('lets SUPER_ADMIN grant any role to another user', () => {
    expect(
      canChangeRole(
        actorFor('SUPER_ADMIN'),
        target('CUSTOMER'),
        roleRef('SUPER_ADMIN'),
      ).allowed,
    ).toBe(true);
    expect(
      canChangeRole(
        actorFor('SUPER_ADMIN'),
        target('ADMIN'),
        roleRef('FINANCE_MANAGER'),
      ).allowed,
    ).toBe(true);
  });
});

describe('canChangeUserStatus', () => {
  it('ADMIN may suspend a customer but not a peer, a super admin, or themselves', () => {
    expect(
      canChangeUserStatus(actorFor('ADMIN'), target('CUSTOMER')).allowed,
    ).toBe(true);
    expect(
      canChangeUserStatus(actorFor('ADMIN'), target('ADMIN')).allowed,
    ).toBe(false);
    expect(
      canChangeUserStatus(actorFor('ADMIN'), target('SUPER_ADMIN')).allowed,
    ).toBe(false);
    expect(
      canChangeUserStatus(actorFor('ADMIN', 'x'), target('CUSTOMER', 'x'))
        .allowed,
    ).toBe(false);
  });
  it('a plain customer cannot suspend anyone', () => {
    expect(
      canChangeUserStatus(actorFor('CUSTOMER'), target('CUSTOMER')).allowed,
    ).toBe(false);
  });
});

describe('canAssignRole (which roles the console offers)', () => {
  const roles = Object.keys(ROLE_DEFINITIONS) as RoleNameValue[];

  it('agrees with canChangeRole for any lower-ranked target that is not the actor', () => {
    for (const a of roles)
      for (const r of roles) {
        const actor = actorFor(a);
        const lowest = target('CUSTOMER');
        expect(canAssignRole(actor, roleRef(r)).allowed).toBe(
          canChangeRole(actor, lowest, roleRef(r)).allowed,
        );
      }
  });

  it('SUPER_ADMIN may assign every role, a role without users.manage none', () => {
    for (const r of roles) {
      expect(canAssignRole(actorFor('SUPER_ADMIN'), roleRef(r)).allowed).toBe(
        true,
      );
      expect(canAssignRole(actorFor('CUSTOMER'), roleRef(r)).allowed).toBe(
        false,
      );
    }
  });

  it('never offers a role ranked at or above the actor, or one with permissions the actor lacks', () => {
    for (const a of roles.filter((x) => x !== 'SUPER_ADMIN'))
      for (const r of roles) {
        const actor = actorFor(a);
        const role = roleRef(r);
        if (
          role.rank >= actor.maxRank ||
          role.permissions.some((p) => !actor.permissions.has(p))
        )
          expect(canAssignRole(actor, role).allowed).toBe(false);
      }
  });
});
