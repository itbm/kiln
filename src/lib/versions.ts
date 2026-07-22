import type { Generation, Message } from "./types"

/** Snapshot the message's active generation. */
export function snapshotGeneration(msg: Message): Generation {
  return {
    content: msg.content,
    reasoning: msg.reasoning,
    reasoningMs: msg.reasoningMs,
    steps: msg.steps,
    images: msg.images,
    provider: msg.provider,
    model: msg.model,
    modelName: msg.modelName,
    effort: msg.effort,
    status: msg.status,
    error: msg.error,
    createdAt: msg.createdAt,
    usage: msg.usage,
  }
}

export function versionCount(msg: Message): number {
  return (msg.versions?.length ?? 0) + 1
}

/** 0-based position of the active generation in the full ordering. */
export function activeVersionIndex(msg: Message): number {
  return msg.versionIndex ?? msg.versions?.length ?? 0
}

/** All generations in order, including the active one. */
export function fullVersionList(msg: Message): Generation[] {
  const full = [...(msg.versions ?? [])]
  full.splice(activeVersionIndex(msg), 0, snapshotGeneration(msg))
  return full
}

/** Returns a copy of the message with the generation at `target` active. */
export function switchToVersion(msg: Message, target: number): Message {
  const full = fullVersionList(msg)
  const clamped = Math.max(0, Math.min(target, full.length - 1))
  const chosen = full[clamped]
  const rest = full.filter((_, i) => i !== clamped)
  return {
    ...msg,
    ...chosen,
    // active generation's fields replace the message's; clear leftovers
    reasoning: chosen.reasoning,
    reasoningMs: chosen.reasoningMs,
    steps: chosen.steps,
    images: chosen.images,
    error: chosen.error,
    usage: chosen.usage,
    versions: rest,
    versionIndex: clamped,
  }
}

/**
 * Prepare a message for regeneration: current generation is archived and the
 * message is reset to stream a fresh one (appended as the newest version).
 */
export function beginNewVersion(msg: Message): Message {
  const versions = [...(msg.versions ?? [])]
  versions.splice(activeVersionIndex(msg), 0, snapshotGeneration(msg))
  return {
    ...msg,
    content: "",
    reasoning: undefined,
    reasoningMs: undefined,
    steps: undefined,
    images: undefined,
    error: undefined,
    usage: undefined,
    status: "pending",
    versions,
    versionIndex: versions.length,
  }
}
