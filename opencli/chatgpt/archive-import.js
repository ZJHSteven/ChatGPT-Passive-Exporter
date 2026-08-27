import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { runArchiveJson } from './_archive-runner.js';

export const archiveImportCommand = cli({
    site: 'chatgpt',
    name: 'archive-import',
    access: 'write',
    description: 'Import local ChatGPT conversation JSON into the local archive database',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'file', positional: true, required: true, help: 'JSON file path; comma-separated paths are supported' },
    ],
    columns: ['File', 'ConversationId', 'Title', 'Messages', 'Resources', 'Status'],
    func: async (kwargs) => {
        const files = String(kwargs.file || '').split(',').map((value) => value.trim()).filter(Boolean);
        if (files.length === 0) throw new ArgumentError('archive-import requires at least one JSON file');
        const payload = runArchiveJson(['import', ...files]);
        const rows = Array.isArray(payload?.imported) ? payload.imported : [];
        return rows.map((row) => ({
            File: row.file,
            ConversationId: row.conversationId || '',
            Title: row.title || '',
            Messages: row.messageCount ?? 0,
            Resources: row.resourceCount ?? 0,
            Status: row.error ? `Error: ${row.error}` : 'Imported',
        }));
    },
});
