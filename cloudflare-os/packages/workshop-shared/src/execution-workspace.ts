/** Verified POSIX identity supplied by the deployment's identity provider. */
export interface ExecutionIdentity {
  /** POSIX login name, independent of the editable display name. */
  username: string;
  /** Non-root numeric user ID. */
  uid: number;
  /** Non-root numeric primary group ID. */
  gid: number;
}

/** An operator-approved Git service to which a user may link their account. */
export interface GitProvider {
  /** Stable provider identifier. */
  id: string;
  /** Display name. */
  label: string;
  /** Supported API and authentication protocol. */
  kind: 'github' | 'gitlab';
  /** Whether an administrator has configured a private OAuth client for this service. */
  oauth?: boolean;
}

/** Browser handoff for a user-owned Git OAuth link; contains no credentials or PKCE verifier. */
export interface GitOAuthStart {
  /** Authorization URL on the administrator-approved self-hosted service. */
  url: string;
  /** One-use state, bound to the caller and checked again by the callback browser. */
  state: string;
}

/** Public information about the caller's linked account; never contains credentials. */
export interface GitConnection {
  /** Opaque, per-user connection identifier. */
  id: string;
  /** Operator-approved provider identifier. */
  providerId: string;
  /** Verified Git account login. */
  login: string;
}

/** A repository chosen from one of the caller's linked Git accounts. */
export interface GitRepositorySelection {
  /** Identifier of the caller's connection. */
  connectionId: string;
  /** Repository path such as team/project; not a URL. */
  repository: string;
}

/** Chat execution settings. Missing settings on older chats mean Ask. */
export interface ChatExecutionSelection {
  /** Ask uses workerd; Agent uses a Kata workspace. */
  mode: 'ask' | 'agent';
  /** The only currently supported container environment. */
  environment: 'rhel10';
  /** Optional repository checked out into the Agent workspace. */
  git?: GitRepositorySelection;
}

/** Execution choices available to the currently authenticated user. */
export interface ExecutionProfile {
  /** Whether the deployment has enabled Kata execution. */
  enabled: boolean;
  /** Trusted POSIX identity, or null when the IdP supplies no valid identity. */
  identity: ExecutionIdentity | null;
  /** Operator-approved Git services. */
  providers: GitProvider[];
  /** The caller's linked accounts, with credentials redacted. */
  connections: GitConnection[];
}

/** An operation inside this chat's isolated Linux environment. */
export type ExecutionOperation =
  | {/** Lifecycle or inspection action. */ action: 'start' | 'suspend' | 'status'}
  | {/** Execute a shell command. */ action: 'exec'; /** Shell command, bounded to 16 KiB. */ command: string}
  | {/** Read a file or list a directory. */ action: 'read' | 'list'; /** Relative workspace path. */ path: string}
  | {/** Replace a text file. Parent directory must exist. */ action: 'write'; /** Relative workspace path. */ path: string; /** Text, bounded to 512 KiB. */ content: string};

/** Bounded execution output or filesystem/lifecycle result. */
export interface ExecutionResult {
  /** Pod lifecycle state, when inspecting or changing lifecycle. */
  state?: 'suspended' | 'stopping' | 'starting' | 'ready' | 'failed';
  /** Shell exit status; null when terminated by a signal. */
  exitCode?: number | null;
  /** Signal terminating the shell. */
  signal?: string | null;
  /** Combined command output, bounded to 1 MiB. */
  output?: string;
  /** Whether command execution exceeded its time limit. */
  timedOut?: boolean;
  /** Whether command output or the directory list exceeded its bound. */
  truncated?: boolean;
  /** Text contents returned by a read. */
  content?: string;
  /** Confirmation that a file was written. */
  written?: boolean;
  /** At most 200 directory entries. */
  entries?: {/** Entry name. */ name: string; /** Whether this entry is a directory. */ directory: boolean}[];
}

/** Owner-scoped Git actions; branch names do not confer authority to another repository. */
export type AgentGitOperation =
  | {
    /** Capture and queue the current local HEAD for an approved remote push. */
    action: 'push';
    /** Task branch suffix, normalized into the chat's remote namespace. */
    branch: string;
    /** Existing remote branch whose history the new task branch derives from. */
    base: string;
  }
  | {
    /** Queue a same-repository pull request; never merges it. */
    action: 'pull-request';
    /** The task branch previously pushed through this chat's Gatekeeper. */
    branch: string;
    /** Existing remote target branch. */
    base: string;
    /** Exact title shown for approval and sent to the provider. */
    title: string;
    /** Exact body shown for approval and sent to the provider. */
    body: string;
  }
  | {
    /** Read the redacted state of a previously queued action. */
    action: 'status';
    /** Action ID returned by this chat's Git tool. */
    id: number;
  };

/** Redacted approval state and the resulting commit or enterprise pull request URL. */
export interface AgentGitResult {
  /** Facet-local action ID returned by the Git tool. */
  id: number;
  /** External writes stay pending until the owner approves. */
  state: 'pending' | 'approved' | 'rejected';
  /** Provider-confirmed outcome; never contains credentials or a Git pack. */
  result?: {
    /** Exact commit confirmed pushed to the remote. */
    head?: string;
    /** Chat-scoped destination branch, including while awaiting approval. */
    branch?: string;
    /** Same-origin enterprise pull request URL confirmed by the provider. */
    url?: string;
  };
}
