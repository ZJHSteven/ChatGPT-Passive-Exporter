import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { runArchiveCli } from './_archive-runner.js';

export const archiveReadCommand = cli({
    site: 'chatgpt',
    name: 'archive-read',
    access: 'read',
    description: 'Read one conversation from the local ChatGPT archive',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    defaultFormat: 'plain',
    args: [
        { name: 'id', positional: true, required: true, help: 'Conversation ID' },
        { name: 'view', choices: ['md', 'json', 'resources'], default: 'md', help: 'Local archive view to return' },
    ],
    columns: ['content'],
    func: async (kwargs) => {
        const id = String(kwargs.id || '').trim();
        if (!id) throw new ArgumentError('archive-read requires a conversation ID');
        const view = String(kwargs.view || 'md');
        const content = runArchiveCli(['show', id, '--format', view]);
        if (!content.trim()) throw new EmptyResultError('chatgpt archive-read', `Conversation not found or empty: ${id}`);
        return [{ content }];
    },
});
