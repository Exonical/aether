import type {RpcStub} from 'capnweb';
import type {AuthenticatedApi} from '@gadgets/workshop-shared/api';

export const GIT_OAUTH_BROWSER_KEY = 'aether.git.oauth';
export const GIT_OAUTH_CALLBACK_PATH = '/git/callback';

/** Open synchronously from a user click; no credentials cross the browser handoff. */
export const openGitOAuth = (api: RpcStub<AuthenticatedApi>, providerId: string) => {
  const popup = window.open('about:blank', '_blank', 'popup,width=650,height=750');
  if (!popup) throw new Error('Allow popups to connect your Git account.');
  // The Git service cannot navigate the parent tab. A state-scoped, same-origin channel returns status.
  popup.opener = null;
  let channel: BroadcastChannel | undefined, completed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let rejectCompletion: (error: Error) => void;
  const cleanup = () => {clearInterval(timer); channel?.close(); popup.close();};
  const finished = new Promise<string>((resolve, reject) => {
    rejectCompletion = reject;
    void (async () => {
      try {
        const flow = await api.beginGitOAuth(providerId);
        if (completed) return;
        popup.sessionStorage.setItem(GIT_OAUTH_BROWSER_KEY, JSON.stringify({state: flow.state, returnTo: window.location.href}));
        channel = new BroadcastChannel(`aether.git.oauth.${flow.state}`);
        channel.addEventListener('message', event => {
          if (completed) return;
          completed = true; cleanup();
          if (typeof event.data?.connectionId === 'string') resolve(event.data.connectionId);
          else reject(new Error('Git authorization failed. Connect again.'));
        }, {once: true});
        popup.location.replace(flow.url);
      } catch {if (!completed) {completed = true; cleanup(); reject(new Error('Could not start Git authorization.'));}}
    })();
  });
  const cancel = () => {
    if (completed) return;
    completed = true; cleanup(); rejectCompletion(new Error('Git authorization was closed.'));
  };
  if (!completed) timer = setInterval(() => {if (popup.closed) cancel();}, 500);
  return {finished, cancel};
};
