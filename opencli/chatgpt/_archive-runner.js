import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommandExecutionError, ConfigError } from '@jackwener/opencli/errors';

const CONFIG_PATH = path.join(os.homedir(), '.opencli', 'sites', 'chatgpt', 'archive-local.json');

export function archiveConfig() {
    let fromFile = {};
    try {
        fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    catch {
        // Environment-only configuration is also supported.
    }

    const projectRoot = process.env.CHATGPT_ARCHIVE_PROJECT || fromFile.projectRoot;
    const dbPath = process.env.CHATGPT_ARCHIVE_DB || fromFile.dbPath;
    if (!projectRoot || !dbPath) {
        throw new ConfigError(
            `ChatGPT local archive is not configured. Run the project's scripts/install-opencli-adapter.mjs first, or set CHATGPT_ARCHIVE_PROJECT and CHATGPT_ARCHIVE_DB. Config: ${CONFIG_PATH}`,
        );
    }

    return {
        projectRoot: path.resolve(projectRoot),
        dbPath: path.resolve(dbPath),
        cliPath: path.resolve(projectRoot, 'scripts', 'archive-cli.mjs'),
    };
}

export function runArchiveCli(commandArgs) {
    const config = archiveConfig();
    if (!fs.existsSync(config.cliPath)) {
        throw new ConfigError(`Archive CLI not found: ${config.cliPath}`);
    }

    try {
        const output = execFileSync(
            process.execPath,
            [config.cliPath, ...commandArgs, '--db', config.dbPath],
            {
                cwd: config.projectRoot,
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
            },
        );
        return output;
    }
    catch (error) {
        const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
        const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
        const detail = stderr || stdout || error?.message || String(error);
        throw new CommandExecutionError(`ChatGPT local archive command failed: ${detail}`);
    }
}

export function runArchiveJson(commandArgs) {
    const output = runArchiveCli(commandArgs);
    try {
        return JSON.parse(output);
    }
    catch (error) {
        throw new CommandExecutionError(`ChatGPT local archive returned invalid JSON: ${error.message}`);
    }
}
