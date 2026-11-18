// The rolling-window selector: apply/advance a stable cut frontier over wire messages, inject a
// deterministic paging notice, protect the active request and newest unread tool results.
// Ported from context-policy.ts of @rochecompaan/pi-context-paging 0.3.11 (MIT, © Roché Compaan).
import { groupTurns } from "./turns.mjs";
import { EvictedConversation, pagingNoticeText, protectedOverflowNoticeText } from "./notice.mjs";
import { noticeMessage, residentEstimate, stableHash, userTextOf, assistantTextOf, toolResultsOf, toolUsesOf } from "./wire.mjs";

/**
 * Adjusts the cut boundary so the kept slice can be made pair-consistent. ZCode batches
 * `<system-reminder>` text into result messages, so a user message that carries tool
 * results can also classify as a turn start; a boundary there orphans the results of
 * evicted tool calls and the provider rejects the request (400 "unexpected tool_use_id
 * found in tool_result blocks"). The repair walks the kept slice, collects every dangling
 * result, and pulls the declaring assistant messages back into the kept slice — repeat
 * until stable. Bound by MAX_PAIRING_PASSES: each pass moves the boundary back at least
 * one message or stops. Results whose declaring assistant is absent from the resent
 * history entirely (aborted calls) cannot be paired by any boundary; finish() strips
 * those blocks instead.
 */
const MAX_PAIRING_PASSES = 64;

function repairPairingBoundary(messages, shape, boundary) {
	let current = boundary;
	for (let pass = 0; pass < MAX_PAIRING_PASSES; pass++) {
		const keptUses = new Set();
		for (let index = current; index < messages.length; index++) {
			for (const use of toolUsesOf(messages[index])) keptUses.add(use.id);
		}
		const dangling = [];
		for (let index = current; index < messages.length; index++) {
			for (const result of toolResultsOf(messages[index], shape)) {
				if (!keptUses.has(result.toolCallId) && !dangling.includes(result.toolCallId)) dangling.push(result.toolCallId);
			}
		}
		if (dangling.length === 0) return current;
		// Pull the declaring assistant back into the kept slice: that restores the pair and
		// keeps the (possibly fresh) result readable by the model.
		let pulled = false;
		for (let index = current - 1; index >= 0; index--) {
			if (toolUsesOf(messages[index]).some((use) => dangling.includes(use.id))) {
				current = index;
				pulled = true;
				break;
			}
		}
		if (!pulled) return current; // unpairable remainder (aborted calls); finish() strips it
	}
	return current;
}

/**
 * Rewrites the kept slice into a pair-consistent conversation: every tool_result keeps a
 * matching tool_use in an earlier kept assistant message and vice versa. Unpairable blocks
 * (aborted calls whose partner is nowhere in the resent history, or pairs split by a
 * boundary the pull-back could not repair) are stripped block-wise, and messages left
 * without any content are dropped outright.
 */
function sanitizeKeptSlice(slice, shape) {
	const uses = new Set();
	for (const message of slice) {
		if (message.role !== "assistant") continue;
		for (const use of toolUsesOf(message)) uses.add(use.id);
	}
	const results = new Set();
	for (const message of slice) {
		for (const result of toolResultsOf(message, shape)) results.add(result.toolCallId);
	}
	const out = [];
	for (const message of slice) {
		const messageResults = toolResultsOf(message, shape);
		const messageUses = message.role === "assistant" ? toolUsesOf(message) : [];
		if (messageResults.length === 0 && messageUses.length === 0) { out.push(message); continue; }
		if (shape === "anthropic" && Array.isArray(message.content)) {
			const content = message.content.filter((block) => {
				if (block?.type === "tool_result") return uses.has(block.tool_use_id);
				if (block?.type === "tool_use") return results.has(block.id);
				return true;
			});
			if (content.length === 0) continue; // carrier stripped bare
			out.push(content.length === message.content.length ? message : { ...message, content });
		} else if (message.role === "tool") {
			// OpenAI result message: the whole message is one result.
			if (messageUses.length > 0 || (message.tool_call_id && uses.has(message.tool_call_id))) out.push(message);
			continue;
		} else {
			out.push(message);
		}
	}
	return out;
}

/**
 * @param {object} input
 * @param body            parsed request body (a paged copy is returned; the input is not mutated)
 * @param shape           "anthropic" | "openai"
 * @param budgetTokens    effective budget (already ≤ model window)
 * @param trimToTokens    trim destination when the budget is crossed
 * @param state           remembered { frontierIndex, frontierHash, noticeText } | null
 * @param estimateMessage (message) → estimated tokens
 * @param resolveId       (message) → stable recovery historyId | undefined
 * @param toolNameOf      (message, toolCallId) → tool name | undefined
 */
