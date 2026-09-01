import { cli, Strategy } from '@jackwener/opencli/registry';
import { runCompanionControlJson } from './_companion-runner.js';

export const companionReviewCommand = cli({
    site: 'chatgpt',
    name: 'companion-review',
    access: 'write',
    description: 'Run the hard recovery gate and read-only GPT-5.6 Luna review for one realtime ChatGPT incident',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'incident-id', positional: true, required: false, help: 'Incident ID; defaults to newest realtime open incident' },
    ],
    columns: ['IncidentId', 'ConversationId', 'Eligible', 'Approved', 'Risk', 'Outcome', 'Reason', 'ContinuePrompt'],
    func: async (kwargs) => {
        const id = String(kwargs['incident-id'] || '').trim();
        const result = runCompanionControlJson(['review', ...(id ? [id] : [])]);
        return [{
            IncidentId: result.incident?.id || id,
            ConversationId: result.incident?.conversationId || '',
            Eligible: Boolean(result.eligibility?.eligible),
            Approved: Boolean(result.decision?.approve),
            Risk: result.decision?.risk || '',
            Outcome: result.attempt?.outcome || (result.skipped ? 'skipped' : ''),
            Reason: result.decision?.reason || result.eligibility?.reason || result.reason || '',
            ContinuePrompt: result.decision?.continuePrompt || '',
        }];
    },
});

