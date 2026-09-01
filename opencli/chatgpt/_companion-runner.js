import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { CommandExecutionError, ConfigError } from '@jackwener/opencli/errors';
import { archiveConfig } from './_archive-runner.js';

/**
 * OpenCLI 与 Companion 本地控制器之间的薄桥。
 *
 * OpenCLI adapter 不复制 CDP/Luna/recovery 逻辑，只负责参数校验和结果整形；真正行为统一
 * 落在项目的 `scripts/companion-control.mjs`，这样命令行、未来 daemon 和测试共享一份实现。
 */
export function runCompanionControlJson(args) {
    const config = archiveConfig();
    const controlPath = path.resolve(config.projectRoot, 'scripts', 'companion-control.mjs');
    try {
        const output = execFileSync(
            process.execPath,
            [controlPath, ...args],
            {
                cwd: config.projectRoot,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
            },
        );
        return JSON.parse(output);
    }
    catch (error) {
        if (error?.code === 'ENOENT') throw new ConfigError(`Companion control script not found: ${controlPath}`);
        const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
        const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
        const detail = stderr || stdout || error?.message || String(error);
        throw new CommandExecutionError(`ChatGPT Companion control failed: ${detail}`);
    }
}

