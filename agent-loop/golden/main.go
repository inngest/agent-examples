// Command golden generates the golden test corpus for the semver port by
// running golang.org/x/mod/semver over a curated + fuzzed set of inputs.
//
// Run from the repo root: go run ./golden
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"

	"golang.org/x/mod/semver"
)

const (
	seed1 = 0x5eed5eed
	seed2 = 0xc0ffee42
)

type testCase struct {
	ID       string `json:"id"`
	Fn       string `json:"fn"`
	Args     []any  `json:"args"`
	Expected any    `json:"expected"`
}

func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// makeCase derives the id from the content (fn + args), never from an index,
// so changing the corpus cannot move a case between train and holdout.
func makeCase(fn string, args []any, expected any) testCase {
	sum := sha256.Sum256(append([]byte(fn+"\x00"), marshal(args)...))
	return testCase{ID: "c_" + hex.EncodeToString(sum[:6]), Fn: fn, Args: args, Expected: expected}
}

func isHoldout(id string) bool {
	h := fnv.New32()
	h.Write([]byte(id))
	return h.Sum32()%5 == 0
}

var curated = []string{
	"", "v", "V1.2.3", "v1", "v1.2", "v1.2.3", "v1.2.3.4", "v1.2.3.", "v1.", "v1..2", "v.1.2",
	"1.2.3", "1", "1.2", "v0", "v0.0", "v0.0.0", "v0.0.1", "v0.1.0", "v1.0.0",
	"v1.2.3-alpha.1+build", "v1.2.3-alpha.beta", "v1.2.3-alpha", "v1.2.3+build", "v1.2.3+build.5",
	"v1.2.3-alpha.1+build.2", "v1.2+meta", "v1+meta", "v1-pre", "v1.2-pre", "v1.2-pre+meta",
	"v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3-01", "v1.2.3-0", "v1.2.3-00", "v1.2.3-alpha.01",
	"v1.2.3-alpha.0", "v1.2.3-0a", "v1.2.3-a.0.b", "v1.2.3+01", "v1.2.3+0", "v1.2.3+a..b",
	"v+build", "v-pre", "v1.2.3+", "v1.2.3-", "v1.2.3-+", "v1.2.3-+build", "v1.2.3--", "v1.2.3---",
	"v1.2.3-a-b", "v1.2.3-a-b.c-d", "v1.2.3-a..b", "v1.2.3-.a", "v1.2.3-a.", "v1.2.3-.",
	"v1.2.3+a-b", "v1.2.3+a.b-c", "v1.2.3+-", "v1.2.3+.", "v1.2.3-a+b+c", "v1.2.3+b-a",
	"v1.2.3-a_b", "v1.2.3-é", "v1.2.3 ", " v1.2.3", "v1.2.3\n", "v 1.2.3", "v1.2.3-alpha beta",
	"vv1.2.3", "v-1.2.3", "v+1.2.3", "v1.-2.3", "v1.2.3-rc.1", "v1.2.3-rc.1+build.1",
	"v1.2.3-RC.1", "v1.2.3-Alpha", "v1.2.3-alpha", "v1.2.3-ALPHA",
	"v9007199254740991.0.0", "v9007199254740992.0.0", "v9007199254740993.0.0",
	"v18446744073709551615.0.0", "v18446744073709551616.0.0", "v1.99999999999999999999.3",
	"v1.2.123456789012345678901234567890", "v1.2.3-123456789012345678901234567890",
	"v1.2.3-123456789012345678901234567891", "v1.2.3-9007199254740993", "v1.2.3-9007199254740992",
	"v2.0.0", "v10.0.0", "v2.1.0", "v2.10.0", "v1.10.0", "v1.9.0", "v1.2.10", "v1.2.9",
	"v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2",
	"v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0-1", "v1.0.0-2", "v1.0.0-11", "v1.0.0-1a",
	"v1.0.0-a1", "v1.0.0-alpha.1.2", "v1.0.0-alpha.1.a", "v1.0.0-alpha.a.1",
	"v2.1.1+build1", "v2.1.1+build2", "v2.1.1", "v2.1.1-pre+build1",
	"v1.2.3-pre.release.with.many.parts.0.1.2.3", "v0.0.0-0", "v0.0.0-0.0.0+0.0.0",
	"vv", "v.", "v..", "v...", "v1.2.3.4.5", "v1.2.3-4.5.6", "v1.2.3+4.5.6",
	"v1.2.3-0.3.7", "v1.2.3-x.7.z.92", "v1.2.3-x-y-z.--", "v1.2.3-1.2.3",
	"v1.0.0-0A.is.legal", "v1.1.2-prerelease+meta", "v1.0.0+0.build.1-rc.10000aaa-kk-0.1",
	"v99999999999999999999999.999999999999999999.99999999999999999----RC-SNAPSHOT.12.9.1--.12+788",
	"v1.0.0-0A.is.legal", "v1.2.3+meta-valid", "v1.2.3-alpha.-1", "v1.2.3-alpha.-", "v1.2.3-0.-0",
}

