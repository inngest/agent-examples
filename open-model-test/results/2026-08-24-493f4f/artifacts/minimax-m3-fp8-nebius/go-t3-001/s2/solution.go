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
		p.pos++
		p.skipSpace()
		r, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if op == '+' {
			v += r
		} else {
			v -= r
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
		p.pos++
		p.skipSpace()
		r, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if op == '*' {
			v *= r
		} else {
			if r == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			v /= r
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
	if p.pos < len(p.s) && p.s[p.pos] == '+' {
		p.pos++
		return p.parseFactor()
	}
	v, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if p.pos < len(p.s) && p.s[p.pos] == '^' {
		p.pos++
		p.skipSpace()
		r, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		v = math.Pow(v, r)
	}
	return v, nil
}

func (p *parser) parseBase() (float64, error) {
	p.skipSpace()
	if p.pos >= len(p.s) {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := p.s[p.pos]
	if c == '(' {
		p.pos++
		p.skipSpace()
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
	if isDigit(c) {
		return p.parseNumber()
	}
	if isLetter(c) {
		return p.parseIdent()
	}
	return 0, fmt.Errorf("unexpected character %q at position %d", c, p.pos)
}

func (p *parser) parseNumber() (float64, error) {
	start := p.pos
	hasDot := false
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if isDigit(c) {
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
	tok := p.s[start:p.pos]
	if tok == "." || tok == "" {
		return 0, fmt.Errorf("invalid number at position %d", start)
	}
	v, err := parseFloat(tok)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q at position %d", tok, start)
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if isLetter(c) || isDigit(c) {
			p.pos++
		} else {
			break
		}
	}
	name := p.s[start:p.pos]
	if name == "" {
		return 0, fmt.Errorf("invalid identifier at position %d", start)
	}
	if p.vars == nil {
		return 0, fmt.Errorf("unknown variable: %s", name)
	}
	v, ok := p.vars[name]
	if !ok {
		return 0, fmt.Errorf("unknown variable: %s", name)
	}
	return v, nil
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func parseFloat(s string) (float64, error) {
	var v float64
	dot := false
	frac := 0.0
	div := 1.0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '.' {
			if dot {
				return 0, fmt.Errorf("invalid number")
			}
			dot = true
			continue
		}
		d := float64(c - '0')
		if dot {
			div *= 10
			frac = frac*10 + d
		} else {
			v = v*10 + d
		}
	}
	if dot {
		v += frac / div
	}
	return v, nil
}

// Ensure strings package is referenced (used implicitly via rune checks above).
var _ = strings.TrimSpace
