import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { CancelledError } from './ffmpeg.js';

export type EngineResult = { ok: true; [key: string]: unknown };

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

/** Return a relative media path only for files within the three public engine roots. */
export function engineMediaPath(target: string): string | null {
	const rel = relative(engineDir(), resolve(target));
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
	const parts = rel.split(sep);
	if (parts[0] === 'identities' && parts.length >= 2) return rel;
	if (parts[0] === 'proxy' && parts.length >= 2) return rel;
	if (parts[0] === 'films' && parts[1] === 'out' && parts.length >= 3) return rel;
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
		});
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
			child.kill('SIGTERM');
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) onAbort();
		child.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			rejectPromise(cancelled ? new CancelledError() : err);
		});
		child.on('close', (code) => {
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
