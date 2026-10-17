/**
 * Small unified-diff generator (line based). Common prefix/suffix are trimmed
 * first, then an LCS table is computed over the changed middle (bounded); if
 * the middle is too large the whole middle is shown as one replacement hunk.
 */

type Op = { t: " " | "-" | "+"; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n * m > 4_000_000) return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ t: " ", line: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", line: a[i++] });
		else ops.push({ t: "+", line: b[j++] });
	}
	while (i < n) ops.push({ t: "-", line: a[i++] });
	while (j < m) ops.push({ t: "+", line: b[j++] });
	return ops;
}

export function diffOps(oldText: string, newText: string): Op[] {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	return [
		...a.slice(0, pre).map((line) => ({ t: " " as const, line })),
		...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
		...a.slice(a.length - suf).map((line) => ({ t: " " as const, line })),
	];
}

export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): string {
	if (oldText === newText) return "";
	const ops = diffOps(oldText, newText);
	const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
	let idx = 0;
	let oldLine = 1;
	let newLine = 1;
	const oldAt: number[] = [];
	const newAt: number[] = [];
	for (const op of ops) {
		oldAt.push(oldLine);
		newAt.push(newLine);
		if (op.t !== "+") oldLine++;
		if (op.t !== "-") newLine++;
	}
	while (idx < ops.length) {
		while (idx < ops.length && ops[idx].t === " ") idx++;
		if (idx >= ops.length) break;
		const start = Math.max(0, idx - context);
		let end = idx;
		let lastChange = idx;
		while (end < ops.length) {
			if (ops[end].t !== " ") lastChange = end;
			else if (end - lastChange > context * 2) break;
			end++;
		}
		end = Math.min(ops.length, lastChange + context + 1);
		const slice = ops.slice(start, end);
		const oldCount = slice.filter((o) => o.t !== "+").length;
		const newCount = slice.filter((o) => o.t !== "-").length;
		out.push(`@@ -${oldCount ? oldAt[start] : oldAt[start] - 1},${oldCount} +${newCount ? newAt[start] : newAt[start] - 1},${newCount} @@`);
		for (const o of slice) out.push(`${o.t}${o.line}`);
		idx = end;
	}
	return out.join("\n");
}
