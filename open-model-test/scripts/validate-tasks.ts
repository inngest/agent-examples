// $0 task-suite validation (Finding 11 pattern): drives the REAL local
// runner — the same runTurn the execute-sample functions call — with
// reference solutions, before any model spend. For each task it runs the
// good/wrong/broken matrix:
//
//   good   → compiled && all tests pass && static clean   (task is passable)
//   wrong  → compiled && ≥1 test fails                    (tests can bite)
//   broken → build fails                                  (build gate works)
//
// Reference solutions live inline below — they are part of the task
// contract (a task without a passing reference is unpassable-by-omission,
// harness bug #9: three v3 tasks shipped without go.mod and a scored A/A
// run caught what validation should have).
//
//   bun run validate:tasks [taskId...]

import { rmSync } from "node:fs";
import { loadTask, hiddenDir, loadDirFiles, workspaceDir } from "../src/tasks";
import { openLocalSession, sessionDir } from "../src/sandbox/local";
import type { Step } from "../src/sandbox/runner";

// Minimal step shim: validation needs no memoization — plain eager calls.
const step = {
  run: (_name: string, fn: () => unknown) => fn(),
} as unknown as Step;

// requestFor mirrors sessionRequestForTask (runner.ts), which imports
// config (loads benchmark.yaml) — re-declared here so validation stays
// config-independent.
function requestFor(task: ReturnType<typeof loadTask>, sandboxName: string) {
  const wsDir = workspaceDir(task);
  return {
    language: task.language,
    sandboxName,
    seedFiles: wsDir ? loadDirFiles(wsDir) : {},
    hiddenFiles: loadDirFiles(hiddenDir(task)),
    installCommand: task.language === "typescript" ? "install-deps" : null,
    buildCommand: task.build_command,
    testCommand: task.test_command,
    staticChecks: task.static_checks,
    timeoutSeconds: task.timeout_seconds,
  };
}

// -- reference solutions ------------------------------------------------------
//
// good: believed-correct implementations of each spec. wrong: compiles,
// plausibly shaped, violates at least one pinned semantic. broken: fails
// the build gate.

type Files = Record<string, string>;
type RefSuite = { good: Files; wrong: Files; broken: Files };

