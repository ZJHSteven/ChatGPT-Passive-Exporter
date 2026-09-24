import type { RawChatMessage } from './types'

/**
 * ChatGPT Web 在 conversation body 中不会把生成图片直接内嵌成 base64。
 * 它保存的是一个稳定的 `asset_pointer`（目前常见 `sediment://file_*`），并把
 * MIME、尺寸、生成任务 gen_id 等信息放在同一个 content part 里。
 *
 * 这个结构是 Archive 内部的“稳定描述符”：下载层、manifest、run diagnostics
 * 都只依赖这里，不各自复制一套私有 Web schema 解析逻辑。
 */
export interface ImageAssetDescriptor {
  partIndex: number
  assetPointer: string
  /** `sediment://file_xxx` 中的稳定 file id；未知 scheme 时允许为空。 */
  fileId?: string
  mimeType?: string
  sizeBytes?: number
  width?: number
  height?: number
  genId?: string
  parentGenId?: string
  orientation?: string
  transparentBackground?: boolean
  /** true 表示这是 ImageGen 的输出，而不是用户上传/普通图片附件。 */
  generated: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function roleOf(message: RawChatMessage): string {
  return typeof message.author?.role === 'string' ? message.author.role : ''
}

/**
 * ImageGen 结果节点的强信号。
 *
 * 2026-09-24《漫画分镜设计》真机样本中，结果节点稳定表现为：
 * - role=tool
 * - channel=final
 * - content_type=multimodal_text
 * - permissions[].notification_channel_id=image_gen
 * - parts[] 中存在带 generation.gen_id 的 image_asset_pointer
 *
 * permission 与 generation metadata 任一存在即可兼容协议小改；但仍要求 tool/final/
 * multimodal 三个外层条件，避免把普通用户上传图片误当成“模型已经完成生图”。
 */
export function isCompletedImageGenerationMessage(message: RawChatMessage): boolean {
  if (roleOf(message) !== 'tool') return false
  if (message.channel !== 'final') return false
  if (message.content?.content_type !== 'multimodal_text') return false

  const metadata = record(message.metadata) ?? {}
  const permissions = Array.isArray(metadata.permissions) ? metadata.permissions : []
  const hasImageGenPermission = permissions.some((entry) => {
    const permission = record(entry)
    return permission?.notification_channel_id === 'image_gen'
  })

  const parts = Array.isArray(message.content?.parts) ? message.content.parts : []
  const hasGeneratedImagePart = parts.some((part) => {
    const value = record(part)
    if (value?.content_type !== 'image_asset_pointer') return false
    const partMetadata = record(value.metadata)
    const generation = record(partMetadata?.generation)
    const dalle = record(partMetadata?.dalle)
    return Boolean(stringValue(generation?.gen_id) || stringValue(dalle?.gen_id))
  })

  return hasImageGenPermission || hasGeneratedImagePart
}

/** 从一条 raw message 无损提取所有 `image_asset_pointer`。 */
export function extractImageAssets(message: RawChatMessage): ImageAssetDescriptor[] {
  const parts = Array.isArray(message.content?.parts) ? message.content.parts : []
  const generatedMessage = isCompletedImageGenerationMessage(message)

  return parts.flatMap((part, partIndex) => {
    const value = record(part)
    if (value?.content_type !== 'image_asset_pointer') return []

    const assetPointer = stringValue(value.asset_pointer)
    if (!assetPointer) return []

    const partMetadata = record(value.metadata)
    const generation = record(partMetadata?.generation)
    const dalle = record(partMetadata?.dalle)
    const generationGenId = stringValue(generation?.gen_id)
    const dalleGenId = stringValue(dalle?.gen_id)
    const fileMatch = assetPointer.match(/^[a-z][a-z0-9+.-]*:\/\/(file_[A-Za-z0-9_-]+)$/iu)

    return [{
      partIndex,
      assetPointer,
      fileId: fileMatch?.[1],
      mimeType: stringValue(value.mime_type),
      sizeBytes: numberValue(value.size_bytes),
      width: numberValue(value.width),
      height: numberValue(value.height),
      genId: generationGenId ?? dalleGenId,
      parentGenId: stringValue(generation?.parent_gen_id) ?? stringValue(dalle?.parent_gen_id),
      orientation: stringValue(generation?.orientation),
      transparentBackground: booleanValue(generation?.transparent_background),
      generated: generatedMessage && Boolean(generationGenId || dalleGenId),
    } satisfies ImageAssetDescriptor]
  })
}

