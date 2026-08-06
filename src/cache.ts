import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface Entry {
    value: string;
    timestamp: number;
}

const CAPACITY = 1000;
const MAX_KEY_LEN = 200; // keeps keys bounded so the cache file stays small

function safeKey(prefix: string): string {
    return prefix.length > MAX_KEY_LEN ? prefix.slice(-MAX_KEY_LEN) : prefix;
}

export class LruCache {
    private static instance: LruCache | undefined;
    private filePath: string;
    private map = new Map<string, Entry>();

    private constructor(filePath: string) {
        this.filePath = filePath;
        this.loadAll();
    }

    /** Open a cache instance backed by a specific JSON file. Used by tests and the singleton. */
    static openAt(filePath: string): LruCache {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        return new LruCache(filePath);
    }

    static get(): LruCache {
        if (!LruCache.instance) {
            const dir = path.join(os.homedir(), '.dumb-llm-autocomplete');
            LruCache.instance = LruCache.openAt(path.join(dir, 'cache.json'));
        }
        return LruCache.instance;
    }

    /** Test helper: clear the singleton so the next `get()` opens a fresh cache. */
    static resetForTests(): void {
        if (LruCache.instance) {
            try { LruCache.instance.close(); } catch { /* ignore */ }
        }
        LruCache.instance = undefined;
    }

    private loadAll(): void {
        let raw: string;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch {
            return; // no cache file yet → start empty
        }
        try {
            const rows = JSON.parse(raw) as Array<[string, Entry]>;
            for (const [key, entry] of rows) {
                this.map.set(key, entry);
            }
        } catch {
            // corrupt cache file → start empty; the next put overwrites it
            this.map.clear();
        }
    }

    // ponytail: full-file rewrite per put; fine at ≤1000 entries, becomes a
    // perf issue only if completions grow huge — switch to append-only log then.
    private persist(): void {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify([...this.map.entries()]));
        fs.renameSync(tmp, this.filePath);
    }

    /** Longest-prefix match: returns completion starting at the remaining chars after the matched key. */
    get(prefix: string): string | undefined {
        const key = safeKey(prefix);
        let bestKey: string | undefined;
        let bestEntry: Entry | undefined;
        for (const [k, e] of this.map) {
            if (key.startsWith(k) && (!bestKey || k.length > bestKey.length)) {
                bestKey = k;
                bestEntry = e;
            }
        }
        if (!bestKey || !bestEntry) return undefined;
        const remainder = key.slice(bestKey.length);
        if (!bestEntry.value.startsWith(remainder)) return undefined;
        bestEntry.timestamp = Date.now();
        return bestEntry.value.slice(remainder.length);
    }

    put(prefix: string, completion: string): void {
        const key = safeKey(prefix);
        const now = Date.now();
        this.map.set(key, { value: completion, timestamp: now });
        if (this.map.size > CAPACITY) {
            // evict oldest
            let oldestKey: string | undefined;
            let oldestTime = Infinity;
            for (const [k, e] of this.map) {
                if (e.timestamp < oldestTime) {
                    oldestTime = e.timestamp;
                    oldestKey = k;
                }
            }
            if (oldestKey) {
                this.map.delete(oldestKey);
            }
        }
        this.persist();
    }

    close(): void {
        this.persist();
        this.map.clear();
    }
}
