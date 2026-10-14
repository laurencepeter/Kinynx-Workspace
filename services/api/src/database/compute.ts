/**
 * Safe formula evaluation for database "formula" properties — a tiny
 * recursive-descent arithmetic parser. NO eval / Function: only numbers,
 * + - * /, parentheses, unary minus, and property references written as
 * [Property Name]. Unknown or non-numeric references resolve to 0.
 *
 * Kept pure so it is fully unit-testable and cannot execute arbitrary code.
 */
export type RefResolver = (name: string) => number;

export function evaluateFormula(expression: string, resolve: RefResolver): number {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  // expr = term (('+'|'-') term)*
  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t === "+" || t === "-") {
        next();
        const rhs = parseTerm();
        value = t === "+" ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }
  // term = factor (('*'|'/') factor)*
  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      const t = peek();
      if (t === "*" || t === "/") {
        next();
        const rhs = parseFactor();
        value = t === "*" ? value * rhs : rhs === 0 ? 0 : value / rhs;
      } else break;
    }
    return value;
  }
  // factor = '-' factor | '(' expr ')' | number | [ref]
  function parseFactor(): number {
    const t = peek();
    if (t === "-") {
      next();
      return -parseFactor();
    }
    if (t === "(") {
      next();
      const v = parseExpr();
      if (peek() === ")") next();
      return v;
    }
    if (t === undefined) return 0;
    next();
    if (t.startsWith("[") && t.endsWith("]")) {
      const n = resolve(t.slice(1, -1).trim());
      return Number.isFinite(n) ? n : 0;
    }
    const num = Number(t);
    return Number.isFinite(num) ? num : 0;
  }

  const result = parseExpr();
  return Number.isFinite(result) ? result : 0;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === " " || c === "\t") { i++; continue; }
    if ("+-*/()".includes(c)) { tokens.push(c); i++; continue; }
    if (c === "[") {
      const end = expr.indexOf("]", i);
      if (end === -1) { tokens.push(expr.slice(i)); break; }
      tokens.push(expr.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // number (optionally decimal)
    let j = i;
    while (j < expr.length && /[0-9.]/.test(expr[j]!)) j++;
    if (j > i) { tokens.push(expr.slice(i, j)); i = j; continue; }
    i++; // skip anything unrecognized
  }
  return tokens;
}

/** Aggregate a list of numeric values for a rollup property. */
export function aggregate(values: number[], agg: string): number {
  const nums = values.filter((n) => Number.isFinite(n));
  switch (agg) {
    case "count":
      return values.length;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4) : 0;
    case "min":
      return nums.length ? Math.min(...nums) : 0;
    case "max":
      return nums.length ? Math.max(...nums) : 0;
    default:
      return values.length; // default to count
  }
}