const REFS: Record<string, RefSuite> = {
  "go-t1-002": {
    good: {
      "solution.go": `package slug

import "strings"

// Slugify converts arbitrary text into a URL slug.
func Slugify(s string) string {
	var b strings.Builder
	prevSep := false
	for _, r := range s {
		switch {
		case r >= 0x80:
			// non-ASCII: dropped, no separator
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			prevSep = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r - 'A' + 'a')
			prevSep = false
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if !prevSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			prevSep = true
		default:
			// ASCII symbol/punctuation: dropped, no separator
		}
	}
	return strings.Trim(b.String(), "-")
}
`,
    },
    wrong: {
      // No leading/trailing trim — "-multiple-spaces-" fails the trim cases.
      "solution.go": `package slug

import (
	"regexp"
	"strings"
)

func Slugify(s string) string {
	s = strings.ToLower(s)
	s = regexp.MustCompile(\`[^\w\s-]\`).ReplaceAllString(s, "")
	return regexp.MustCompile(\`[\s_-]+\`).ReplaceAllString(s, "-")
}
`,
    },
    broken: { "solution.go": `package slug

func Slugify(s string) string {
	return strconv.Quote(s) // undefined: strconv
}
` },
  },

  "go-t2-002": {
    good: {
      "solution.go": `package interval

import "sort"

// Interval is a half-open range [Start, End).
type Interval struct {
	Start int
	End   int
}

// Normalize sorts, drops degenerate intervals, and merges overlapping or
// touching ones. The result is always non-nil; the input is not mutated.
func Normalize(xs []Interval) []Interval {
	valid := make([]Interval, 0, len(xs))
	for _, iv := range xs {
		if iv.Start < iv.End {
			valid = append(valid, iv)
		}
	}
	sort.Slice(valid, func(i, j int) bool { return valid[i].Start < valid[j].Start })
	out := make([]Interval, 0, len(valid))
	for _, iv := range valid {
		if n := len(out); n > 0 && iv.Start <= out[n-1].End {
			if iv.End > out[n-1].End {
				out[n-1].End = iv.End
			}
			continue
		}
		out = append(out, iv)
	}
	return out
}

// TotalLength counts the integers covered by the union of xs.
func TotalLength(xs []Interval) int {
	total := 0
	for _, iv := range Normalize(xs) {
		total += iv.End - iv.Start
	}
	return total
}
`,
    },
    wrong: {
      // Sorts but never merges — fails every merge case; also returns nil
      // for empty input and double-counts overlaps in TotalLength.
      "solution.go": `package interval

import "sort"

type Interval struct {
	Start int
	End   int
}

func Normalize(xs []Interval) []Interval {
	var out []Interval
	for _, iv := range xs {
		if iv.Start < iv.End {
			out = append(out, iv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

func TotalLength(xs []Interval) int {
	total := 0
	for _, iv := range xs {
		total += iv.End - iv.Start
	}
	return total
}
`,
    },
    broken: { "solution.go": `package interval

type Interval struct {
	Start int
	End   int
}

func Normalize(xs []Interval) []Interval {
	return *new([]Interval
}
` },
  },

  "go-t3-001": {
    good: {
      "solution.go": `package expr

import (
	"fmt"
	"math"
	"strconv"
)

type parser struct {
	in  string
	pos int
}

func isSpace(c byte) bool { return c == ' ' || c == '\\t' || c == '\\n' || c == '\\r' }
func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isLetter(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func (p *parser) peek() (byte, bool) {
	for p.pos < len(p.in) && isSpace(p.in[p.pos]) {
		p.pos++
	}
	if p.pos < len(p.in) {
		return p.in[p.pos], true
	}
	return 0, false
}

func (p *parser) parseExpr(vars map[string]float64) (float64, error) {
	val, err := p.parseTerm(vars)
	if err != nil {
		return 0, err
	}
	for {
		c, ok := p.peek()
		if !ok || (c != '+' && c != '-') {
			return val, nil
		}
		p.pos++
		rhs, err := p.parseTerm(vars)
		if err != nil {
			return 0, err
		}
		if c == '+' {
			val += rhs
		} else {
			val -= rhs
		}
	}
}

func (p *parser) parseTerm(vars map[string]float64) (float64, error) {
	val, err := p.parseFactor(vars)
	if err != nil {
		return 0, err
	}
	for {
		c, ok := p.peek()
		if !ok || (c != '*' && c != '/') {
			return val, nil
		}
		p.pos++
		rhs, err := p.parseFactor(vars)
		if err != nil {
			return 0, err
		}
		if c == '*' {
			val *= rhs
		} else {
			if rhs == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			val /= rhs
		}
	}
}

func (p *parser) parseFactor(vars map[string]float64) (float64, error) {
	c, ok := p.peek()
	if !ok {
		return 0, fmt.Errorf("unexpected end of input")
	}
	if c == '-' {
		p.pos++
		v, err := p.parseFactor(vars)
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	v, err := p.parseBase(vars)
	if err != nil {
		return 0, err
	}
	if nc, ok := p.peek(); ok && nc == '^' {
		p.pos++
		exp, err := p.parseFactor(vars)
		if err != nil {
			return 0, err
		}
		return math.Pow(v, exp), nil
	}
	return v, nil
}

func (p *parser) parseBase(vars map[string]float64) (float64, error) {
	c, ok := p.peek()
	if !ok {
		return 0, fmt.Errorf("unexpected end of input")
	}
	if c == '(' {
		p.pos++
		v, err := p.parseExpr(vars)
		if err != nil {
			return 0, err
		}
		if cc, ok := p.peek(); !ok || cc != ')' {
			return 0, fmt.Errorf("missing closing parenthesis")
		}
		p.pos++
		return v, nil
	}
	if isDigit(c) {
		start := p.pos
		for p.pos < len(p.in) && isDigit(p.in[p.pos]) {
			p.pos++
		}
		if p.pos < len(p.in) && p.in[p.pos] == '.' {
			p.pos++
			ds := p.pos
			for p.pos < len(p.in) && isDigit(p.in[p.pos]) {
				p.pos++
			}
			if p.pos == ds {
				return 0, fmt.Errorf("malformed number")
			}
		}
		return strconv.ParseFloat(p.in[start:p.pos], 64)
	}
	if isLetter(c) {
		start := p.pos
		p.pos++
		for p.pos < len(p.in) && (isLetter(p.in[p.pos]) || isDigit(p.in[p.pos])) {
			p.pos++
		}
		name := p.in[start:p.pos]
		v, found := vars[name]
		if !found {
			return 0, fmt.Errorf("unknown variable: %s", name)
		}
		return v, nil
	}
	return 0, fmt.Errorf("unexpected character %q", string(c))
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	p := &parser{in: s}
	v, err := p.parseExpr(vars)
	if err != nil {
		return 0, err
	}
	if _, ok := p.peek(); ok {
		return 0, fmt.Errorf("unexpected trailing input")
	}
	return v, nil
}
`,
    },
    wrong: {
      // Left-to-right evaluation, no precedence, no ^ — fails most cases.
      "solution.go": `package expr

import (
	"fmt"
	"strconv"
)

func Eval(s string, vars map[string]float64) (float64, error) {
	var vals []float64
	var ops []byte
	i := 0
	tok := ""
	flush := func() error {
		if tok == "" {
			return nil
		}
		if v, err := strconv.ParseFloat(tok, 64); err == nil {
			vals = append(vals, v)
		} else if v, ok := vars[tok]; ok {
			vals = append(vals, v)
		} else {
			return fmt.Errorf("unknown variable: %s", tok)
		}
		tok = ""
		return nil
	}
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ':
			if err := flush(); err != nil {
				return 0, err
			}
		case c == '+' || c == '-' || c == '*' || c == '/':
			if err := flush(); err != nil {
				return 0, err
			}
			ops = append(ops, c)
		default:
			tok += string(c)
		}
		i++
	}
	if err := flush(); err != nil {
		return 0, err
	}
	if len(vals) == 0 {
		return 0, fmt.Errorf("empty input")
	}
	res := vals[0]
	for k, op := range ops {
		rhs := vals[k+1]
		switch op {
		case '+':
			res += rhs
		case '-':
			res -= rhs
		case '*':
			res *= rhs
		case '/':
			if rhs == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			res /= rhs
		}
	}
	return res, nil
}
`,
    },
    broken: { "solution.go": `package expr

func Eval(s string, vars map[string]float64) (float64, error) {
	return eval(s // missing closing paren
}
` },
  },
};

