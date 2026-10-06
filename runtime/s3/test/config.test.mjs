import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../config.mjs';

const env = { AWS_ENDPOINT_URL: 'https://s3.internal', BUCKET_NAME: 'tenant-acme',
  AWS_DEFAULT_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test-secret', AETHER_TENANT_ID: 'acme' };

test('direct and COSI settings preserve tenant boundaries and TLS', async () => {
  const config = await readConfig(env);
  assert.equal(config.prefix, 'aether/acme/');
  assert.equal(config.forcePathStyle, true);
  assert.equal((await readConfig({ ...env, AWS_S3_ADDRESSING_STYLE: 'virtual' })).forcePathStyle, false);
  for (const settings of [
    { AWS_ENDPOINT_URL: 'http://s3.internal' }, { AWS_ENDPOINT_URL: 'https://user:secret@s3.internal' },
    { AWS_ENDPOINT_URL: 'https://s3.internal/prefix' }, { AWS_ENDPOINT_URL: 'https://s3.internal/?x=1' },
    { AETHER_TENANT_ID: '../other' }, { AETHER_S3_PREFIX: 'aether/../other/' },
    { AETHER_S3_PREFIX: '/aether/' }, { AETHER_S3_PREFIX: 'aether' },
    { AWS_S3_ADDRESSING_STYLE: 'auto' }, { COSI_PROTOCOL: 'GCS' }, { AETHER_S3_PORT: 'invalid' },
    { AWS_SECRET_ACCESS_KEY: '' },
  ]) await assert.rejects(readConfig({ ...env, ...settings }));
  const directory = await mkdtemp(join(tmpdir(), 'aether-cosi-'));
  try {
    const path = join(directory, 'BucketInfo');
    await writeFile(path, JSON.stringify({ spec: { bucketName: 'cosi-bucket', protocols: ['s3'], secretS3: {
      endpoint: 'https://cosi.internal', region: 'us-east-1', accessKeyID: 'cosi-test', accessSecretKey: 'cosi-secret',
    } } }));
    const cosi = await readConfig({ AETHER_COSI_BUCKET_INFO: path, AETHER_TENANT_ID: 'acme' });
    assert.equal(cosi.bucket, 'cosi-bucket');
    assert.equal(cosi.credentials.accessKeyId, 'cosi-test');
    assert.equal(cosi.endpoint, 'https://cosi.internal');
    const ca = join(directory, 'ca.pem');
    await writeFile(ca, 'test-ca');
    assert.equal((await readConfig({ ...env, AETHER_S3_CA_FILE: ca })).ca, 'test-ca');
    assert.equal((await readConfig({ ...env, COSI_PROTOCOL: 'S3', COSI_CERTIFICATE_AUTHORITY: 'cosi-ca' })).ca, 'cosi-ca');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