var specOrder = []string{
	"v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta",
	"v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0",
}

type gen struct{ r *rand.Rand }

func (g *gen) n(k int) int       { return g.r.IntN(k) }
func (g *gen) chance(p int) bool { return g.r.IntN(100) < p }

func (g *gen) num() string {
	switch g.n(12) {
	case 0:
		return "0"
	case 1:
		return fmt.Sprintf("0%d", g.n(10)) // leading zero
	case 2:
		return fmt.Sprintf("%d", g.n(100000))
	case 3:
		return fmt.Sprintf("%d%s", 1+g.n(9), strings.Repeat(fmt.Sprint(g.n(10)), 15+g.n(10))) // huge
	case 4, 5:
		return fmt.Sprintf("%d", g.n(100))
	default:
		return fmt.Sprintf("%d", g.n(12))
	}
}

const junkChars = "!@#$%^&*()_=[]{}|;:'\",<>/?~` \t\n\\éあ"

func (g *gen) ident(allowEmpty bool) string {
	switch g.n(10) {
	case 0:
		if allowEmpty {
			return ""
		}
		return "x"
	case 1:
		return g.num()
	case 2, 3:
		return fmt.Sprint(g.n(30))
	case 4:
		return []string{"alpha", "beta", "rc", "pre", "snapshot", "x", "a", "B", "Z"}[g.n(9)]
	case 5:
		return []string{"a-b", "-", "--", "a-", "-a", "0-0", "1-a", "a-1"}[g.n(8)]
	case 6:
		const al = "abcxyzABCXYZ0123456789-"
		b := make([]byte, 1+g.n(6))
		for i := range b {
			b[i] = al[g.n(len(al))]
		}
		return string(b)
	case 7:
		return fmt.Sprintf("%s%d", []string{"a", "rc", "b"}[g.n(3)], g.n(20))
	case 8:
		return fmt.Sprintf("%d%s", g.n(20), []string{"a", "x", "-", "e1"}[g.n(4)])
	default:
		if g.chance(30) {
			return string(junkChars[g.n(len(junkChars))])
		}
		return "r" + g.num()
	}
}

func (g *gen) idents(allowEmpty bool) string {
	k := 1 + g.n(4)
	parts := make([]string, k)
	for i := range parts {
		parts[i] = g.ident(allowEmpty)
	}
	return strings.Join(parts, ".")
}

