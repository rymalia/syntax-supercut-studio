import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { CancelledError } from './ffmpeg.js';

export type EngineResult = { ok: true; [key: string]: unknown };

/**
 * Process groups of running engine commands. Engines run detached (their own group) so a cancel can
 * kill their workers too; that also means they no longer die with the server, so stop them on exit.
 * Kept on globalThis so a Vite module reload doesn't lose track of work started before it.
 */
const registry = globalThis as typeof globalThis & { __engineGroups?: Set<number> };
const engineGroups = (registry.__engineGroups ??= installShutdownHook(new Set<number>()));

function installShutdownHook(groups: Set<number>): Set<number> {
	const stopAll = () => {
		const live = [...groups].filter((pid) => {
			try { process.kill(-pid, 'SIGTERM'); return true; } catch { return false; }
		});
		groups.clear();
		if (!live.length) return;
		// We may be exiting, so hand the SIGKILL fallback to a detached reaper that outlives us.
		spawn('/bin/sh', ['-c', 'sleep 10; for g; do kill -0 -$g 2>/dev/null && kill -KILL -$g; done', 'reaper', ...live.map(String)], {
			detached: true, stdio: 'ignore',
		}).unref();
	};
	process.on('exit', stopAll);
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		const onSignal = () => {
			stopAll();
			// A listener cancels Node's default exit, so re-raise unless someone else (e.g. Vite) handles the
			// signal. Prepended so we run before a `once` handler removes itself and hides from listenerCount.
			if (process.listenerCount(sig) === 1) {
				process.removeListener(sig, onSignal);
				process.kill(process.pid, sig);
			}
		};
		process.prependListener(sig, onSignal);
	}
	return groups;
}

/** Forget groups that have fully exited (so a reused pid is never signalled at shutdown). */
function pruneGroups() {
	for (const pid of engineGroups) try { process.kill(-pid, 0); } catch { engineGroups.delete(pid); }
}

export function engineDir(): string {
	return resolve(process.env.TH_ENGINE_DIR ?? join(homedir(), 'ResolveScripts/talking_heads'));
}

export function filmsDir(): string {
	return join(engineDir(), 'films');
}

export function filmPath(slug: string): string {
	if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Invalid film slug');
	return join(filmsDir(), `${slug}.json`);
}

/** Return a relative media path only for files within the public engine roots. */
export function engineMediaPath(target: string): string | null {
	const rel = relative(engineDir(), resolve(target));
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
	const parts = rel.split(sep);
	if (parts[0] === 'identities' && parts.length >= 2) return rel;
	if (parts[0] === 'proxy' && parts.length >= 2) return rel;
	if (parts[0] === 'films' && parts[1] === 'out' && parts.length >= 3) return rel;
	// Speaker review previews: review/clips/<f> (first review) and review/<batch>/clips/<f>.
	if (parts[0] === 'review' && ((parts[1] === 'clips' && parts.length === 3) || (parts[2] === 'clips' && parts.length === 4))) return rel;
	return null;
}

export function runEngine(
	args: string[],
	onLog: (line: string) => void = () => {},
	signal?: AbortSignal,
): Promise<EngineResult> {
	if (signal?.aborted) return Promise.reject(new CancelledError());
	return new Promise((resolvePromise, rejectPromise) => {
		const dir = engineDir();
		const child = spawn(join(dir, 'asd/.venv/bin/python'), [join(dir, 'engine_cli.py'), ...args], {
			cwd: dir,
			detached: true,
		});
		pruneGroups();
		const pid = child.pid;
		if (pid !== undefined) engineGroups.add(pid);
		let stdout = '';
		let stderr = '';
		let result: Record<string, unknown> | null = null;
		let parseError: Error | null = null;
		let cancelled = false;

		function accept(line: string) {
			if (line.startsWith('LOG ')) onLog(line.slice(4));
			else if (line.startsWith('RESULT ')) {
				try {
					const value: unknown = JSON.parse(line.slice(7));
					if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RESULT record');
					result = value as Record<string, unknown>;
				} catch (err) {
					parseError = err instanceof Error ? err : new Error(String(err));
				}
			}
		}
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
			let end: number;
			while ((end = stdout.indexOf('\n')) !== -1) {
				accept(stdout.slice(0, end).replace(/\r$/, ''));
				stdout = stdout.slice(end + 1);
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
			const lines = stderr.split(/\r?\n/);
			stderr = lines.slice(-41).join('\n');
		});
		const onAbort = () => {
			cancelled = true;
			// No pid means the spawn failed and 'error' will reject; child.kill() here would signal our own group.
			if (pid === undefined) return;
			try {
				process.kill(-pid, 'SIGTERM');
			} catch {
				child.kill('SIGTERM');
			}
			// Watch the whole group, not the pipe: workers that log to files don't hold stdout. Stop as soon as
			// the group is gone (so a reused pid is never signalled); SIGKILL whatever is left after 10 s.
			const started = Date.now();
			const sweep = setInterval(() => {
				try {
					process.kill(-pid, 0);
				} catch {
					clearInterval(sweep);
					engineGroups.delete(pid);
					return;
				}
				if (Date.now() - started >= 10_000) {
					clearInterval(sweep);
					try { process.kill(-pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
					engineGroups.delete(pid);
				}
			}, 250);
			sweep.unref();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) onAbort();
		child.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			rejectPromise(cancelled ? new CancelledError() : err);
		});
		child.on('close', (code) => {
			// Keep tracking a group whose workers outlive the leader; a cancel's sweep or pruneGroups() drops it later.
			if (!cancelled && pid !== undefined) try { process.kill(-pid, 0); } catch { engineGroups.delete(pid); }
			signal?.removeEventListener('abort', onAbort);
			if (cancelled) return rejectPromise(new CancelledError());
			if (stdout.trim()) accept(stdout.trim());
			if (code === 0 && result?.ok === true) return resolvePromise(result as EngineResult);
			const tail = stderr.trim().split(/\r?\n/).slice(-40).join('\n');
			const reason = parseError?.message ?? (typeof result?.error === 'string' ? result.error : `Engine exited ${code ?? 'unknown'} without a successful RESULT`);
			rejectPromise(new Error(`${reason}${tail ? `\n${tail}` : ''}`));
		});
	});
}
