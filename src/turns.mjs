// Turn segmentation over wire messages: whole completed turns, evictable model exchanges in the
// active turn, and the protected trailing exchange. Ported from context-policy.ts / history.ts of
// @rochecompaan/pi-context-paging 0.3.11 (MIT, © Roché Compaan).
import { isToolResultCarrier, isTurnStart } from "./wire.mjs";

function exchangeHasUnreadResults(messages, exchange) {
	// The trailing exchange is protected when it carries tool calls whose results no later
	// assistant message has consumed yet (a later assistant request already included them).
	const assistant = messages[exchange.from];
	if (assistant?.role !== "assistant") return false;
	const hasCalls = (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0)
		|| (Array.isArray(assistant.content) && assistant.content.some((block) => block?.type === "tool_use"));
	if (!hasCalls) return false;
	return !messages.slice(exchange.to).some((message) => message.role === "assistant");
}

/**
 * Groups `messages` (wire shape) into eviction units, oldest first:
 *   completedTurn — a user request plus everything up to the next user request.
 *   exchange      — one assistant message plus its result carriers (or a stray non-assistant message).
 * Protected (never evicted): system-role units, the active turn's request, and the newest
 * exchange with unread tool results.
 */
export function groupTurns(messages, shape) {
	const turnStarts = [];
	for (let index = 0; index < messages.length; index++) {
		if (isTurnStart(messages[index], shape)) turnStarts.push(index);
	}
	const units = [];
	const splitExchanges = (from, to) => {
		const exchanges = [];
		for (let index = from; index < to;) {
			const message = messages[index];
			if (message.role === "assistant") {
				let next = index + 1;
				while (next < to && isToolResultCarrier(messages[next], shape)) next++;
				exchanges.push({ kind: "exchange", from: index, to: next });
				index = next;
			} else {
				exchanges.push({ kind: "exchange", from: index, to: index + 1 });
				index++;
			}
		}
		const last = exchanges[exchanges.length - 1];
		for (const exchange of exchanges) {
			const role = messages[exchange.from]?.role;
			units.push({
				...exchange,
				protected: role === "system"
					|| (exchange === last && exchangeHasUnreadResults(messages, exchange)),
			});
		}
	};
	if (turnStarts.length === 0) {
		splitExchanges(0, messages.length);
		if (units[0]) units[0].protected = true; // always retain at least one unit
		return { units, activeRequestFrom: 0 };
	}
	for (let turn = 0; turn < turnStarts.length - 1; turn++) {
		units.push({ kind: "completedTurn", from: turnStarts[turn], to: turnStarts[turn + 1], protected: false });
	}
	const activeFrom = turnStarts[turnStarts.length - 1];
	units.push({ kind: "request", from: activeFrom, to: activeFrom + 1, protected: true });
	splitExchanges(activeFrom + 1, messages.length);
	return { units, activeRequestFrom: activeFrom };
}
