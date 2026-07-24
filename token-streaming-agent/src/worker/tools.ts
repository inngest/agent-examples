import type Anthropic from "@anthropic-ai/sdk";

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description:
      "Get the current weather for a city. Call this whenever the user asks about weather or outdoor conditions anywhere — never answer weather questions from memory. Returns mocked but deterministic data.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. 'Tokyo'" },
      },
      required: ["city"],
    },
  },
  {
    name: "calculate",
    description:
      "Evaluate a basic arithmetic expression (+, -, *, /, parentheses, decimals). Call this for any calculation the user asks for instead of doing the arithmetic yourself. No variables or functions.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "e.g. '87 * 23' or '(4 + 5) / 3'" },
      },
      required: ["expression"],
    },
  },
  {
    name: "get_current_time",
    description:
      "Get the current date and time, optionally in a given IANA timezone. Call this whenever the user asks what time or date it is, or asks a question that depends on the current date — you don't otherwise know the current time.",
    input_schema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, e.g. 'Asia/Tokyo'. Defaults to UTC." },
      },
    },
  },
];

// Deterministic mock weather data, keyed by lowercased city name, so demos
// and screenshots are reproducible. Falls back to a stable hash-derived
// reading for any city not in the table, rather than random data.
const MOCK_WEATHER: Record<string, { condition: string; tempC: number }> = {
  tokyo: { condition: "Light rain", tempC: 24 },
  "new york": { condition: "Partly cloudy", tempC: 19 },
  london: { condition: "Overcast", tempC: 15 },
  "san francisco": { condition: "Foggy", tempC: 16 },
  sydney: { condition: "Sunny", tempC: 22 },
};

function hashCity(city: string): number {
  let h = 0;
  for (let i = 0; i < city.length; i++) {
    h = (h * 31 + city.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getWeather(city: string): string {
  const key = city.trim().toLowerCase();
  const reading = MOCK_WEATHER[key] ?? {
    condition: ["Clear", "Cloudy", "Windy", "Drizzle"][hashCity(key) % 4],
    tempC: 10 + (hashCity(key) % 20),
  };
  return JSON.stringify({ city, ...reading, unit: "celsius" });
}

// A tiny recursive-descent parser for `+ - * / ( )` over numbers — deliberately
// not `eval`/`Function` on the raw string, so the tool can't be used to run
// arbitrary JS even if a model were coerced into passing something malicious.
function calculate(expression: string): string {
  // Reject anything outside digits, whitespace, and the arithmetic operators
  // up front — belt-and-suspenders alongside the parser only ever consuming
  // known tokens.
  if (!/^[0-9+\-*/(). \t]*$/.test(expression)) {
    throw new Error(`Invalid characters in expression: ${expression}`);
  }

  let pos = 0;

  function peek(): string | undefined {
    return expression[pos];
  }

  function skipSpace() {
    while (pos < expression.length && /\s/.test(expression[pos]!)) pos++;
  }

  function parseNumber(): number {
    skipSpace();
    const start = pos;
    if (peek() === "+" || peek() === "-") pos++;
    let sawDigit = false;
    while (pos < expression.length && /[0-9]/.test(expression[pos]!)) {
      pos++;
      sawDigit = true;
    }
    if (peek() === ".") {
      pos++;
      while (pos < expression.length && /[0-9]/.test(expression[pos]!)) {
        pos++;
        sawDigit = true;
      }
    }
    if (!sawDigit) throw new Error(`Expected a number at position ${start}`);
    return Number(expression.slice(start, pos));
  }

  function parseFactor(): number {
    skipSpace();
    if (peek() === "(") {
      pos++;
      const value = parseExpr();
      skipSpace();
      if (peek() !== ")") throw new Error("Expected closing ')'");
      pos++;
      return value;
    }
    if (peek() === "-") {
      pos++;
      return -parseFactor();
    }
    if (peek() === "+") {
      pos++;
      return parseFactor();
    }
    return parseNumber();
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (true) {
      skipSpace();
      const op = peek();
      if (op === "*" || op === "/") {
        pos++;
        const rhs = parseFactor();
        if (op === "*") value *= rhs;
        else {
          if (rhs === 0) throw new Error("Division by zero");
          value /= rhs;
        }
      } else {
        break;
      }
    }
    return value;
  }

  function parseExpr(): number {
    let value = parseTerm();
    while (true) {
      skipSpace();
      const op = peek();
      if (op === "+" || op === "-") {
        pos++;
        const rhs = parseTerm();
        value = op === "+" ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  }

  const result = parseExpr();
  skipSpace();
  if (pos !== expression.length) {
    throw new Error(`Unexpected trailing input at position ${pos}: "${expression.slice(pos)}"`);
  }
  return JSON.stringify({ expression, result });
}

function getCurrentTime(timezone?: string): string {
  const now = new Date();
  const tz = timezone && timezone.trim() ? timezone : "UTC";
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: tz,
  }).format(now);
  return JSON.stringify({ timezone: tz, iso: now.toISOString(), formatted });
}

// Registry of tool implementations, keyed by name — dispatch is a lookup, not
// a hardcoded switch, so agent.ts stays generic over whatever's declared above.
const toolHandlers: Record<string, (input: any) => string> = {
  get_weather: (input) => getWeather(String(input.city ?? "")),
  calculate: (input) => calculate(String(input.expression ?? "")),
  get_current_time: (input) => getCurrentTime(input?.timezone ? String(input.timezone) : undefined),
};

export async function executeTool(name: string, input: any): Promise<string> {
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(input);
}
