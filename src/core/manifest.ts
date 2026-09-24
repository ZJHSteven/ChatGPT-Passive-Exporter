import type { CanonicalConversation, RichManifest, RichManifestItem } from './types.ts'
import { extractImageAssets } from './image-assets.ts'

const SANDBOX_RE = /sandbox:\/mnt\/data\/[\p{L}\p{N}._~!$&'()*+,;=:@%\-/]+/gu
const ASSET_POINTER_RE = /(?:sediment|file-service|asset):\/\/[\w.:%+\-/]+/gu

function pushUnique(items: RichManifestItem[], item: RichManifestItem, seen: Set<string>): void {
  // 同一条回答里允许出现多个同尺寸 image_group；仅用 label 去重会把两组“3 张图”误合并。
  // data 参与身份判断后，只有结构也完全相同的重复引用才会被折叠。
  const key = `${item.kind}\u0000${item.messageId}\u0000${item.label}\u0000${JSON.stringify(item.data)}`
  if (seen.has(key)) return
  seen.add(key)
  items.push(item)
}

/**
 * 从原始 metadata 中生成“富内容目录”。
 *
 * 安全原则：manifest 默认只保存展示/审计需要的结构摘要，不复制 connector 的
 * session/token/cookie 等运行时字段。完整原始响应仍可由用户单独选择保存，但不应该
 * 在普通 Markdown 附录里把敏感运行信息扩散一遍。
 */
export function buildRichManifest(conversation: CanonicalConversation): RichManifest {
  const items: RichManifestItem[] = []
  const seen = new Set<string>()

  for (const message of conversation.messages) {
    const metadata = message.metadata
    const structuredAssetPointers = new Set<string>()

    const searchGroups = metadata.search_result_groups
    if (Array.isArray(searchGroups) && searchGroups.length > 0) {
      const groups = searchGroups
        .filter(group => group && typeof group === 'object')
        .map((group) => {
          const record = group as Record<string, unknown>
          const entries = Array.isArray(record.entries)
            ? record.entries.map((entry) => {
              if (!entry || typeof entry !== 'object') return null
              const value = entry as Record<string, unknown>
              return {
                title: typeof value.title === 'string' ? value.title : undefined,
                url: typeof value.url === 'string' ? value.url : undefined,
                snippet: typeof value.snippet === 'string' ? value.snippet : undefined,
                refId: typeof value.ref_id === 'string' ? value.ref_id : undefined,
                pubDate: value.pub_date,
              }
            }).filter(Boolean)
            : []

          return {
            domain: typeof record.domain === 'string' ? record.domain : undefined,
            entries,
          }
        })

      pushUnique(items, {
        kind: 'web-search',
        messageId: message.id,
        label: `Web Search (${groups.length} groups)`,
        data: groups,
      }, seen)
    }

    const invokedResource = metadata.invoked_resource
    if (invokedResource && typeof invokedResource === 'object') {
      const resource = invokedResource as Record<string, unknown>
      const appName = typeof resource.app_name === 'string' ? resource.app_name : 'App Connector'
      pushUnique(items, {
        kind: 'app-connector',
        messageId: message.id,
        label: appName,
        data: {
          appName,
          containsMcpSource: resource.contains_mcp_source === true,
          publishStatus: typeof resource.publish_status === 'string' ? resource.publish_status : undefined,
          description: typeof resource.description === 'string' ? resource.description : undefined,
        },
      }, seen)
    }

    const references = Array.isArray(metadata.content_references) ? metadata.content_references : []
    for (const reference of references) {
      if (!reference || typeof reference !== 'object') continue
      const ref = reference as Record<string, unknown>

      if (ref.type === 'image_group') {
        const images = Array.isArray(ref.images) ? ref.images : []
        pushUnique(items, {
          kind: 'image-group',
          messageId: message.id,
          label: `图片轮播 (${images.length})`,
          data: {
            layout: ref.layout,
            aspectRatio: ref.aspect_ratio,
            images,
          },
        }, seen)
      }

      if (ref.type === 'client_defined_widget') {
        pushUnique(items, {
          kind: 'widget',
          messageId: message.id,
          label: typeof ref.category === 'string' ? ref.category : 'client_defined_widget',
          data: {
            category: ref.category,
            data: ref.data,
          },
        }, seen)
      }
    }

    if (message.role === 'assistant' && message.recipient !== 'all') {
      pushUnique(items, {
        kind: 'tool-call',
        messageId: message.id,
        label: message.recipient,
        data: {
          recipient: message.recipient,
          contentType: message.contentType,
          // 默认只记录调用轨迹，不复制参数正文；参数可能含用户私有路径、查询或密钥。
          hasPayload: message.text.length > 0,
        },
      }, seen)
    }

    // `image_asset_pointer` 是图片最可靠的结构化入口。尤其是 ImageGen：一条 tool/final
    // message 可以同时含 2、4 张甚至更多图片，不能再靠“每条消息一个附件”的假设建模。
    // signed estuary URL 是页面运行时的短期解析结果，不属于 canonical manifest；这里保存
    // 稳定 pointer + 可审计生成元数据，后续下载器再把它映射到本地 blob。
    for (const asset of extractImageAssets(message.raw)) {
      structuredAssetPointers.add(asset.assetPointer)
      pushUnique(items, {
        kind: asset.generated ? 'generated-image' : 'image-asset',
        messageId: message.id,
        label: asset.fileId ?? asset.assetPointer,
        data: {
          partIndex: asset.partIndex,
          assetPointer: asset.assetPointer,
          fileId: asset.fileId,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          width: asset.width,
          height: asset.height,
          genId: asset.genId,
          parentGenId: asset.parentGenId,
          orientation: asset.orientation,
          transparentBackground: asset.transparentBackground,
          generated: asset.generated,
        },
      }, seen)
    }

    // sandbox 文件一般只是 assistant 正文中的 Markdown URL，不是独立 attachment 节点。
    for (const match of message.text.matchAll(SANDBOX_RE)) {
      // Markdown 链接形如 `(sandbox:/mnt/data/a.zip)`；正则允许文件名含括号，
      // 因此这里把链接语法产生的尾部 `)` 归一化掉。
      const sandboxUrl = match[0].replace(/\)+$/u, '')
      pushUnique(items, {
        kind: 'sandbox-file',
        messageId: message.id,
        label: sandboxUrl,
        data: { url: sandboxUrl },
      }, seen)
    }

    // 用户上传图片/语音等可能以 sediment:// 等 pointer 出现；这里只建目录，不主动下载。
    const rawString = JSON.stringify(message.raw)
    for (const match of rawString.matchAll(ASSET_POINTER_RE)) {
      // 已经由 image_asset_pointer 结构化保存的 pointer 不再重复降级成 generic scheme。
      if (structuredAssetPointers.has(match[0])) continue
      pushUnique(items, {
        kind: 'asset-pointer',
        messageId: message.id,
        label: match[0].split('://')[0] ?? 'asset',
        data: { scheme: match[0].split('://')[0] },
      }, seen)
    }
  }

  return {
    conversationId: conversation.conversationId,
    title: conversation.title,
    items,
  }
}
