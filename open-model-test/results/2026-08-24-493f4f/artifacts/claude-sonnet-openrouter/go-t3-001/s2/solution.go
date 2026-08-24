package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

type tokenType int

const (
	tokNum tokenType = iota
	tokIdent
	tokOp
)

type token struct {
	typ tokenType
	val string
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func tokenize(s string) ([]token, error) {
	var tokens []token
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case isDigit(c):
			j := i
			for j < n && isDigit(s[j]) {
				j++
			}
			if j < n && s[j] == '.' {
				j++
				start := j
				for j < n && isDigit(s[j]) {
					j++
				}
				if j == start {
					return nil, fmt.Errorf("invalid number literal at position %d", i)
				}
			}
			tokens = append(tokens, token{typ: tokNum, val: s[i:j]})
			i = j
		case isLetter(c):
			j := i + 1
			for j < n && (isLetter(s[j]) || isDigit(s[j])) {
				j++
			}
			tokens = append(tokens, token{typ: tokIdent, val: s[i:j]})
			i = j
		case c == '+' || c == '-' || c == '*' || c == '/' || c == '^' || c == '(' || c == ')':
			tokens = append(tokens, token{typ: tokOp, val: string(c)})
			i++
		default:
			return nil, fmt.Errorf("unexpected character %q at position %d", c, i)
		}
	}
	return tokens, nil
}

type parser struct {
	tokens []token
	pos    int
	vars   map[string]float64
}

func (p *parser) peek() (token, bool) {
	if p.pos < len(p.tokens) {
		return p.tokens[p.pos], true
	}
	return token{}, false
}

func (p *parser) next() (token, bool) {
	t, ok := p.peek()
	if ok {
		p.pos++
	}
	return t, ok
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t, ok := p.peek()
		if !ok || t.typ != tokOp || (t.val != "+" && t.val != "-") {
			break
		}
		p.pos++
		v2, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if t.val == "+" {
			v += v2
		} else {
			v -= v2
		}
	}
	return v, nil
}

func (p *parser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		t, ok := p.peek()
		if !ok || t.typ != tokOp || (t.val != "*" && t.val != "/") {
			break
		}
		p.pos++
		v2, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if t.val == "*" {
			v *= v2
		} else {
			if v2 == 0 {
				return 0, errors.New("division by zero")
			}
			v /= v2
		}
	}
	return v, nil
}

func (p *parser) parseFactor() (float64, error) {
	t, ok := p.peek()
	if !ok {
		return 0, errors.New("unexpected end of input")
	}
	if t.typ == tokOp && t.val == "-" {
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
	t, ok = p.peek()
	if ok && t.typ == tokOp && t.val == "^" {
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
	t, ok := p.next()
	if !ok {
		return 0, errors.New("unexpected end of input")
	}
	switch t.typ {
	case tokNum:
		v, err := strconv.ParseFloat(t.val, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid number: %s", t.val)
		}
		return v, nil
	case tokIdent:
		v, ok := p.vars[t.val]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", t.val)
		}
		return v, nil
	case tokOp:
		if t.val == "(" {
			v, err := p.parseExpr()
			if err != nil {
				return 0, err
			}
			t2, ok := p.next()
			if !ok || t2.typ != tokOp || t2.val != ")" {
				return 0, errors.New("expected closing parenthesis")
			}
			return v, nil
		}
		return 0, fmt.Errorf("unexpected token %q", t.val)
	}
	return 0, errors.New("unexpected token")
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	tokens, err := tokenize(s)
	if err != nil {
		return 0, err
	}
	if len(tokens) == 0 {
		return 0, errors.New("empty expression")
	}
	p := &parser{tokens: tokens, vars: vars}
	val, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.pos != len(p.tokens) {
		return 0, fmt.Errorf("unexpected trailing tokens starting at %q", p.tokens[p.pos].val)
	}
	return val, nil
}
