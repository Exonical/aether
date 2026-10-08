import {createFileRoute} from '@tanstack/react-router';
import {useAuthenticatedApi} from '../AuthContext';
import {GitOAuthCallback} from '../features/execution/GitOAuthCallback';

const GitCallbackRoute = () => <GitOAuthCallback api={useAuthenticatedApi().authenticatedApi} />;

export const Route = createFileRoute('/git/callback')({component: GitCallbackRoute});
