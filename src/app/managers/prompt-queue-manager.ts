import { type Bot, type Context } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { opencodeClient } from "../../opencode/client.js";
import { foregroundSessionState } from "./foreground-session-state-manager.js";
import { attachManager } from "./attach-manager.js";
import { assistantRunState } from "./assistant-run-state-manager.js";
import { markAttachedSessionBusy } from "../services/attach-service.js";

export interface QueuedPrompt {
  sessionId: string;
  directory: string;
  text: string;
  fileParts: FilePartInput[];
  agent: string | undefined;
  enqueuedAt: number;
}

export type Dispatcher = (
  prompt: QueuedPrompt,
  bot: Bot<Context>,
  chatId: number,
) => Promise<void>;

class PromptQueueManager {
  private queue: QueuedPrompt[] = [];
  private bot: Bot<Context> | null = null;
  private chatId: number | null = null;
  private dispatcher: Dispatcher | null = null;

  setContext(bot: Bot<Context>, chatId: number): void {
    this.bot = bot;
    this.chatId = chatId;
  }

  setDispatcher(dispatcher: Dispatcher): void {
    this.dispatcher = dispatcher;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private hasPendingForSession(sessionId: string): boolean {
    return this.queue.some((p) => p.sessionId === sessionId);
  }

  enqueue(prompt: QueuedPrompt): number {
    if (this.hasPendingForSession(prompt.sessionId)) {
      logger.warn(`[PromptQueue] Duplicate enqueue suppressed for session=${prompt.sessionId}`);
    }
    this.queue.push(prompt);
    const position = this.queue.length;
    logger.info(
      `[PromptQueue] Enqueued: session=${prompt.sessionId}, position=${position}, textLen=${prompt.text.length}`,
    );
    return position;
  }

  maybeDequeue(sessionId: string): QueuedPrompt | null {
    if (this.queue.length === 0) return null;
    const idx = this.queue.findIndex((p) => p.sessionId === sessionId);
    if (idx === -1) return null;
    const [item] = this.queue.splice(idx, 1);
    return item;
  }

  clearQueueForSession(sessionId: string, reason: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((p) => p.sessionId !== sessionId);
    const dropped = before - this.queue.length;
    if (dropped > 0) {
      logger.info(`[PromptQueue] Cleared ${dropped} queued prompts for session=${sessionId} reason=${reason}`);
    }
  }

  clearAll(reason: string): void {
    if (this.queue.length === 0) return;
    logger.info(`[PromptQueue] Cleared all (${this.queue.length}) queued prompts: reason=${reason}`);
    this.queue = [];
  }

  /** Called when a session becomes idle. Dispatches the next queued prompt if any. */
  async dispatchNextForSession(sessionId: string, directory: string): Promise<void> {
    if (!this.bot || this.chatId === null || !this.dispatcher) {
      logger.warn("[PromptQueue] Cannot dispatch: context/dispatcher not set");
      // Still drain queue to avoid silent accumulation
      this.clearQueueForSession(sessionId, "no_dispatcher");
      return;
    }

    const next = this.maybeDequeue(sessionId);
    if (!next) return;

    // Sanity: ensure session is actually idle before dispatching
    const busy = foregroundSessionState.isBusy() || attachManager.isBusy();
    if (busy) {
      logger.warn(`[PromptQueue] Session ${sessionId} still busy at dispatch time; re-queueing head`);
      this.queue.unshift(next);
      return;
    }

    logger.info(
      `[PromptQueue] Dispatching next queued prompt: session=${sessionId}, remaining=${this.queue.length}, textLen=${next.text.length}`,
    );

    try {
      await this.bot.api.sendMessage(this.chatId, t("bot.queue_dispatching")).catch(() => undefined);
    } catch (err) {
      logger.warn("[PromptQueue] Failed to send dispatch notice:", err);
    }

    try {
      await this.dispatcher(next, this.bot, this.chatId);
    } catch (err) {
      logger.error("[PromptQueue] Dispatcher threw:", err);
      foregroundSessionState.markIdle(sessionId);
      await markAttachedSessionIdleSafe(sessionId);
      try {
        await this.bot?.api.sendMessage(this.chatId!, t("bot.prompt_send_error")).catch(() => undefined);
      } catch {
        // best-effort
      }
    }
  }

  __resetForTests(): void {
    this.queue = [];
    this.bot = null;
    this.chatId = null;
    this.dispatcher = null;
  }

  __getQueueForTests(): QueuedPrompt[] {
    return [...this.queue];
  }
}

async function markAttachedSessionIdleSafe(sessionId: string): Promise<void> {
  try {
    const { markAttachedSessionIdle } = await import("../services/attach-service.js");
    await markAttachedSessionIdle(sessionId);
  } catch {
    // best-effort
  }
}

export const promptQueueManager = new PromptQueueManager();

/**
 * Default dispatcher: calls opencode session.promptAsync and marks session busy,
 * mirroring processUserPrompt but without a Grammy ctx.
 */
export async function dispatchQueuedPrompt(
  prompt: QueuedPrompt,
  _bot: Bot<Context>,
  _chatId: number,
): Promise<void> {
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (prompt.text.trim().length > 0) {
    parts.push({ type: "text", text: prompt.text });
  }
  parts.push(...prompt.fileParts);
  if (parts.length === 0) {
    parts.push({ type: "text", text: "See queued attachment" });
  }

  const promptOptions = {
    sessionID: prompt.sessionId,
    directory: prompt.directory,
    parts,
    agent: prompt.agent,
  };

  foregroundSessionState.markBusy(prompt.sessionId, prompt.directory);
  await markAttachedSessionBusy(prompt.sessionId);
  assistantRunState.startRun(prompt.sessionId, {
    startedAt: Date.now(),
    configuredAgent: prompt.agent,
  });

  const { error } = await opencodeClient.session.promptAsync(promptOptions);
  if (error) {
    foregroundSessionState.markIdle(prompt.sessionId);
    await markAttachedSessionIdleSafe(prompt.sessionId);
    assistantRunState.clearRun(prompt.sessionId, "queue_dispatch_api_error");
    logger.error("[PromptQueue] promptAsync error during dispatch:", error);
    throw new Error("session.promptAsync failed during queue dispatch");
  }

  logger.info(`[PromptQueue] Dispatched promptAsync accepted: session=${prompt.sessionId}`);
}