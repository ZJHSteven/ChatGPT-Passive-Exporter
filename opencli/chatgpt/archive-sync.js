import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { runSyncJson } from './_archive-runner.js';

export const archiveSyncCommand = cli({
    site: 'chatgpt',
    name: 'archive-sync',
    access: 'write',
    description: 'Sync one ChatGPT conversation into the local archive using the logged-in CDP browser',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'id', positional: true, required: true, help: 'Conversation ID' },
        { name: 'num-turns', type: 'int', default: 100, help: 'Max user turns requested from the current plural conversation endpoint' },
    ],
    columns: ['ConversationId', 'Title', 'Transport', 'RawBytes', 'Messages', 'VisibleMessages', 'Resources', 'RawFile'],
    func: async (kwargs) => {
        const id = String(kwargs.id || '').trim();
        if (!id) throw new ArgumentError('archive-sync requires a conversation ID');
        const numTurns = Number(kwargs['num-turns'] ?? 100);
        if (!Number.isInteger(numTurns) || numTurns <= 0 || numTurns > 1000) {
            throw new ArgumentError('--num-turns must be an integer from 1 to 1000');
        }
        const result = runSyncJson(id, numTurns);
        return [{
            ConversationId: result.conversationId,
            Title: result.title,
            Transport: result.transport,
            RawBytes: result.rawBytes,
            Messages: result.messageCount,
            VisibleMessages: result.visibleMessageCount,
            Resources: result.resourceCount,
            RawFile: result.rawFile,
        }];
    },
});
