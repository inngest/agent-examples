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

func (p *parser) advance() byte {
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
		if p.eof() {
			return v, nil
		}
		c := p.peek()
		if c != '+' && c != '-' {
			return v, nil
		}
		p.advance()
		p.skipSpace()
		if p.eof() {
			return 0, fmt.Errorf("unexpected end of expression after operator")
		}
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
		if p.eof() {
			return v, nil
		}
		c := p.peek()
		if c != '*' && c != '/' {
			return v, nil
		}
		p.advance()
		p.skipSpace()
		if p.eof() {
			return 0, fmt.Errorf("unexpected end of expression after operator")
		}
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
	if p.eof() {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	if p.peek() == '-' {
		p.advance()
		p.skipSpace()
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	v, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if !p.eof() && p.peek() == '^' {
		p.advance()
		p.skipSpace()
		if p.eof() {
			return 0, fmt.Errorf("unexpected end of expression after '^'")
		}
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
	if p.eof() {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := p.peek()
	if c == '(' {
		p.advance()
		p.skipSpace()
		if p.eof() {
			return 0, fmt.Errorf("unexpected end of expression after '('")
		}
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipSpace()
		if p.eof() {
			return 0, fmt.Errorf("missing closing ')'")
		}
		if p.peek() != ')' {
			return 0, fmt.Errorf("missing closing ')'")
		}
		p.advance()
		return v, nil
	}
	if c == '.' {
		return 0, fmt.Errorf("unexpected '.' at position %d", p.pos)
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
		c := p.peek()
		if isDigit(c) {
			p.advance()
		} else if c == '.' {
			if hasDot {
				return 0, fmt.Errorf("invalid number at position %d", start)
			}
			hasDot = true
			p.advance()
		} else {
			break
		}
	}
	tok := p.s[start:p.pos]
	if tok == "." {
		return 0, fmt.Errorf("invalid number %q", tok)
	}
	v, err := strconv.ParseFloat(tok, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q: %v", tok, err)
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for !p.eof() {
		c := p.peek()
		if isLetter(c) || isDigit(c) {
			p.advance()
		} else {
			break
		}
	}
	name := p.s[start:p.pos]
	if name == "" {
		return 0, fmt.Errorf("empty identifier at position %d", start)
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
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
