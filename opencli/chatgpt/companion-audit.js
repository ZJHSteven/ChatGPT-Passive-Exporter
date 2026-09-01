import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { runCompanionControlJson } from './_companion-runner.js';

export const companionAuditCommand = cli({
    site: 'chatgpt',
    name: 'companion-audit',
    access: 'write',
    description: 'Request an explicit low-rate historical ChatGPT abnormal-run audit on the Fleet leader',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'max', type: 'int', default: 200, help: 'Maximum conversations to audit (1..1000)' },
    ],
    columns: ['Requested', 'MaxConversations', 'RequestedAt'],
    func: async (kwargs) => {
        const max = Number(kwargs.max ?? 200);
        if (!Number.isInteger(max) || max <= 0 || max > 1000) throw new ArgumentError('--max must be 1..1000');
        const result = runCompanionControlJson(['audit', '--max', String(max)]);
        return [{
            Requested: Boolean(result.requested),
            MaxConversations: Number(result.maxConversations ?? max),
            RequestedAt: Number.isFinite(Number(result.at)) ? new Date(Number(result.at)).toISOString() : '',
        }];
    },
});

