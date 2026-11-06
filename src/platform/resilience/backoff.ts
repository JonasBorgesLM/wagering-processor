export interface BackoffPolicy {
  baseSeconds: number;
  capSeconds: number;
}

/**
 * How long a failed message stays invisible before its next delivery (NFR-11): the ceiling doubles with each
 * delivery up to a cap, and the delay is drawn from its upper half. The jitter is what keeps the messages that
 * failed together, because the database was away, from coming back together and failing it again. The lower half
 * is kept fixed so a retry is never immediate. SQS counts whole seconds.
 *
 * `receiveCount` is the number of deliveries so far, so the first failure has a count of 1.
 */
export function backoffSeconds(
  receiveCount: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capSeconds, policy.baseSeconds * 2 ** Math.max(0, receiveCount - 1));
  return Math.ceil(ceiling / 2 + (random() * ceiling) / 2);
}
