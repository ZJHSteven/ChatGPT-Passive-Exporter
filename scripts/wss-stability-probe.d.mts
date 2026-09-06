/**
 * `wss-stability-probe.mjs` 是一个直接由 Node 执行的诊断脚本，因此保留为原生 ESM JS。
 *
 * 测试只会导入其中的 `summarizeFrame()`。把这份很小的声明文件放在脚本旁边，
 * 可以让 TypeScript 在不把整份实验脚本迁成 TS、也不使用 `any`/`@ts-ignore` 的前提下，
 * 对测试维持稳定的类型检查。
 */
export interface SafeFrameControl {
  type?: string
  topic?: string
  topic_id?: string
  recovered?: boolean
  status?: string
  [key: string]: string | boolean | undefined
}

export interface SafeFrameSummary {
  bytes: number
  topLevelType?: string
  arrayLength?: number
  firstObjectKeys?: string[]
  topLevelKeys?: string[]
  controls?: SafeFrameControl[]
}

/**
 * 从 WebSocket payload 中只抽取协议控制字段；业务正文、conversation id 等不会返回。
 */
export function summarizeFrame(payloadData: unknown): SafeFrameSummary
