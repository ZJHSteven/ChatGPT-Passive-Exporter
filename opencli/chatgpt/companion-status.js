import { cli, Strategy } from '@jackwener/opencli/registry';
import { runCompanionControlJson } from './_companion-runner.js';

export const companionStatusCommand = cli({
    site: 'chatgpt',
    name: 'companion-status',
    access: 'read',
    description: 'Show ChatGPT Companion Fleet status, persistent incidents, and recovery attempts',
    domain: 'localhost',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [],
    columns: ['Active', 'CurrentAbnormal', 'Suspected', 'Incidents', 'RecoveryAttempts', 'LastPollAt'],
    func: async () => {
        const result = runCompanionControlJson(['status']);
        const tracked = Array.isArray(result.tracked) ? result.tracked : [];
        const alerts = Array.isArray(result.alerts) ? result.alerts : [];
        const incidents = Array.isArray(result.incidents) ? result.incidents : [];
        const attempts = Array.isArray(result.recoveryAttempts) ? result.recoveryAttempts : [];
        return [{
            Active: tracked.filter(row => row.state === 'server-streaming').length,
            CurrentAbnormal: tracked.filter(row => row.state === 'abnormal').length,
            Suspected: alerts.filter(row => row.kind === 'suspected-stall').length,
            Incidents: incidents.length,
            RecoveryAttempts: attempts.length,
            LastPollAt: Number.isFinite(Number(result.lastPollAt)) ? new Date(Number(result.lastPollAt)).toISOString() : '',
        }];
    },
});

