import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { runArchiveJson } from './_archive-runner.js';

export const archiveSearchCommand = cli({
    site: 'chatgpt',
    name: 'archive-search',
    access: 'read',
    description: 'Search the local ChatGPT archive without accessing chatgpt.com',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'query', positional: true, required: true, help: 'FTS/substring query' },
        { name: 'limit', type: 'int', default: 20, help: 'Max search hits' },
    ],
    columns: ['ConversationId', 'MessageId', 'Title', 'Role', 'Text', 'Rank'],
    func: async (kwargs) => {
        const query = String(kwargs.query || '').trim();
        if (!query) throw new ArgumentError('archive-search requires a non-empty query');
        const limit = Number(kwargs.limit ?? 20);
        if (!Number.isInteger(limit) || limit <= 0) throw new ArgumentError('--limit must be a positive integer');

        const rows = runArchiveJson(['search', query, '--limit', String(limit)]);
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new EmptyResultError('chatgpt archive-search', `No local archive matches for: ${query}`);
        }
        return rows.map((row) => ({
            ConversationId: row.conversationId,
            MessageId: row.messageId,
            Title: row.title,
            Role: row.role,
            Text: row.text,
            Rank: row.rank,
        }));
    },
});
