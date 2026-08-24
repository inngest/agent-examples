package expr

import (
	"fmt"
	"math"
	"strings"
	"unicode"
)

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	p := &parser{s: s, vars: vars}
	p.skipSpace()
	if p.pos >= len(p.s) {
		return 0, fmt.Errorf("empty expression")
	}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if p.pos < len(p.s) {
		return 0, fmt.Errorf("unexpected trailing token at position %d", p.pos)
	}
	return v, nil
}

type parser struct {
	s    string
	pos  int
	vars map[string]float64
}

func (p *parser) skipSpace() {
	for p.pos < len(p.s) && unicode.IsSpace(rune(p.s[p.pos])) {
		p.pos++
	}
}

func (p *parser) peek() byte {
	p.skipSpace()
	if p.pos >= len(p.s) {
		return 0
	}
	return p.s[p.pos]
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		op := p.peek()
		if op != '+' && op != '-' {
			return v, nil
		}
		p.skipSpace()
		p.pos++
		right, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if op == '+' {
			v += right
		} else {
			v -= right
		}
	}
}

func (p *parser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		op := p.peek()
		if op != '*' && op != '/' {
			return v, nil
		}
		p.skipSpace()
		p.pos++
		right, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if op == '*' {
			v *= right
		} else {
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			v /= right
		}
	}
}

func (p *parser) parseFactor() (float64, error) {
	p.skipSpace()
	if p.pos < len(p.s) && p.s[p.pos] == '-' {
		p.pos++
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	base, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if p.pos < len(p.s) && p.s[p.pos] == '^' {
		p.pos++
		exp, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(base, exp), nil
	}
	return base, nil
}

func (p *parser) parseBase() (float64, error) {
	p.skipSpace()
	if p.pos >= len(p.s) {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := p.s[p.pos]
	if c == '(' {
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipSpace()
		if p.pos >= len(p.s) || p.s[p.pos] != ')' {
			return 0, fmt.Errorf("unbalanced parentheses")
		}
		p.pos++
		return v, nil
	}
	if c == '.' || (c >= '0' && c <= '9') {
		return p.parseNumber()
	}
	if isLetter(c) {
		return p.parseIdent()
	}
	return 0, fmt.Errorf("unexpected character %q at position %d", string(c), p.pos)
}

func (p *parser) parseNumber() (float64, error) {
	start := p.pos
	hasDot := false
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if c >= '0' && c <= '9' {
			p.pos++
		} else if c == '.' {
			if hasDot {
				return 0, fmt.Errorf("invalid number at position %d", start)
			}
			hasDot = true
			p.pos++
		} else {
			break
		}
	}
	numStr := p.s[start:p.pos]
	if numStr == "" || numStr == "." {
		return 0, fmt.Errorf("invalid number at position %d", start)
	}
	v, err := parseFloat(numStr)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", numStr)
	}
	return v, nil
}

func parseFloat(s string) (float64, error) {
	// Manual parse to avoid pulling strconv; simple and sufficient.
	if s == "" {
		return 0, fmt.Errorf("empty number")
	}
	var v float64
	i := 0
	hasDot := false
	fracDiv := 1.0
	for i < len(s) {
		c := s[i]
		if c == '.' {
			if hasDot {
				return 0, fmt.Errorf("invalid number")
			}
			hasDot = true
			i++
			continue
		}
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid number")
		}
		d := float64(c - '0')
		if !hasDot {
			v = v*10 + d
		} else {
			fracDiv *= 10
			v += d / fracDiv
		}
		i++
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for p.pos < len(p.s) && (isLetter(p.s[p.pos]) || (p.s[p.pos] >= '0' && p.s[p.pos] <= '9')) {
		p.pos++
	}
	name := p.s[start:p.pos]
	if name == "" {
		return 0, fmt.Errorf("invalid identifier at position %d", start)
	}
	v, ok := p.vars[name]
	if !ok {
		return 0, fmt.Errorf("unknown variable: %s", name)
	}
	return v, nil
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// Ensure strings package is referenced for potential future use; avoids
// unused-import errors if the file is trimmed.
var _ = strings.TrimSpace