func (g *gen) version() string {
	var sb strings.Builder
	if g.chance(88) {
		sb.WriteString("v")
	} else if g.chance(30) {
		sb.WriteString("V")
	}
	parts := 3
	if g.chance(30) {
		parts = 1 + g.n(4)
	}
	// near-valid: bias toward 3 parts
	for i := 0; i < parts; i++ {
		if i > 0 {
			sb.WriteString(".")
			if g.chance(2) {
				sb.WriteString(".")
			}
		}
		if g.chance(2) {
			continue // empty part
		}
		if g.chance(75) {
			sb.WriteString(fmt.Sprint(g.n(10)))
		} else {
			sb.WriteString(g.num())
		}
	}
	if g.chance(2) {
		sb.WriteString(".")
	}
	if g.chance(45) {
		sb.WriteString("-")
		sb.WriteString(g.idents(g.chance(15)))
	}
	if g.chance(30) {
		sb.WriteString("+")
		sb.WriteString(g.idents(g.chance(15)))
	}
	s := sb.String()
	if g.chance(6) {
		// sprinkle a junk character somewhere
		pos := g.n(len(s) + 1)
		s = s[:pos] + string(junkChars[g.n(len(junkChars))]) + s[pos:]
	}
	if g.chance(3) {
		s += string(junkChars[g.n(len(junkChars))])
	}
	return s
}

// mutate produces a near neighbour of a version: same core with different
// prerelease/build, bumped part, etc.
func (g *gen) mutate(v string) string {
	switch g.n(6) {
	case 0:
		return v + "+" + g.ident(false)
	case 1:
		return strings.SplitN(v, "+", 2)[0] // strip build
	case 2:
		return strings.SplitN(strings.SplitN(v, "+", 2)[0], "-", 2)[0] // release
	case 3:
		return strings.SplitN(v, "-", 2)[0] + "-" + g.idents(false)
	case 4:
		return v + "." + g.ident(false)
	default:
		return strings.TrimPrefix(v, "v")
	}
}

