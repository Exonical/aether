import {useEffect, useState} from 'react';
import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';
import type {ExecutionProfile} from '@gadgets/workshop-shared/execution-workspace';

export const useExecutionProfile = (api: RpcStub<AuthenticatedApi>) => {
  const [profile, setProfile] = useState<ExecutionProfile>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => api.getExecutionProfile()).then(result => {
      if (!cancelled) {setProfile(result); setError('');}
    }).catch(() => {if (!cancelled) setError('Execution settings could not be loaded');});
    return () => {cancelled = true;};
  }, [api]);
  const unavailable = error || (!profile ? 'Loading environments…' : !profile.enabled
    ? 'Agent environments are disabled by your administrator' : !profile.identity
    ? 'Your identity provider must supply a username and UID/GID to use Agent' : '');
  return {profile, setProfile, unavailable};
};
