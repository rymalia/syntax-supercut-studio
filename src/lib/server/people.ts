import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { engineDir } from './engine.js';

/** `people.json` in the engine dir: `{ "<name>": ["<cid>/<cluster>", ...] }`, each id under at most one name. */
export type PeopleNames = Record<string, string[]>;

export const NAME_RE = /^[a-z0-9_]+$/;

export class PeopleFileError extends Error {}

export function peoplePath(): string {
	return join(engineDir(), 'people.json');
}

/** Read the names plus a content hash; a write must present the hash it read (optimistic concurrency). */
export async function readPeopleNames(): Promise<{ names: PeopleNames; version: string }> {
	const path = peoplePath();
	const info = await lstat(path).catch(() => null);
	if (!info) return { names: {}, version: hash('') };
	if (!info.isFile()) throw new PeopleFileError('people.json is not a regular file');
	const raw = await readFile(path, 'utf8');
	let names: unknown;
	try { names = JSON.parse(raw); } catch { throw new PeopleFileError('people.json is not valid JSON'); }
	if (!names || typeof names !== 'object' || Array.isArray(names) ||
		Object.values(names).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
		throw new PeopleFileError('people.json is not a { name: [ids] } object');
	}
	return { names: names as PeopleNames, version: hash(raw) };
}

/**
 * Move `ids` under `name` (or under no name when `name` is null). Existing names keep their order and
 * other entries are untouched; a new name goes at the end, and a name left with no ids is dropped.
 */
export function assignIds(names: PeopleNames, ids: string[], name: string | null): PeopleNames {
	const moving = new Set(ids);
	// No prototype, so names like `constructor` or `__proto__` are plain keys.
	const next: PeopleNames = Object.create(null);
	for (const [key, list] of Object.entries(names)) {
		if (key === name) {
			next[key] = [...list, ...ids.filter((id) => !list.includes(id))];
			continue;
		}
		const kept = list.filter((id) => !moving.has(id));
		if (kept.length) next[key] = kept;
	}
	if (name !== null && !Object.hasOwn(next, name)) next[name] = [...ids];
	return next;
}

// Serializes read-check-write within this server; the version check covers other writers.
let queue: Promise<unknown> = Promise.resolve();

/** Apply `update` to the current names if the file still hashes to `version`; returns null on a stale version. */
export function updatePeopleNames(
	version: string,
	update: (names: PeopleNames) => PeopleNames,
): Promise<{ names: PeopleNames; version: string } | null> {
	const run = queue.then(async () => {
		const current = await readPeopleNames();
		if (current.version !== version) return null;
		const names = update(current.names);
		// Same shape as the engine-written file (1-space indent).
		const raw = `${JSON.stringify(names, null, 1)}\n`;
		// Rename replaces a symlink rather than following it, so the write stays in the engine dir.
		const temp = join(engineDir(), `.people.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, raw, { flag: 'wx' });
			// Re-check just before the swap: another writer (Desktop, chat) doesn't take our lock, so this
			// narrows the window in which its edit could be overwritten to the rename itself.
			if ((await readPeopleNames()).version !== version) return null;
			await rename(temp, peoplePath());
		} finally {
			await unlink(temp).catch(() => {});
		}
		return { names, version: hash(raw) };
	});
	queue = run.catch(() => {});
	return run;
}

function hash(raw: string): string {
	return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
