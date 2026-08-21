package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

type tokKind int

const (
	tokNum tokKind = iota
	tokIdent
	tokOp
	tokLParen
	tokRParen
	tokEOF
)

type token struct {
	kind tokKind
	str  string
	num  float64
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isAlpha(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

func tokenize(s string) ([]token, error) {
	var toks []token
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		switch {
		case isDigit(c):
			start := i
			for i < n && isDigit(s[i]) {
				i++
			}
			if i < n && s[i] == '.' {
				i++
				if i >= n || !isDigit(s[i]) {
					return nil, fmt.Errorf("invalid number at position %d", start)
				}
				for i < n && isDigit(s[i]) {
					i++
				}
			}
			numStr := s[start:i]
			val, err := strconv.ParseFloat(numStr, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid number %q", numStr)
			}
			toks = append(toks, token{kind: tokNum, num: val})
		case isAlpha(c):
			start := i
			for i < n && (isAlpha(s[i]) || isDigit(s[i])) {
				i++
			}
			toks = append(toks, token{kind: tokIdent, str: s[start:i]})
		case c == '+' || c == '-' || c == '*' || c == '/' || c == '^':
			toks = append(toks, token{kind: tokOp, str: string(c)})
			i++
		case c == '(':
			toks = append(toks, token{kind: tokLParen})
			i++
		case c == ')':
			toks = append(toks, token{kind: tokRParen})
			i++
		default:
			return nil, fmt.Errorf("unexpected character %q at position %d", c, i)
		}
	}
	toks = append(toks, token{kind: tokEOF})
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
	vars map[string]float64
}

func (p *parser) peek() token {
	return p.toks[p.pos]
}

func (p *parser) next() token {
	t := p.toks[p.pos]
	p.pos++
	return t
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t := p.peek()
		if t.kind == tokOp && (t.str == "+" || t.str == "-") {
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			if t.str == "+" {
				v += rhs
			} else {
				v -= rhs
			}
		} else {
			break
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
		if t.kind == tokOp && (t.str == "*" || t.str == "/") {
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if t.str == "*" {
				v *= rhs
			} else {
				if rhs == 0 {
					return 0, errors.New("division by zero")
				}
				v /= rhs
			}
		} else {
			break
		}
	}
	return v, nil
}

func (p *parser) parseFactor() (float64, error) {
	t := p.peek()
	if t.kind == tokOp && t.str == "-" {
		p.next()
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
	t = p.peek()
	if t.kind == tokOp && t.str == "^" {
		p.next()
		exp, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(base, exp), nil
	}
	return base, nil
}

func (p *parser) parseBase() (float64, error) {
	t := p.next()
	switch t.kind {
	case tokNum:
		return t.num, nil
	case tokIdent:
		val, ok := p.vars[t.str]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", t.str)
		}
		return val, nil
	case tokLParen:
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.peek().kind != tokRParen {
			return 0, errors.New("expected ')'")
		}
		p.next()
		return v, nil
	default:
		return 0, errors.New("unexpected token")
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := tokenize(s)
	if err != nil {
		return 0, err
	}
	p := &parser{toks: toks, vars: vars}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.peek().kind != tokEOF {
		return 0, errors.New("trailing tokens after expression")
	}
	return v, nil
}
