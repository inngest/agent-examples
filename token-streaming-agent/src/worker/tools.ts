import type OpenAI from "openai";
import { pythonRunner } from "./sandbox";

// OpenAI/OpenRouter function-tool definitions. Both experiment arms (MODEL_A /
// MODEL_B, see chat-function.ts) call these through the Chat Completions
// tool-calling interface; `agent.ts` dispatches the resulting calls through
// `executeTool` below.
export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get the weather for a city: a current snapshot plus ~30 days of daily history (high/low temp in Celsius, humidity, wind, precipitation, condition). Call this whenever the user asks about weather, outdoor conditions, or wants to analyze weather data anywhere — never answer weather questions from memory. Returns mocked but deterministic data.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. 'Tokyo'" },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather_multi",
      description:
        "Get the weather for several cities in a single call — each with a current snapshot plus ~30 days of daily history (same shape as get_weather). Prefer this over calling get_weather repeatedly when the user asks about, or wants to compare/analyze, more than one city. Returns an array of the mocked, deterministic readings (Celsius).",
      parameters: {
        type: "object",
        properties: {
          cities: {
            type: "array",
            items: { type: "string" },
            description: "City names, e.g. ['Tokyo', 'London', 'Sydney']",
          },
        },
        required: ["cities"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "Run a short Python script to analyze the weather data and return its printed output. The readings for the cities you pass are injected as a variable `weather` — a list of the same objects get_weather_multi returns: { city, unit, current, daily: [{ date, highC, lowC, humidity, windKph, precipMm, condition }] } (30 days of daily history each). Use this for analysis the other tools can't do directly: trends over the daily series, aggregates (averages, min/max), correlations, filtering. Read `weather` and print() your results — only stdout is returned. IMPORTANT — this runs in a restricted interpreter: only the standard-library modules json, datetime, and re can be imported; there are NO third-party packages (no numpy, pandas, statistics), no classes, and no match statements. Use plain loops, comprehensions, and builtins (sum, min, max, len, sorted, round).",
      parameters: {
        type: "object",
        properties: {
          cities: {
            type: "array",
            items: { type: "string" },
            description: "Cities whose readings to load into `weather`, e.g. ['Tokyo', 'London']",
          },
          code: {
            type: "string",
            description: "Python source to run. Reads the injected `weather` variable; use print() to return results.",
          },
        },
        required: ["cities", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_to_celsius",
      description:
        "Convert a temperature from Fahrenheit to Celsius. Call this whenever the user asks for a temperature in Celsius that you only have in Fahrenheit, instead of doing the conversion yourself.",
      parameters: {
        type: "object",
        properties: {
          fahrenheit: { type: "number", description: "Temperature in degrees Fahrenheit, e.g. 72" },
        },
        required: ["fahrenheit"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_to_fahrenheit",
      description:
        "Convert a temperature from Celsius to Fahrenheit. Call this whenever the user asks for a temperature in Fahrenheit that you only have in Celsius (get_weather reports Celsius), instead of doing the conversion yourself.",
      parameters: {
        type: "object",
        properties: {
          celsius: { type: "number", description: "Temperature in degrees Celsius, e.g. 22" },
        },
        required: ["celsius"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Get the current date and time, optionally in a given IANA timezone. Call this whenever the user asks what time or date it is, or asks a question that depends on the current date — you don't otherwise know the current time.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone, e.g. 'Asia/Tokyo'. Defaults to UTC." },
        },
      },
    },
  },
];

// How many days of daily history each reading carries. Enough rows per city
// (and many more across get_weather_multi) to give a downstream analysis step
// — e.g. an agent writing a Python script — real data to work with.
const DAILY_DAYS = 30;

function hashCity(city: string): number {
  let h = 0;
  for (let i = 0; i < city.length; i++) {
    h = (h * 31 + city.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Small deterministic PRNG (mulberry32). The whole synthetic series is seeded
// only from the city name + day index — never wall-clock time — so a city's
// data is identical across runs, which keeps demos and any analysis on the data
// reproducible.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DailyReading = {
  date: string; // YYYY-MM-DD
  highC: number;
  lowC: number;
  humidity: number; // %
  windKph: number;
  precipMm: number;
  condition: string;
};
type CurrentReading = {
  tempC: number;
  condition: string;
  humidity: number;
  windKph: number;
  precipMm: number;
  pressureHpa: number;
};
type CityWeather = {
  city: string;
  unit: "celsius";
  current: CurrentReading;
  daily: DailyReading[];
};

// The date `daysAgo` days before today (UTC), as YYYY-MM-DD. Only the date
// labels track wall-clock time — the metric values do not (see mulberry32) —
// so the series always reads as "the last N days" while staying reproducible.
function daysAgoIso(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function conditionFor(precipMm: number, humidity: number, rng: () => number): string {
  if (precipMm >= 8) return rng() < 0.5 ? "Heavy rain" : "Thunderstorms";
  if (precipMm >= 2) return "Rain";
  if (precipMm > 0) return rng() < 0.5 ? "Light rain" : "Drizzle";
  if (humidity >= 85) return "Overcast";
  if (humidity >= 70) return rng() < 0.5 ? "Cloudy" : "Partly cloudy";
  return rng() < 0.5 ? "Clear" : "Sunny";
}

// Synthesize a full reading for a city: a current snapshot plus DAILY_DAYS of
// daily history, all coherent around the city's climate baseline. Shared by
// both weather tools so single- and multi-city paths return the same shape.
function weatherReading(city: string): CityWeather {
  const key = city.trim().toLowerCase();
  const base = {
    condition: ["Clear", "Cloudy", "Windy", "Drizzle"][hashCity(key) % 4],
    tempC: 10 + (hashCity(key) % 20),
  };
  const seed = hashCity(key);

  const daily: DailyReading[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const dayNo = DAILY_DAYS - i;
    const rng = mulberry32(seed * 31 + dayNo);
    // Gentle seasonal-ish drift plus daily noise around the city's baseline,
    // so highs/lows trend rather than jump around randomly.
    const drift = Math.sin(dayNo / 6) * 3;
    const highC = base.tempC + drift + (rng() * 6 - 3);
    const lowC = highC - (4 + rng() * 6);
    const humidity = Math.round(45 + rng() * 50);
    const windKph = Math.round(3 + rng() * 32);
    // Precip is mostly zero, occasionally significant — a right-skewed draw.
    const precipMm = rng() < 0.55 ? 0 : round1(rng() * rng() * 18);
    daily.push({
      date: daysAgoIso(i),
      highC: round1(highC),
      lowC: round1(lowC),
      humidity,
      windKph,
      precipMm,
      condition: conditionFor(precipMm, humidity, rng),
    });
  }

  // Current snapshot anchored to the baseline (keeps familiar demo values, e.g.
  // Tokyo 24°C) and enriched with the same metric columns as the series.
  const cur = mulberry32(seed);
  const current: CurrentReading = {
    tempC: base.tempC,
    condition: base.condition,
    humidity: Math.round(45 + cur() * 50),
    windKph: Math.round(3 + cur() * 32),
    precipMm: cur() < 0.55 ? 0 : round1(cur() * cur() * 18),
    pressureHpa: Math.round(995 + cur() * 40),
  };

  return { city, unit: "celsius", current, daily };
}

function getWeather(city: string): string {
  return JSON.stringify(weatherReading(city));
}

// One call, many cities — returns an array of the same rich readings, so the
// model can fetch several cities at once instead of looping get_weather.
function getWeatherMulti(cities: string[]): string {
  return JSON.stringify(cities.map((c) => weatherReading(String(c))));
}

// The host values exposed to a run_python script as top-level variables. Reuses
// the same deterministic readings as get_weather_multi, so the script analyzes
// exactly the data the model already saw — no retyping, reproducible across runs.
function weatherContext(cities: string[]): Record<string, unknown> {
  return { weather: cities.map((c) => weatherReading(String(c))) };
}

// Keep a tool result from flooding the model's context: agent.ts appends tool
// output to history with no size cap, so a runaway print loop would otherwise
// grow the next request unbounded. 4 KB is plenty for analysis summaries.
function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

// Run the model's Python against the injected weather data via the pluggable
// sandbox backend (placeholder in part 1; Monty in part 2). Coerces args
// defensively — a malformed tool-call emit yields `{}` upstream (agent.ts), so
// this degrades to empty cities/code rather than throwing. Returns a compact
// JSON envelope so the model can read stdout/errors back on the next turn.
async function runPythonTool(input: any): Promise<string> {
  const cities = Array.isArray(input?.cities) ? input.cities.map(String) : [];
  const code = String(input?.code ?? "");
  const res = await pythonRunner.run(code, weatherContext(cities));
  return JSON.stringify({
    ok: res.ok,
    stdout: truncate(res.stdout),
    stderr: truncate(res.stderr),
    ...(res.result !== undefined ? { result: truncate(res.result) } : {}),
    ...(res.error ? { error: res.error } : {}),
  });
}

// Rounded to 1 decimal place — enough precision for weather-style readings
// without the float noise of e.g. 22.222222222222221.
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function requireFiniteNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${field} must be a finite number, got: ${String(value)}`);
  }
  return n;
}

// Pure numeric converters: take a temperature, return the converted value
// alongside the original so the result is self-describing in traces.
function convertToCelsius(fahrenheit: unknown): string {
  const f = requireFiniteNumber(fahrenheit, "fahrenheit");
  return JSON.stringify({ fahrenheit: f, celsius: round1(((f - 32) * 5) / 9) });
}

function convertToFahrenheit(celsius: unknown): string {
  const c = requireFiniteNumber(celsius, "celsius");
  return JSON.stringify({ celsius: c, fahrenheit: round1((c * 9) / 5 + 32) });
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
// Handlers may be sync (return a string) or async (return a Promise<string> —
// run_python awaits the sandbox); executeTool awaits either.
const toolHandlers: Record<string, (input: any) => string | Promise<string>> = {
  get_weather: (input) => getWeather(String(input.city ?? "")),
  get_weather_multi: (input) => getWeatherMulti(Array.isArray(input?.cities) ? input.cities : []),
  run_python: (input) => runPythonTool(input),
  convert_to_celsius: (input) => convertToCelsius(input?.fahrenheit),
  convert_to_fahrenheit: (input) => convertToFahrenheit(input?.celsius),
  get_current_time: (input) => getCurrentTime(input?.timezone ? String(input.timezone) : undefined),
};

export async function executeTool(name: string, input: any): Promise<string> {
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await handler(input);
}
