/** Only verified ID-token claims may be passed here. Invalid/missing claims leave Ask available. */
export function posixIdentity(claims, {uidClaim = 'uidNumber', gidClaim = 'gidNumber', usernameClaim = 'preferred_username'} = {}) {
  const number = value => typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : NaN;
  const uid = number(claims[uidClaim]), gid = number(claims[gidClaim]), username = claims[usernameClaim];
  if (!Number.isInteger(uid) || uid <= 0 || uid > 2147483647 || !Number.isInteger(gid) || gid <= 0 || gid > 2147483647
      || typeof username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || ['root', 'nobody'].includes(username)) return null;
  return {username, uid, gid};
}
