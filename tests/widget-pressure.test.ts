import { describe, expect, test } from 'vitest'
import { analyzeWidgetPressure } from '../src/core/widget-pressure'
import type { MessagesConversationPayload, RawChatMessage } from '../src/core/types'

function sdkMessage(
  id: string,
  turnExchangeId: string,
  role: 'assistant' | 'tool',
  resourceName = 'devspace_bash',
): RawChatMessage {
  return {
    id,
    author: { role },
    recipient: role === 'assistant' ? 'api_tool.call_tool' : 'all',
    content: { content_type: 'code', text: '{}' },
    metadata: {
      turn_exchange_id: turnExchangeId,
      chatgpt_sdk: {
        resource_name: resourceName,
        html_asset_pointer: 'ui://devspace/workspace-app.html',
      },
    },
  }
}

function payload(messages: RawChatMessage[]): MessagesConversationPayload {
  return {
    conversation_id: 'widget-pressure-fixture',
    current_node: messages.at(-1)?.id,
    messages,
  }
}

describe('Apps SDK Widget 压力分析', () => {
  test('没有 SDK 节点时为 none', () => {
    const report = analyzeWidgetPressure(payload([
      {
        id: 'u1',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['hello'] },
        metadata: {},
      },
    ]))

    expect(report.sdkNodeCount).toBe(0)
    expect(report.devspaceSdkNodeCount).toBe(0)
    expect(report.interpretation).toBe('none')
  })

  test('统计 assistant/tool 两侧 SDK 节点和资源类型', () => {
    const report = analyzeWidgetPressure(payload([
      sdkMessage('a1', 'turn-a', 'assistant'),
      sdkMessage('t1', 'turn-a', 'tool'),
      sdkMessage('a2', 'turn-b', 'assistant', 'devspace_read'),
    ]))

    expect(report.sdkNodeCount).toBe(3)
    expect(report.devspaceSdkNodeCount).toBe(3)
    expect(report.assistantSdkNodes).toBe(2)
    expect(report.toolSdkNodes).toBe(1)
    expect(report.turnCount).toBe(2)
    expect(report.maxSdkNodesInOneTurn).toBe(2)
    expect(report.topAssetPointers[0]).toEqual({
      value: 'ui://devspace/workspace-app.html',
      count: 3,
    })
  })

  test('单轮超过 150 个 widget 即判为 extreme', () => {
    const messages: RawChatMessage[] = []
    for (let index = 0; index < 160; index += 1) {
      messages.push(sdkMessage(`m-${index}`, 'huge-turn', index % 2 === 0 ? 'assistant' : 'tool'))
    }

    const report = analyzeWidgetPressure(payload(messages))
    expect(report.sdkNodeCount).toBe(160)
    expect(report.maxSdkNodesInOneTurn).toBe(160)
    expect(report.maxTurnExchangeId).toBe('huge-turn')
    expect(report.interpretation).toBe('extreme')
  })
})
