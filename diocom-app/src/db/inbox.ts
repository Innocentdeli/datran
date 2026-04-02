import db from './index';
import { randomUUID } from 'crypto';

export interface InboxItem {
  id: string;
  sender_id: string;
  recipient_id: string;
  file_id: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  created_at: number;
  // Joined fields
  sender_name?: string;
  sender_image?: string;
  sender_username?: string;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
  share_id?: string;
}

export const InboxRepository = {
  /** Find a user by their @handle */
  resolveHandle: async (username: string): Promise<{ id: string; name: string; username: string } | undefined> => {
    const res = await db.query('SELECT id, name, username FROM users WHERE username = $1', [username.replace('@', '')]);
    return res.rows[0];
  },

  /** Send a file to a recipient by user ID */
  send: async (senderId: string, recipientId: string, fileId: string, message?: string): Promise<InboxItem> => {
    const id = randomUUID();
    const now = Date.now();
    await db.query(`
      INSERT INTO inboxes (id, sender_id, recipient_id, file_id, status, message, created_at)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6)
    `, [id, senderId, recipientId, fileId, message || null, now]);
    return { id, sender_id: senderId, recipient_id: recipientId, file_id: fileId, status: 'pending', message: message || null, created_at: now };
  },

  /** List all pending inbox items for a recipient, joined with sender + file info */
  findByRecipient: async (recipientId: string): Promise<InboxItem[]> => {
    const res = await db.query(`
      SELECT 
        i.*,
        u.name AS sender_name, u.image AS sender_image, u.username AS sender_username,
        f.original_name, f.file_size, f.mime_type, f.share_id
      FROM inboxes i
      LEFT JOIN users u ON u.id = i.sender_id
      LEFT JOIN files f ON f.share_id = i.file_id
      WHERE i.recipient_id = $1
      ORDER BY i.created_at DESC
    `, [recipientId]);
    return res.rows;
  },

  /** Update status of an inbox item */
  updateStatus: async (id: string, recipientId: string, status: 'accepted' | 'declined') => {
    const res = await db.query(`
      UPDATE inboxes SET status = $1 WHERE id = $2 AND recipient_id = $3
    `, [status, id, recipientId]);
    return res;
  },

  /** Count unread pending items for a user */
  countPending: async (recipientId: string): Promise<number> => {
    const res = await db.query(`SELECT COUNT(*) as count FROM inboxes WHERE recipient_id = $1 AND status = 'pending'`, [recipientId]);
    return parseInt(res.rows[0]?.count || '0', 10);
  },

  /** List all users with usernames for autocomplete */
  searchHandles: async (query: string): Promise<{ id: string; name: string; username: string; image: string }[]> => {
    const res = await db.query(`
      SELECT id, name, username, image FROM users 
      WHERE username ILIKE $1 AND username IS NOT NULL
      LIMIT 10
    `, [`%${query}%`]);
    return res.rows;
  }
};
