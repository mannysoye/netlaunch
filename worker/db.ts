import { AppError } from './http.ts';
import type { D1Like } from './types.ts';

export type Stage = 'clarify' | 'confirm' | 'building' | 'live' | 'failed';

export interface ConversationRow {
  id: string;
  owner_id: string;
  title: string;
  stage: Stage;
  brief: string;
  slug: string | null;
  clarify_turns: number;
  pending_html: string | null;
  last_error: string | null;
  live_url: string | null;
  site_bytes: number | null;
  building_since: number | null;
  created_at: number;
  updated_at: number;
}
export interface MessageRow { id: string; conversation_id: string; role: 'user' | 'assistant'; content: string; ui: string | null; created_at: number }
export interface ImageRow { id: string; conversation_id: string; key: string; filename: string; role: string; caption: string | null; mime: string; bytes: number; created_at: number }

const DAY_MS = 86_400_000;
const isUnique = (e: unknown): boolean => /UNIQUE|constraint/i.test(String((e as Error)?.message ?? e));

export function createRepo(db: D1Like) {
  const q = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v);

  return {
    async upsertUser(u: { id: string; email?: string | null; name?: string | null; image?: string | null }, now: number) {
      await q(
        `INSERT INTO users (id,email,name,image,created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, image=excluded.image`,
        u.id, u.email ?? null, u.name ?? null, u.image ?? null, now,
      ).run();
    },

    async countConversations(ownerId: string): Promise<number> {
      const r = await q('SELECT COUNT(*) AS n FROM conversations WHERE owner_id=?', ownerId).first<{ n: number }>();
      return r?.n ?? 0;
    },

    async createConversation(id: string, ownerId: string, now: number): Promise<ConversationRow> {
      await q('INSERT INTO conversations (id,owner_id,created_at,updated_at) VALUES (?,?,?,?)', id, ownerId, now, now).run();
      return (await this.getConversation(id, ownerId))!;
    },

    async listConversations(ownerId: string): Promise<ConversationRow[]> {
      const r = await q(
        `SELECT id,title,stage,slug,live_url,updated_at,created_at,owner_id,brief,clarify_turns,pending_html,last_error,site_bytes,building_since
         FROM conversations WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100`, ownerId,
      ).all<ConversationRow>();
      return r.results ?? [];
    },

    /** Owner-scoped read: someone else's conversation is indistinguishable from a missing one. */
    async getConversation(id: string, ownerId: string): Promise<ConversationRow | null> {
      return q('SELECT * FROM conversations WHERE id=? AND owner_id=?', id, ownerId).first<ConversationRow>();
    },

    async updateConversation(id: string, patch: Partial<Omit<ConversationRow, 'id' | 'owner_id' | 'created_at'>>, now: number) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      const sets = keys.map((k) => `${k}=?`).join(', ');
      const vals = keys.map((k) => patch[k] ?? null);
      await q(`UPDATE conversations SET ${sets ? sets + ',' : ''} updated_at=? WHERE id=?`, ...vals, now, id).run();
    },

    /** Atomically move to `building`. Returns false if another build is already running (and not stale). */
    async beginBuild(id: string, now: number, staleMs: number): Promise<boolean> {
      const r = await q(
        `UPDATE conversations SET stage='building', building_since=?, last_error=NULL, updated_at=?
         WHERE id=? AND (stage IN ('confirm','failed','live') OR (stage='building' AND building_since < ?))`,
        now, now, id, now - staleMs,
      ).run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async deleteConversation(id: string) {
      await q('DELETE FROM conversations WHERE id=?', id).run();
    },

    async claimGuest(guestId: string, userId: string, now: number) {
      await q('UPDATE conversations SET owner_id=?, updated_at=? WHERE owner_id=?', userId, now, guestId).run();
    },

    // ---- slugs ----
    /** Is the page name free for this conversation? Abandoned drafts older than 24h do not hold names. */
    async slugAvailable(slug: string, conversationId: string | null, now: number): Promise<boolean> {
      const row = await q('SELECT id,stage,updated_at FROM conversations WHERE slug=?', slug).first<{ id: string; stage: Stage; updated_at: number }>();
      if (!row || row.id === conversationId) return true;
      return row.stage !== 'live' && row.stage !== 'building' && row.updated_at < now - DAY_MS;
    },

    async reserveSlug(conversationId: string, slug: string, now: number) {
      await q(
        `UPDATE conversations SET slug=NULL WHERE slug=? AND id!=? AND stage IN ('clarify','confirm','failed') AND updated_at<?`,
        slug, conversationId, now - DAY_MS,
      ).run();
      try {
        await q('UPDATE conversations SET slug=?, updated_at=? WHERE id=?', slug, now, conversationId).run();
      } catch (e) {
        if (isUnique(e)) throw new AppError('slug_taken', 'That page name is already taken. Try another.', 409);
        throw e;
      }
    },

    // ---- messages ----
    async addMessage(m: { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; ui?: unknown }, now: number): Promise<MessageRow> {
      const ui = m.ui ? JSON.stringify(m.ui) : null;
      await q('INSERT INTO messages (id,conversation_id,role,content,ui,created_at) VALUES (?,?,?,?,?,?)', m.id, m.conversationId, m.role, m.content, ui, now).run();
      return { id: m.id, conversation_id: m.conversationId, role: m.role, content: m.content, ui, created_at: now };
    },
    async listMessages(conversationId: string, limit = 200): Promise<MessageRow[]> {
      const r = await q(
        `SELECT * FROM (SELECT rowid AS rid,* FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC`,
        conversationId, limit,
      ).all<MessageRow>();
      return r.results ?? [];
    },

    // ---- images ----
    async addImage(i: Omit<ImageRow, 'created_at'>, now: number) {
      await q('INSERT INTO images (id,conversation_id,key,filename,role,caption,mime,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        i.id, i.conversation_id, i.key, i.filename, i.role, i.caption, i.mime, i.bytes, now).run();
    },
    async listImages(conversationId: string): Promise<ImageRow[]> {
      const r = await q('SELECT * FROM images WHERE conversation_id=? ORDER BY created_at, rowid', conversationId).all<ImageRow>();
      return r.results ?? [];
    },
    async getImage(conversationId: string, id: string): Promise<ImageRow | null> {
      return q('SELECT * FROM images WHERE id=? AND conversation_id=?', id, conversationId).first<ImageRow>();
    },
    async deleteImage(id: string) {
      await q('DELETE FROM images WHERE id=?', id).run();
    },

    // ---- quotas ----
    /** Atomic "increment unless at limit". Returns false when the limit has been reached. */
    async consume(key: string, kind: string, limit: number, now: number): Promise<boolean> {
      if (limit <= 0) return false;
      const day = new Date(now).toISOString().slice(0, 10);
      const r = await q(
        `INSERT INTO usage (key,day,kind,count) VALUES (?,?,?,1)
         ON CONFLICT(key,day,kind) DO UPDATE SET count=count+1 WHERE count<?`,
        key, day, kind, limit,
      ).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async pruneUsage(now: number) {
      await q('DELETE FROM usage WHERE day<?', new Date(now - 3 * DAY_MS).toISOString().slice(0, 10)).run();
    },
  };
}
export type Repo = ReturnType<typeof createRepo>;
