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
	if p.eof() {
		return 0, fmt.Errorf("empty expression")
	}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if !p.eof() {
		return 0, fmt.Errorf("unexpected trailing token at position %d", p.pos)
	}
	return v, nil
}

type parser struct {
	s    string
	pos  int
	vars map[string]float64
}

func (p *parser) eof() bool {
	return p.pos >= len(p.s)
}

func (p *parser) peek() byte {
	if p.eof() {
		return 0
	}
	return p.s[p.pos]
}

func (p *parser) next() byte {
	c := p.s[p.pos]
	p.pos++
	return c
}

func (p *parser) skipSpace() {
	for !p.eof() && unicode.IsSpace(rune(p.s[p.pos])) {
		p.pos++
	}
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		p.skipSpace()
		c := p.peek()
		if c == '+' || c == '-' {
			p.next()
			p.skipSpace()
			t, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			if c == '+' {
				v += t
			} else {
				v -= t
			}
			continue
		}
		break
	}
	return v, nil
}

func (p *parser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		p.skipSpace()
		c := p.peek()
		if c == '*' || c == '/' {
			p.next()
			p.skipSpace()
			f, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if c == '*' {
				v *= f
			} else {
				if f == 0 {
					return 0, fmt.Errorf("division by zero")
				}
				v /= f
			}
			continue
		}
		break
	}
	return v, nil
}

func (p *parser) parseFactor() (float64, error) {
	p.skipSpace()
	if p.peek() == '-' {
		p.next()
		p.skipSpace()
		f, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -f, nil
	}
	if p.peek() == '+' {
		p.next()
		p.skipSpace()
		return p.parseFactor()
	}
	base, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if p.peek() == '^' {
		p.next()
		p.skipSpace()
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
	if p.eof() {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := p.peek()
	if c == '(' {
		p.next()
		p.skipSpace()
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipSpace()
		if p.eof() || p.peek() != ')' {
			return 0, fmt.Errorf("unbalanced parentheses")
		}
		p.next()
		return v, nil
	}
	if c == '.' {
		return 0, fmt.Errorf("invalid number at position %d", p.pos)
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
	for !p.eof() {
		c := p.s[p.pos]
		if isDigit(c) {
			p.pos++
			continue
		}
		if c == '.' && !hasDot {
			hasDot = true
			p.pos++
			continue
		}
		break
	}
	if p.pos == start {
		return 0, fmt.Errorf("invalid number at position %d", start)
	}
	// Reject trailing dot like "3."
	if !p.eof() {
		c := p.s[p.pos]
		if c == '.' {
			return 0, fmt.Errorf("invalid number at position %d", start)
		}
	}
	numStr := p.s[start:p.pos]
	v, err := strconv.ParseFloat(numStr, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", numStr)
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for !p.eof() {
		c := p.s[p.pos]
		if isLetter(c) || isDigit(c) {
			p.pos++
			continue
		}
		break
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

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}
