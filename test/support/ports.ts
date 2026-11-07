/**
 * A port for a child process to listen on.
 *
 * Picked below every operating system's ephemeral range (Linux 32768-60999, macOS and Windows from 49152), because
 * that range is where the OS takes the local port of every outgoing connection, and these tests open many, to
 * PostgreSQL and to the broker. A random port inside it was found taken on CI ("Failed to start server. Is port
 * 37244 in use?"), which made a process of the failure suite die at start-up now and then.
 *
 * The port is also checked free now, and never handed out twice by this process. What remains is a window between
 * the check and the child's own listen, in which only another test could take it, and none does.
 */
const LOW = 20_000;
const HIGH = 32_000;
const handedOut = new Set<number>();

export function freePort(): number {
  for (let attempt = 0; attempt < 500; attempt++) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW));
    if (handedOut.has(port)) continue;
    try {
      const probe = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
      probe.stop(true);
    } catch {
      continue;
    }
    handedOut.add(port);
    return port;
  }
  throw new Error(`no free port between ${LOW} and ${HIGH}`);
}
