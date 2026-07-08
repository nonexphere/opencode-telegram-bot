import type { Context, NextFunction } from "grammy";
import { resolveInteractionGuardDecision } from "./interaction-guard-decision.js";
import type { BlockReason, InteractionKind } from "../../app/types/interaction.js";
import { reconcileForegroundBusyState } from "../../app/services/run-control-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import {
  promptQueueManager,
  type QueuedPrompt,
} from "../../app/managers/prompt-queue-manager.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";

function getInteractionBlockedMessage(
  reason: BlockReason | undefined,
  interactionKind: InteractionKind | undefined,
): string {
  if (interactionKind === "permission") {
    switch (reason) {
      case "command_not_allowed":
        return t("permission.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("permission.blocked.expected_reply");
    }
  }

  if (interactionKind === "inline") {
    switch (reason) {
      case "command_not_allowed":
        return t("inline.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("inline.blocked.expected_choice");
    }
  }

  if (interactionKind === "question") {
    switch (reason) {
      case "command_not_allowed":
        return t("question.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("question.blocked.expected_answer");
    }
  }

  if (interactionKind === "rename") {
    switch (reason) {
      case "command_not_allowed":
        return t("rename.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("rename.blocked.expected_name");
    }
  }

  if (interactionKind === "task") {
    switch (reason) {
      case "command_not_allowed":
        return t("task.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("task.blocked.expected_input");
    }
  }

  switch (reason) {
    case "expired":
      return t("interaction.blocked.expired");
    case "expected_callback":
      return t("interaction.blocked.expected_callback");
    case "expected_command":
      return t("interaction.blocked.expected_command");
    case "command_not_allowed":
      return t("interaction.blocked.command_not_allowed");
    case "expected_text":
    default:
      return t("interaction.blocked.expected_text");
  }
}

export async function interactionGuardMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  let decision = resolveInteractionGuardDecision(ctx);

  if (!decision.allow && decision.busy) {
    await reconcileForegroundBusyState();
    decision = resolveInteractionGuardDecision(ctx);
  }

  if (decision.allow) {
    await next();
    return;
  }

  // Busy + text input + no pending question/permission/rename/task interaction:
  // enqueue the prompt instead of blocking, so the user can queue follow-ups
  // while the assistant is still running.
  const isPendingInteraction =
    decision.state?.kind === "question" ||
    decision.state?.kind === "permission" ||
    decision.state?.kind === "rename" ||
    decision.state?.kind === "task" ||
    decision.state?.kind === "inline" ||
    decision.state?.kind === "custom";

  if (
    decision.busy &&
    !isPendingInteraction &&
    decision.inputType === "text" &&
    !decision.command
  ) {
    const text = ctx.message?.text;
    if (typeof text === "string" && text.trim().length > 0) {
      const currentSession = getCurrentSession();
      if (currentSession) {
        const queued: QueuedPrompt = {
          sessionId: currentSession.id,
          directory: currentSession.directory,
          text,
          fileParts: [],
          agent: getStoredAgent(),
          enqueuedAt: Date.now(),
        };
        const position = promptQueueManager.enqueue(queued);
        logger.info(
          `[InteractionGuard] Enqueued prompt while busy: session=${currentSession.id}, position=${position}`,
        );
        await ctx.reply(t("bot.queue_enqueued", { position })).catch((err) => {
          logger.error("[InteractionGuard] Failed to send queue ack:", err);
        });
        return;
      }
    }
  }

  const message = decision.busy
    ? decision.state?.kind === "question" || decision.state?.kind === "permission"
      ? getInteractionBlockedMessage(decision.reason, decision.state.kind)
      : t("bot.session_busy")
    : getInteractionBlockedMessage(decision.reason, decision.state?.kind);

  logger.debug(
    `[InteractionGuard] Blocked input: interactionKind=${decision.state?.kind || "none"}, inputType=${decision.inputType}, reason=${decision.reason || "unknown"}, command=${decision.command || "-"}, busy=${decision.busy ? "yes" : "no"}`,
  );

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: message }).catch(() => {});
    return;
  }

  if (ctx.chat) {
    await ctx.reply(message).catch((err) => {
      logger.error("[InteractionGuard] Failed to send blocked input message:", err);
    });
  }
}
