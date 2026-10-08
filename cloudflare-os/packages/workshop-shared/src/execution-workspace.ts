/** An operation inside this workspace's isolated Linux environment. */
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
