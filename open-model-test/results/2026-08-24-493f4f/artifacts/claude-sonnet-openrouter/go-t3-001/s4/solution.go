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

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

func tokenize(s string) ([]token, error) {
	var tokens []token
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case isSpace(c):
			i++
		case c == '+' || c == '-' || c == '*' || c == '/' || c == '^' || c == '(' || c == ')':
			tokens = append(tokens, token{typ: tokOp, val: string(c)})
			i++
		case isDigit(c):
			start := i
			for i < n && isDigit(s[i]) {
				i++
			}
			if i < n && s[i] == '.' {
				i++
				if !(i < n && isDigit(s[i])) {
					return nil, errors.New("invalid number literal")
				}
				for i < n && isDigit(s[i]) {
					i++
				}
			}
			tokens = append(tokens, token{typ: tokNum, val: s[start:i]})
		case isLetter(c):
			start := i
			for i < n && (isLetter(s[i]) || isDigit(s[i])) {
				i++
			}
			tokens = append(tokens, token{typ: tokIdent, val: s[start:i]})
		default:
			return nil, fmt.Errorf("unexpected character: %c", c)
		}
	}
	return tokens, nil
}

type parser struct {
	tokens []token
	pos    int
	vars   map[string]float64
}

func (p *parser) peek() *token {
	if p.pos < len(p.tokens) {
		return &p.tokens[p.pos]
	}
	return nil
}

func (p *parser) next() *token {
	t := p.peek()
	if t != nil {
		p.pos++
	}
	return t
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t := p.peek()
		if t == nil || t.typ != tokOp || (t.val != "+" && t.val != "-") {
			break
		}
		p.next()
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
		t := p.peek()
		if t == nil || t.typ != tokOp || (t.val != "*" && t.val != "/") {
			break
		}
		p.next()
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
	t := p.peek()
	if t != nil && t.typ == tokOp && t.val == "-" {
		p.next()
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
	t = p.peek()
	if t != nil && t.typ == tokOp && t.val == "^" {
		p.next()
		v2, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(v, v2), nil
	}
	return v, nil
}

func (p *parser) parseBase() (float64, error) {
	t := p.next()
	if t == nil {
		return 0, errors.New("unexpected end of input")
	}
	switch t.typ {
	case tokNum:
		f, err := strconv.ParseFloat(t.val, 64)
		if err != nil {
			return 0, err
		}
		return f, nil
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
			t2 := p.next()
			if t2 == nil || t2.typ != tokOp || t2.val != ")" {
				return 0, errors.New("expected ')'")
			}
			return v, nil
		}
		return 0, fmt.Errorf("unexpected token: %s", t.val)
	default:
		return 0, fmt.Errorf("unexpected token: %s", t.val)
	}
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
	if vars == nil {
		vars = map[string]float64{}
	}
	p := &parser{tokens: tokens, vars: vars}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.pos != len(p.tokens) {
		return 0, fmt.Errorf("unexpected trailing tokens starting at: %s", p.tokens[p.pos].val)
	}
	return v, nil
}
