/**
 * Channel-name patterns (T1298) — the ONE rule for "which channels of a bag", with a home.
 *
 * TouchDesigner puts a channel-pattern field on many CHOPs, and the owner's steer was that
 * Loom should carry "the same code core" rather than one matcher per node. So this module
 * owns the matcher and every consumer calls it: `valueSelect` first, a later Rename node,
 * the inspector's channel filter. One rule spelled in six places produced a real defect
 * (§V960); one rule in one module cannot drift from itself.
 *
 * It lives in `@domain` because every consumer can import that: node definitions (which may
 * not reach `src/editor`, §V11), the inspector, `src/agent` and `src/mcp`. The two
 * subsequence matchers in the editor (`palette/fuzzy.ts`, `library/search.ts`) are the
 * wrong semantics for this — they match `lvl` inside `level`, and a channel pattern must not.
 *
 * ## The syntax (TD's Select CHOP subset)
 *
 *   `*`       any run of characters, including none
 *   `?`       exactly one character
 *   `[abc]`   one character from a set; `[a-z]`, `[0-9]` ranges inside it
 *   `[1-12]`  a NUMBER range — the whole bracket is a run of digits between the bounds,
 *             so `chan[1-12]` matches `chan10`, which no character set can express
 *   `^x`      removes what `x` matches from the selection so far; when the FIRST pattern
 *             is an exclusion, the selection starts from every channel (`^onset*` alone is
 *             "everything except the onsets")
 *
 * Patterns are separated by spaces or commas. Anything else is literal. `{a,b}` alternation
 * is not supported: no shipped channel set has needed it.
 *
 * ## Order is a feature
 *
 * `selectChannels` returns PATTERN order, then publication order within one pattern, with
 * no channel twice. So `high low` puts `high` first: that is what makes a Select a reorder
 * as well as a filter, as TD's is. One limit comes from the bag itself rather than from
 * here: a bag is a plain object, and JavaScript iterates integer-like keys (`0`, `12`) in
 * ascending order before the rest, so a bag built from this order keeps it for every
 * channel name except those.
 */

export interface ChannelPattern {
  /** The pattern as written, without its `^`. */
  readonly source: string;
  /** A `^` pattern: removes its matches from the selection so far. */
  readonly exclude: boolean;
  readonly regex: RegExp;
}

/** Numeric ranges wider than this are refused as ranges and read as a character set. */
const MAX_NUMERIC_RANGE = 1000;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** One bracket's body as a regex fragment: a number range, or a character set. */
function bracket(body: string): string {
  const numeric = /^(\d+)-(\d+)$/.exec(body);
  if (numeric !== null) {
    const lo = Number(numeric[1]);
    const hi = Number(numeric[2]);
    if (lo <= hi && hi - lo <= MAX_NUMERIC_RANGE) {
      const choices: string[] = [];
      for (let n = hi; n >= lo; n -= 1) choices.push(String(n)); // longest first
      return `(?:${choices.join("|")})`;
    }
  }
  // A character set. Ranges survive (`a-z`); anything a class would read specially is
  // escaped, so `[^x]` is a set containing `^` and `x`, never a negation.
  let set = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    const next = body[i + 1];
    const after = body[i + 2];
    if (next === "-" && after !== undefined) {
      set += `${escapeRegExp(char)}-${escapeRegExp(after)}`;
      i += 2;
    } else {
      set += escapeRegExp(char);
    }
  }
  return set === "" ? "(?!)" : `[${set}]`;
}

/** Compile one glob to an anchored RegExp. Everything that is not syntax is literal. */
function compile(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      out += ".*";
    } else if (char === "?") {
      out += ".";
    } else if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += escapeRegExp(char); // an unclosed bracket is a literal `[`
      } else {
        out += bracket(glob.slice(i + 1, close));
        i = close;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^${out}$`);
}

/** Space- or comma-separated patterns; `^` in front of one makes it an exclusion. */
export function parseChannelPatterns(source: string): readonly ChannelPattern[] {
  return source
    .split(/[\s,]+/)
    .filter((token) => token !== "" && token !== "^")
    .map((token) => {
      const exclude = token.startsWith("^");
      const glob = exclude ? token.slice(1) : token;
      return { source: glob, exclude, regex: compile(glob) };
    });
}

export function matchesChannel(name: string, pattern: ChannelPattern): boolean {
  return pattern.regex.test(name);
}

/**
 * The selected channel names, in PATTERN order then publication order, each once.
 *
 * Patterns apply left to right: an inclusion appends its matches that are not already
 * selected; an exclusion removes its matches from what is selected so far. A list that
 * OPENS with an exclusion starts from every name. No patterns select nothing.
 */
export function selectChannels(names: readonly string[], patterns: readonly ChannelPattern[]): readonly string[] {
  let selected: string[] = patterns[0]?.exclude === true ? [...names] : [];
  for (const pattern of patterns) {
    if (pattern.exclude) {
      selected = selected.filter((name) => !matchesChannel(name, pattern));
      continue;
    }
    for (const name of names) {
      if (matchesChannel(name, pattern) && !selected.includes(name)) selected.push(name);
    }
  }
  return selected;
}
