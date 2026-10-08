import {test} from 'node:test';
import assert from 'node:assert/strict';
import {posixIdentity} from '../posix-identity.mjs';

test('verified POSIX claims accept configured numeric IDs but never invent IDs or use display names', () => {
  assert.deepEqual(posixIdentity({preferred_username: 'bryce', uidNumber: '12345', gidNumber: 23456}), {username: 'bryce', uid: 12345, gid: 23456});
  assert.deepEqual(posixIdentity({unix_login: 'bryce', unix_uid: 12345, unix_gid: 23456}, {usernameClaim: 'unix_login', uidClaim: 'unix_uid', gidClaim: 'unix_gid'}), {username: 'bryce', uid: 12345, gid: 23456});
  for (const claims of [{}, {name: 'bryce', uidNumber: 12345, gidNumber: 23456},
    {preferred_username: 'root', uidNumber: 1, gidNumber: 1}, {preferred_username: 'bryce; id', uidNumber: 1, gidNumber: 1},
    {preferred_username: 'bryce', uidNumber: 0, gidNumber: 1}, {preferred_username: 'bryce', uidNumber: '1.5', gidNumber: 1},
    {preferred_username: 'bryce', uidNumber: 12345, gidNumber: -1}]) assert.equal(posixIdentity(claims), null);
});
