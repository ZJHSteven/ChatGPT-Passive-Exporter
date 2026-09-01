import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { runCompanionControlJson } from './_companion-runner.js';

export const companionIncidentsCommand = cli({
    site: 'chatgpt',
    name: 'companion-incidents',
    access: 'read',
    description: 'List persistent ChatGPT Companion incident history independently of current conversation state',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'source', choices: ['all', 'realtime', 'history-audit', 'legacy'], default: 'all', help: 'Incident source filter' },
        { name: 'status', choices: ['all', 'open', 'resumed', 'resolved'], default: 'all', help: 'Incident lifecycle filter' },
        { name: 'limit', type: 'int', default: 100, help: 'Maximum rows' },
    ],
    columns: ['IncidentId', 'ConversationId', 'Title', 'Source', 'Status', 'DetectedAt', 'Reason'],
    func: async (kwargs) => {
        const source = String(kwargs.source || 'all');
        const status = String(kwargs.status || 'all');
        const limit = Number(kwargs.limit ?? 100);
        if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new ArgumentError('--limit must be 1..1000');
        let rows = runCompanionControlJson(['incidents']);
        if (!Array.isArray(rows)) rows = [];
        if (source !== 'all') rows = rows.filter(row => row.source === source);
        if (status !== 'all') rows = rows.filter(row => row.status === status);
        rows = rows.slice(0, limit);
        if (rows.length === 0) throw new EmptyResultError('chatgpt companion-incidents', 'No matching incidents.');
        return rows.map(row => ({
            IncidentId: row.id,
            ConversationId: row.conversationId,
            Title: row.title,
            Source: row.source || 'legacy',
            Status: row.status,
            DetectedAt: Number.isFinite(Number(row.detectedAt)) ? new Date(Number(row.detectedAt)).toISOString() : '',
            Reason: row.reason,
        }));
    },
});

