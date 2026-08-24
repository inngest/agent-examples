package expr

import (
	"fmt"
	"math"
	"strconv"
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
	for p.pos < len(p.s) && p.s[p.pos] == ' ' {
		p.pos++
	}
}

func (p *parser) peek() (byte, bool) {
	if p.pos >= len(p.s) {
		return 0, false
	}
	return p.s[p.pos], true
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		p.skipSpace()
		c, ok := p.peek()
		if !ok || (c != '+' && c != '-') {
			return v, nil
		}
		p.pos++
		r, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if c == '+' {
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
		p.skipSpace()
		c, ok := p.peek()
		if !ok || (c != '*' && c != '/') {
			return v, nil
		}
		p.pos++
		r, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if c == '*' {
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
	c, ok := p.peek()
	if ok && c == '-' {
		p.pos++
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	if ok && c == '+' {
		p.pos++
		return p.parseFactor()
	}
	return p.parsePower()
}

func (p *parser) parsePower() (float64, error) {
	base, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	c, ok := p.peek()
	if ok && c == '^' {
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
	return 0, fmt.Errorf("unexpected character %q at position %d", string(c), p.pos)
}

func (p *parser) parseNumber() (float64, error) {
	start := p.pos
	hasDot := false
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if isDigit(c) {
			p.pos++
		} else if c == '.' && !hasDot {
			hasDot = true
			p.pos++
		} else {
			break
		}
	}
	tok := p.s[start:p.pos]
	if tok == "" || tok == "." {
		return 0, fmt.Errorf("invalid number %q", tok)
	}
	v, err := strconv.ParseFloat(tok, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", tok)
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for p.pos < len(p.s) && (isLetter(p.s[p.pos]) || isDigit(p.s[p.pos])) {
		p.pos++
	}
	name := p.s[start:p.pos]
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
func isLetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// silence unused import warning if any
var _ = unicode.IsSpace
