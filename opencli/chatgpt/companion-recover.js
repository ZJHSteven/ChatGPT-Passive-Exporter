import { cli, Strategy } from '@jackwener/opencli/registry';
import { runCompanionControlJson } from './_companion-runner.js';

export const companionRecoverCommand = cli({
    site: 'chatgpt',
    name: 'companion-recover',
    access: 'write',
    description: 'Luna-review a realtime incident and optionally send the approved safe-continue prompt to that conversation',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'incident-id', positional: true, required: false, help: 'Incident ID; defaults to newest realtime open incident' },
        { name: 'execute', type: 'boolean', default: false, help: 'Actually send the approved continuation; default is dry-run review only' },
    ],
    columns: ['IncidentId', 'ConversationId', 'Eligible', 'Approved', 'Executed', 'Outcome', 'Reason'],
    func: async (kwargs) => {
        const id = String(kwargs['incident-id'] || '').trim();
        const execute = kwargs.execute === true;
        const args = ['recover', ...(id ? [id] : []), ...(execute ? ['--execute'] : [])];
        const result = runCompanionControlJson(args);
        return [{
            IncidentId: result.incident?.id || id,
            ConversationId: result.incident?.conversationId || '',
            Eligible: Boolean(result.eligibility?.eligible),
            Approved: Boolean(result.decision?.approve),
            Executed: Boolean(result.executed),
            Outcome: result.attempt?.outcome || (result.skipped ? 'skipped' : ''),
            Reason: result.decision?.reason || result.eligibility?.reason || result.reason || '',
        }];
    },
});

