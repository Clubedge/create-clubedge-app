import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * How often a running step reports progress. Clients that reset their request timeout on
 * progress wait tens of seconds, so a few seconds between notifications keeps the call alive.
 */
const intervalMs = 5_000;

/** What progress needs from a tool call: the client's token, its cancellation, and a way to notify it. */
export type ProgressRequest = Pick<ServerContext["mcpReq"], "_meta" | "signal" | "notify">;

export interface StepProgress {
  /**
   * Runs a step and tells the client when it starts, every few seconds while it runs, and when
   * it ends or fails. The step's result or error is passed on as it is.
   */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
}

/** A duration for a message: "45s", and "2m 5s" from a minute on. */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Progress notifications for the long steps of a tool call, such as `pnpm install`, which can
 * outlast a client's request timeout. Only a client that sent a progress token with its request
 * (`_meta.progressToken`) is notified; without one the steps run and nothing is sent.
 */
export function stepProgress(request: ProgressRequest): StepProgress {
  const token = request._meta?.progressToken;
  // The protocol wants each value above the one before. How far along an install is isn't known,
  // so the value counts the notifications sent, and no total is given.
  let sent = 0;

  const notify = async (message: string): Promise<void> => {
    // A client that cancelled the call no longer knows the token.
    if (token === undefined || request.signal.aborted) return;
    sent += 1;
    try {
      await request.notify({ method: "notifications/progress", params: { progressToken: token, progress: sent, message } });
    } catch {
      // The client left or its transport closed. The step is not affected.
    }
  };

  return {
    async step(name, run) {
      if (token === undefined) return run();

      const startedAt = Date.now();
      const elapsed = () => formatElapsed(Date.now() - startedAt);
      // Notifications are not awaited: a client that reads slowly must not hold the step up.
      void notify(`${name}: started`);
      const timer = setInterval(() => void notify(`${name}: running for ${elapsed()}`), intervalMs);
      try {
        const result = await run();
        void notify(`${name}: finished in ${elapsed()}`);
        return result;
      } catch (error) {
        void notify(`${name}: failed after ${elapsed()}`);
        throw error;
      } finally {
        // Cleared however the step ends, so the timer never keeps the server running.
        clearInterval(timer);
      }
    },
  };
}
