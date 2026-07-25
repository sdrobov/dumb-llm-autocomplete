import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface Entry {
    value: string;
    timestamp: number;
}

const CAPACITY = 1000;
const MAX_KEY_LEN = 200; // sqlite LIKE pattern safety

function safeKey(prefix: string): string {
    return prefix.length > MAX_KEY_LEN ? prefix.slice(-MAX_KEY_LEN) : prefix;
}

export class LruCache {
    private static instance: LruCache | undefined;
    private db: Database.Database;
    private map = new Map<string, Entry>();

    private constructor(db: Database.Database) {
        this.db = db;
        this.loadAll();
    }

    static get(): LruCache {
        if (!LruCache.instance) {
            const dir = path.join(os.homedir(), '.dumb-llm-autocomplete');
            fs.mkdirSync(dir, { recursive: true });
            const dbPath = path.join(dir, 'cache.sqlite');
            const db = new Database(dbPath);
            db.exec(`
                CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    timestamp INTEGER NOT NULL
                )
            `);
            LruCache.instance = new LruCache(db);
        }
        return LruCache.instance;
    }

    private loadAll(): void {
        const rows = this.db.prepare('SELECT key, value, timestamp FROM cache').all() as Array<{
            key: string;
            value: string;
            timestamp: number;
        }>;
        for (const row of rows) {
            this.map.set(row.key, { value: row.value, timestamp: row.timestamp });
        }
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
                this.db.prepare('DELETE FROM cache WHERE key = ?').run(oldestKey);
            }
        }
        this.db.prepare(
            `INSERT INTO cache (key, value, timestamp) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = ?, timestamp = ?`,
        ).run(key, completion, now, completion, now);
    }

    close(): void {
        this.db.close();
    }
}