func main() {
	g := &gen{r: rand.New(rand.NewPCG(seed1, seed2))}

	// ---- input pool (deduped, insertion-ordered) ----
	seen := map[string]bool{}
	var pool []string
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			pool = append(pool, s)
		}
	}
	for _, s := range curated {
		add(s)
	}
	for _, s := range specOrder {
		add(s)
	}
	nCurated := len(pool)
	for len(pool) < nCurated+1900 {
		add(g.version())
	}
	valid := []string{}
	for _, s := range pool {
		if semver.IsValid(s) {
			valid = append(valid, s)
		}
	}

	cases := map[string]testCase{}
	put := func(c testCase) { cases[c.ID] = c }

	// ---- unary functions ----
	for _, s := range pool {
		a := func() []any { return []any{s} }
		put(makeCase("IsValid", a(), semver.IsValid(s)))
		put(makeCase("Canonical", a(), semver.Canonical(s)))
		put(makeCase("Major", a(), semver.Major(s)))
		put(makeCase("MajorMinor", a(), semver.MajorMinor(s)))
		put(makeCase("Prerelease", a(), semver.Prerelease(s)))
		put(makeCase("Build", a(), semver.Build(s)))
	}

	// ---- pairs ----
	var pairs [][2]string
	// every ordered pair of the spec ordering list (incl. equal)
	for _, a := range specOrder {
		for _, b := range specOrder {
			pairs = append(pairs, [2]string{a, b})
		}
	}
	// curated list: each against a handful of anchors, and neighbours
	anchors := []string{"v1.0.0", "v1.2.3", "v1.2.3-alpha.1", "", "v", "1.2.3", "v1.2.3+build", "v2.1.1+build1"}
	for _, a := range curated {
		for _, b := range anchors {
			pairs = append(pairs, [2]string{a, b}, [2]string{b, a})
		}
	}
	for i := 0; i+1 < len(curated); i++ {
		pairs = append(pairs, [2]string{curated[i], curated[i+1]})
	}
	// equal precedence: same version, differing build metadata only
	for i := 0; i < 150; i++ {
		v := valid[g.n(len(valid))]
		core := strings.SplitN(v, "+", 2)[0]
		pairs = append(pairs, [2]string{core + "+" + g.ident(false), core + "+" + g.ident(false)},
			[2]string{core, core + "+" + g.ident(false)})
	}
	// mutated neighbours, and random pairs (valid/valid, any/any)
	for i := 0; i < 700; i++ {
		v := valid[g.n(len(valid))]
		pairs = append(pairs, [2]string{v, g.mutate(v)})
	}
	for i := 0; i < 700; i++ {
		pairs = append(pairs, [2]string{valid[g.n(len(valid))], valid[g.n(len(valid))]})
	}
	for i := 0; i < 500; i++ {
		pairs = append(pairs, [2]string{pool[g.n(len(pool))], pool[g.n(len(pool))]})
	}
	for _, p := range pairs {
		put(makeCase("Compare", []any{p[0], p[1]}, semver.Compare(p[0], p[1])))
		put(makeCase("Max", []any{p[0], p[1]}, semver.Max(p[0], p[1])))
	}

	// ---- sorts ----
	var lists [][]string
	lists = append(lists, append([]string(nil), specOrder...))
	rev := append([]string(nil), specOrder...)
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	lists = append(lists, rev)
	for i := 0; i < 5; i++ {
		l := append([]string(nil), specOrder...)
		g.r.Shuffle(len(l), func(a, b int) { l[a], l[b] = l[b], l[a] })
		lists = append(lists, l)
	}
	for i := 0; i < 900; i++ {
		k := 2 + g.n(7)
		l := make([]string, k)
		for j := range l {
			switch {
			case g.chance(60):
				l[j] = valid[g.n(len(valid))]
			case g.chance(50):
				l[j] = pool[g.n(len(pool))]
			default:
				l[j] = g.mutate(valid[g.n(len(valid))])
			}
		}
		if g.chance(10) { // duplicates / precedence ties
			l[g.n(k)] = l[g.n(k)]
		}
		lists = append(lists, l)
	}
	for _, l := range lists {
		in := make([]any, len(l))
		for i, s := range l {
			in[i] = s
		}
		sorted := append([]string(nil), l...)
		semver.Sort(sorted)
		put(makeCase("Sort", []any{in}, sorted))
	}

	// ---- split + write ----
	ids := make([]string, 0, len(cases))
	for id := range cases {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var train, holdout bytes.Buffer
	counts := map[string]map[string]int{"train": {}, "holdout": {}}
	nTrain, nHold := 0, 0
	for _, id := range ids {
		c := cases[id]
		line := append(marshal(c), '\n')
		if isHoldout(id) {
			holdout.Write(line)
			nHold++
			counts["holdout"][c.Fn]++
		} else {
			train.Write(line)
			nTrain++
			counts["train"][c.Fn]++
		}
	}

	version := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "golang.org/x/mod" {
				version = d.Version
			}
		}
	}
	meta := map[string]any{
		"seed":          []uint64{seed1, seed2},
		"rng":           "math/rand/v2 PCG",
		"xModVersion":   version,
		"total":         len(ids),
		"train":         nTrain,
		"holdout":       nHold,
		"curatedInputs": nCurated,
		"poolInputs":    len(pool),
		"countsByFn":    counts,
		"splitRule":     "holdout iff fnv32(id) % 5 == 0; id = \"c_\" + hex(sha256(fn + \"\\x00\" + json(args))[:6])",
		"idDerivation":  "content-derived, not index-derived",
		"sortSemantics": "semver.Sort sorts in place; expected is the sorted list",
	}
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		panic(err)
	}

	dir := "data"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	must := func(err error) {
		if err != nil {
			panic(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "cases.train.jsonl"), train.Bytes(), 0o644))
	must(os.WriteFile(filepath.Join(dir, "cases.holdout.jsonl"), holdout.Bytes(), 0o644))
	must(os.WriteFile(filepath.Join(dir, "meta.json"), append(metaBytes, '\n'), 0o644))
	fmt.Printf("golden: %d cases (train %d, holdout %d) from %d inputs, x/mod %s\n", len(ids), nTrain, nHold, len(pool), version)
}
