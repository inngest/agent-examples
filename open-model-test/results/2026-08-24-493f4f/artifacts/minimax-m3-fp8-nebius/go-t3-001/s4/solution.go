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
		p.skipSpace()
		if p.pos >= len(p.s) {
			return 0, fmt.Errorf("unbalanced parentheses")
		}
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
	if c == '.' {
		return 0, fmt.Errorf("invalid number: leading '.'")
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
				return 0, fmt.Errorf("invalid number with multiple '.'")
			}
			hasDot = true
			p.pos++
		} else {
			break
		}
	}
	tok := p.s[start:p.pos]
	if tok == "." {
		return 0, fmt.Errorf("invalid number '.'")
	}
	v, err := parseFloat(tok)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", tok)
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
	var frac float64 = 1
	seenDot := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '.' {
			if seenDot {
				return 0, fmt.Errorf("invalid number")
			}
			seenDot = true
			continue
		}
		if !isDigit(c) {
			return 0, fmt.Errorf("invalid number")
		}
		if seenDot {
			frac *= 10
			v += float64(c-'0') / frac
		} else {
			v = v*10 + float64(c-'0')
		}
	}
	return v, nil
}

// silence unused import in some build configs
var _ = strings.HasPrefix
