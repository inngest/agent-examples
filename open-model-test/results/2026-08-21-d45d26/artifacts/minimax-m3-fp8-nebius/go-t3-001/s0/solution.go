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
			continue
		}
		break
	}
	return v, nil
}

func (p *parser) parseFactor() (float64, error) {
	p.skipSpace()
	if p.eof() {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	if p.peek() == '-' {
		p.pos++
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	if p.peek() == '+' {
		p.pos++
		return p.parseFactor()
	}
	v, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	p.skipSpace()
	if p.peek() == '^' {
		p.pos++
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
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipSpace()
		if p.eof() || p.peek() != ')' {
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
	for !p.eof() {
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
	if tok == "" || tok == "." {
		return 0, fmt.Errorf("invalid number at position %d", start)
	}
	v, err := parseFloat(tok)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", tok)
	}
	return v, nil
}

func (p *parser) parseIdent() (float64, error) {
	start := p.pos
	for !p.eof() {
		c := p.s[p.pos]
		if isLetter(c) || isDigit(c) {
			p.pos++
		} else {
			break
		}
	}
	name := p.s[start:p.pos]
	if name == "" {
		return 0, fmt.Errorf("expected identifier at position %d", start)
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
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

func parseFloat(s string) (float64, error) {
	// Manual parse to avoid pulling strconv; keep it simple.
	if s == "" {
		return 0, fmt.Errorf("empty number")
	}
	dot := strings.IndexByte(s, '.')
	var intPart, fracPart string
	if dot < 0 {
		intPart = s
		fracPart = ""
	} else {
		intPart = s[:dot]
		fracPart = s[dot+1:]
	}
	var v float64
	if intPart != "" {
		for i := 0; i < len(intPart); i++ {
			c := intPart[i]
			if !isDigit(c) {
				return 0, fmt.Errorf("invalid number %q", s)
			}
			v = v*10 + float64(c-'0')
		}
	}
	if fracPart != "" {
		div := 1.0
		for i := 0; i < len(fracPart); i++ {
			c := fracPart[i]
			if !isDigit(c) {
				return 0, fmt.Errorf("invalid number %q", s)
			}
			div *= 10
			v += float64(c-'0') / div
		}
	}
	return v, nil
}
