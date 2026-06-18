// `ask_expert`: deliver a question to an expert (ask mode) or relay an answer
// back to the asker (reply mode). Mirrors `ask.rs`.

import { InvokeContext } from "./lib";
import { loadExperts, resolveExpert } from "./experts";
import { resumeSession } from "./host";

export function askExpert(args: any, ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const answer: string | undefined =
    typeof a.answer === "string" ? a.answer : undefined;
  const replyTo: string | undefined =
    typeof a.reply_to_session_id === "string"
      ? a.reply_to_session_id
      : undefined;
  const expertId: string | undefined =
    typeof a.expert_id === "string" ? a.expert_id : undefined;
  const area: string | undefined = typeof a.area === "string" ? a.area : undefined;
  const question: string | undefined =
    typeof a.question === "string" ? a.question : undefined;

  // Reply mode: an expert delivering its answer back to the asker.
  if (answer !== undefined && replyTo !== undefined) {
    const msg = `[Expert answer]\n\n${answer}`;
    resumeSession({ session_id: replyTo, text: msg });
    return { delivered: true, reply_to_session_id: replyTo };
  }

  const q =
    question !== undefined && question.trim() !== "" ? question : undefined;
  if (q === undefined) {
    throw new Error(
      "question is required (or provide answer + reply_to_session_id to reply)",
    );
  }

  const experts = loadExperts(false);
  if (experts.length === 0) {
    throw new Error(
      "no experts are available in your scope; run spin_up_experts first",
    );
  }

  // The "pm" shorthand resolves to the project's PM expert (kind == "pm").
  let target;
  if (isPmHint(expertId) || isPmHint(area)) {
    target = experts.find((e) => e.meta.kind === "pm");
    if (!target) {
      throw new Error(
        "no PM expert found in your scope; run spin_up_experts first",
      );
    }
  } else {
    target = resolveExpert(experts, expertId, area);
    if (!target) {
      throw new Error("no matching expert found in your scope");
    }
  }

  const targetId = target.session?.id;
  if (typeof targetId !== "string") {
    throw new Error("resolved expert has no id");
  }

  const msg =
    `[Consultation from session ${ctx.session_id}]\n\n${q}\n\n` +
    `Reply with ask_expert: set \`answer\` and \`reply_to_session_id\` = "${ctx.session_id}".`;
  resumeSession({ session_id: targetId, text: msg });

  return {
    delivered: true,
    expert_id: targetId,
    area: target.meta.area,
    expert_kind: target.meta.kind,
    question: q,
  };
}

export function isPmHint(s: string | null | undefined): boolean {
  if (s === null || s === undefined) {
    return false;
  }
  return s.trim().toLowerCase() === "pm";
}
