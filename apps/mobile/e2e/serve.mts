import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Serves a server-output export (dist/client + dist/server) with `expo serve`,
 * which also runs the API routes such as /s/<slug>, on a free local port.
 * `root` must sit inside the Expo project (expo serve looks upward for it).
 * API routes read EXPO_PUBLIC_* at run time, not build time, so they come from `env`.
 */
export async function serveExpo(
  root: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  // Its own process group, so closing it stops the server and not just the npx wrapper.
  const child = spawn('npx', ['expo', 'serve', root, '--port', String(port)], { cwd, env, stdio: 'inherit', detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i >= 120 || child.exitCode !== null) {
      stop();
      throw new Error('expo serve did not start');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        stop();
      }),
  };
}