// ----------------------------------------------------------------------------

const ids = process.argv.slice(2);
const targets = ids.length > 0 ? ids : Object.keys(REFS);

let failures = 0;
const nonce = Date.now().toString(36);

for (const id of targets) {
  const ref = REFS[id];
  if (!ref) {
    console.error(`${id}: no reference suite in scripts/validate-tasks.ts`);
    failures++;
    continue;
  }
  const task = loadTask(id);
  for (const caseName of ["good", "wrong", "broken"] as const) {
    const sandboxName = `validate-${nonce}-${id}-${caseName}`;
    rmSync(sessionDir(sandboxName), { recursive: true, force: true });
    const session = await openLocalSession(step, requestFor(task, sandboxName));
    const r = await session.turn(step, 1, ref[caseName]);
    await session.close(step);

    const testsBite = r.compiled === true && r.testsTotal !== null && r.testsTotal > 0 && r.testsPassed! < r.testsTotal!;
    const pass: boolean =
      caseName === "good"
        ? r.compiled === true && r.testsTotal !== null && r.testsPassed === r.testsTotal && r.staticPass !== false
        : caseName === "wrong"
          ? testsBite
          : r.compiled === false;

    const mark = pass ? "ok " : "FAIL";
    if (!pass) failures++;
    console.log(
      `${mark} ${id} [${caseName}] compiled=${r.compiled} tests=${r.testsPassed}/${r.testsTotal} static=${r.staticPass}`,
    );
    if (!pass) {
      const out = [r.stderr, r.stdout].filter(Boolean).join("\n");
      console.log(out.slice(0, 600));
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation case(s) failed`);
  process.exit(1);
}
console.log("\nall validation cases passed");
