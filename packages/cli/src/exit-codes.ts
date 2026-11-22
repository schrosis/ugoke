/** Exit code of a run that was cancelled, following the shell convention for SIGINT. */
export const cancelledExitCode = 130;

/**
 * Exit code of a run that was left running, which a process can attach to later.
 *
 * It is not zero, so that a script that runs ugoke does not take the run as completed.
 */
export const detachedExitCode = 3;
