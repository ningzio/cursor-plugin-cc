export function parseArgs(argv, config = {}) {
  const booleans = new Set(config.booleans ?? []);
  const values = new Set(config.values ?? []);
  const options = {};
  const positional = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith("--") && token.length > 2) {
      const eqIdx = token.indexOf("=");
      let name, inlineValue = null;
      if (eqIdx !== -1) {
        name = token.slice(2, eqIdx);
        inlineValue = token.slice(eqIdx + 1);
      } else {
        name = token.slice(2);
      }
      if (booleans.has(name)) {
        options[name] = true;
        i += 1;
        continue;
      }
      if (values.has(name)) {
        if (inlineValue !== null) {
          options[name] = inlineValue;
          i += 1;
          continue;
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          options[name] = true;
          i += 1;
          continue;
        }
        options[name] = next;
        i += 2;
        continue;
      }
      // unknown flag — pass through as positional
      positional.push(token);
      i += 1;
      continue;
    }
    positional.push(token);
    i += 1;
  }

  return { options, positional };
}

export function splitRawArgumentString(raw) {
  if (!raw) return [];
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
