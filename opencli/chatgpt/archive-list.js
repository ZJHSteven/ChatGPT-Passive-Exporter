import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { runArchiveJson } from './_archive-runner.js';

export const archiveListCommand = cli({
    site: 'chatgpt',
    name: 'archive-list',
    access: 'read',
    description: 'List conversations stored in the local ChatGPT archive',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'limit', type: 'int', default: 50, help: 'Max conversations' },
    ],
    columns: ['ConversationId', 'Title', 'Messages', 'Resources', 'SourceFormat', 'CapturedAt'],
    func: async (kwargs) => {
        const limit = Number(kwargs.limit ?? 50);
        if (!Number.isInteger(limit) || limit <= 0) throw new ArgumentError('--limit must be a positive integer');
        const rows = runArchiveJson(['list', '--limit', String(limit)]);
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new EmptyResultError('chatgpt archive-list', 'The local ChatGPT archive is empty.');
        }
        return rows.map((row) => ({
            ConversationId: row.id,
            Title: row.title,
            Messages: row.messageCount,
            Resources: row.resourceCount,
            SourceFormat: row.sourceFormat,
            CapturedAt: Number.isFinite(Number(row.capturedAt)) ? new Date(Number(row.capturedAt)).toISOString() : '',
        }));
    },
});