export function selectContext(input) {
	const { body, shape, budgetTokens, trimToTokens, state, estimateMessage, resolveId, toolNameOf } = input;
	const messages = body.messages ?? [];
	if (!Array.isArray(messages) || messages.length === 0) {
		return { body, mode: "within-budget", frontier: undefined, sentMessages: 0, estimatedTokens: 0, evicted: 0 };
	}
	const resident = residentEstimate(body, (text) => estimateMessage({ role: "user", content: text }));
	const estimates = messages.map(estimateMessage);
	const sumFrom = (index) => estimates.slice(index).reduce((sum, value) => sum + value, 0);
	const noticeTokens = (text) => text === null ? 0 : estimateMessage({ role: "user", content: text });
	const retainedAt = (index, text) => resident + sumFrom(index) + noticeTokens(text);

	// 1. Apply the remembered frontier. A hash mismatch means history was rewritten
	//    (compaction, edit, fork): reset the cut and recompute from scratch.
	let boundary = 0;
	if (state && Number.isInteger(state.frontierIndex) && state.frontierIndex > 0) {
		const anchor = messages[state.frontierIndex];
		if (anchor !== undefined && stableHash(anchor) === state.frontierHash) {
			boundary = state.frontierIndex;
		}
	}
	// A boundary that orphans tool results produces a request the provider rejects, so the
	// remembered cut is repaired before anything else looks at it. A moved boundary also
	// invalidates the stored notice text (it describes a different eviction set).
	const remembered = boundary;
	boundary = repairPairingBoundary(messages, shape, boundary);
	const noticeUnchanged = boundary === remembered && remembered > 0;

	// 2. Within budget (or exactly at it): no new cut. Reuse the stored notice text so the
	//    request prefix — and therefore the provider prompt cache — stays identical.
	if (boundary === 0) {
		if (retainedAt(0, null) <= budgetTokens) return finish("within-budget", 0, null);
	} else if (noticeUnchanged && retainedAt(boundary, state.noticeText) <= budgetTokens) {
		return finish("paged", boundary, state.noticeText);
	}

	// 3. Budget crossed: evict whole completed turns oldest first, then older exchanges of the
	//    active turn, until the retained request is at or below the trim target.
	const { units } = groupTurns(messages, shape);
	const destination = Math.min(trimToTokens, budgetTokens);
	let noticeText = noticeUnchanged ? state.noticeText : null;
	for (const unit of units) {
		if (unit.protected || unit.from < boundary) continue;
		if (retainedAt(boundary, noticeText) <= destination) break;
		boundary = unit.to;
		noticeText = null; // provisional; the real notice is rebuilt once, below
	}
	// Safety valve: never evict the entire request; the newest message always stays.
	boundary = Math.min(boundary, Math.max(0, messages.length - 1));
	// The loop can stop on a turn start that rides inside a result carrier (ZCode batches
	// reminders into result messages), which orphans the results of evicted tool calls.
	boundary = repairPairingBoundary(messages, shape, boundary);

	// 4. Rebuild the notice once at the final boundary, from ALL evicted turns — both the ones
	//    this request evicted and the ones earlier cuts evicted (the full history is resent every
	//    request, so the copied conversation reproduces deterministically).
	const conversation = new EvictedConversation();
	let evictedId;
	let toolReference;
	for (const unit of units) {
		if (unit.kind !== "completedTurn" || unit.to > boundary) continue;
		conversation.addTurn(entriesForTurn(unit));
	}
	for (let index = 0; index < boundary; index++) {
		const message = messages[index];
		const id = resolveId?.(message);
		if (id !== undefined) evictedId = id;
		for (const result of toolResultsOf(message, shape)) {
			if (id !== undefined) toolReference = {
				historyId: id,
				toolCallId: result.toolCallId,
				toolName: result.toolName ?? toolNameOf?.(message, result.toolCallId) ?? "tool",
			};
		}
	}
	// The copied conversation may use only the room left once every evictable unit is gone,
	// so it never turns a request that fit with the plain notice into an error.
	const protectedTokens = units
		.filter((unit) => unit.protected)
		.reduce((sum, unit) => sum + estimates.slice(unit.from, unit.to).reduce((a, b) => a + b, 0), 0);
	const conversationRoom = Math.max(0, budgetTokens - resident - protectedTokens) * 4;
	noticeText = pagingNoticeText(budgetTokens, evictedId, toolReference, conversation, conversationRoom);

	let mode = "paged";
	if (retainedAt(boundary, noticeText) > budgetTokens) {
		// Everything evictable is gone; the overflow is protected content. Keep it in full for
		// this one call, with the minimal overflow notice, exactly like the package.
		noticeText = protectedOverflowNoticeText(budgetTokens);
		mode = "protected-overflow";
	}
	return finish(mode, boundary, noticeText);

	function entriesForTurn(unit) {
		const entries = [];
		const first = messages[unit.from];
		const requestText = first && first.role === "user" ? userTextOf(first) : "";
		const firstId = first === undefined ? undefined : resolveId?.(first);
		if (requestText.trim() !== "" && firstId !== undefined) {
			entries.push({ kind: "user message", historyId: firstId, text: requestText, part: "/user/content" });
		}
		for (let index = unit.to - 1; index > unit.from; index--) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const text = assistantTextOf(message);
			if (text.trim() === "") continue;
			const id = resolveId?.(message);
			if (id === undefined) break;
			entries.push({ kind: "assistant reply", historyId: id, text, part: "/assistant/text" });
			break;
		}
		return entries;
	}

	function finish(mode, boundary, noticeText) {
		const kept = sanitizeKeptSlice(messages.slice(boundary), shape);
		const out = { ...body };
		out.messages = noticeText === null ? kept : [noticeMessage(shape, noticeText), ...kept];
		return {
			body: out,
			mode,
			frontier: boundary > 0
				? { frontierIndex: boundary, frontierHash: stableHash(messages[boundary]), noticeText }
				: undefined,
			sentMessages: out.messages.length,
			estimatedTokens: retainedAt(boundary, noticeText),
			evictedTokens: estimates.slice(0, boundary).reduce((sum, value) => sum + value, 0),
			evicted: boundary,
		};
	}
}
