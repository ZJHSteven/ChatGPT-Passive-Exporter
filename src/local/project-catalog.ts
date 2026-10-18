export const PROJECT_SIDEBAR_ROUTE = '/backend-api/gizmos/snorlax/sidebar'

export const PROJECT_SIDEBAR_PATH =
  PROJECT_SIDEBAR_ROUTE + '?conversations_per_gizmo=5&limit=20&owned_only=false'

export interface ProjectCatalogRoute {
  kind: 'project-sidebar' | 'project-catalog'
  gizmoId?: string | null
}

export interface ProjectCatalogProject {
  projectId: string | null
  projectName: string | null
  cursor: unknown
  conversationCount: number
}

export interface ProjectCatalogExtraction {
  projects: ProjectCatalogProject[]
  conversations: Record<string, unknown>[]
  cursor: unknown
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

/**
 * Normalize the two first-party Project catalog response shapes.
 *
 * - sidebar: items[*].gizmo.gizmo + items[*].conversations.{cursor,items}
 * - per-project: top-level {cursor,items}
 *
 * Conversation entries are catalog rows only; canonical Body still comes from the normal
 * /backend-api/conversations/{cid} family.
 */
export function extractProjectCatalogPayload(
  route: ProjectCatalogRoute,
  payload: unknown,
): ProjectCatalogExtraction {
  const root = record(payload)
  const items = Array.isArray(root?.items) ? root.items : []
  const projects: ProjectCatalogProject[] = []
  const conversations: Record<string, unknown>[] = []
  const topCursor = root?.cursor ?? null

  if (route.kind === 'project-sidebar') {
    for (const rawItem of items) {
      const item = record(rawItem)
      if (!item) continue
      const gizmoContainer = record(item.gizmo)
      const gizmo = record(gizmoContainer?.gizmo)
      const display = record(gizmo?.display)
      const nested = record(item.conversations)
      const nestedItems = Array.isArray(nested?.items) ? nested.items : []
      projects.push({
        projectId: typeof gizmo?.id === 'string' ? gizmo.id : null,
        projectName: typeof display?.name === 'string' ? display.name : null,
        cursor: nested?.cursor ?? null,
        conversationCount: nestedItems.length,
      })
      for (const rawConversation of nestedItems) {
        const conversation = record(rawConversation)
        if (conversation) conversations.push(conversation)
      }
    }
  }
  else {
    projects.push({
      projectId: typeof route.gizmoId === 'string' ? route.gizmoId : null,
      projectName: null,
      cursor: topCursor,
      conversationCount: items.length,
    })
    for (const rawConversation of items) {
      const conversation = record(rawConversation)
      if (conversation) conversations.push(conversation)
    }
  }

  return { projects, conversations, cursor: topCursor }
}
