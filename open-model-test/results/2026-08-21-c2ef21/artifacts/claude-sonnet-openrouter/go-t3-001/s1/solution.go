package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

type tokKind int

const (
	tNUM tokKind = iota
	tIDENT
	tPLUS
	tMINUS
	tSTAR
	tSLASH
	tCARET
	tLPAREN
	tRPAREN
	tEOF
)

type token struct {
	kind tokKind
	text string
	num  float64
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func tokenize(s string) ([]token, error) {
	var toks []token
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case isDigit(c):
			start := i
			for i < n && isDigit(s[i]) {
				i++
			}
			if i < n && s[i] == '.' {
				if i+1 < n && isDigit(s[i+1]) {
					i++
					for i < n && isDigit(s[i]) {
						i++
					}
				} else {
					return nil, fmt.Errorf("invalid number literal at position %d", start)
				}
			}
			numStr := s[start:i]
			val, err := strconv.ParseFloat(numStr, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid number %q: %v", numStr, err)
			}
			toks = append(toks, token{kind: tNUM, num: val})
		case isLetter(c):
			start := i
			i++
			for i < n && (isLetter(s[i]) || isDigit(s[i])) {
				i++
			}
			toks = append(toks, token{kind: tIDENT, text: s[start:i]})
		case c == '+':
			toks = append(toks, token{kind: tPLUS})
			i++
		case c == '-':
			toks = append(toks, token{kind: tMINUS})
			i++
		case c == '*':
			toks = append(toks, token{kind: tSTAR})
			i++
		case c == '/':
			toks = append(toks, token{kind: tSLASH})
			i++
		case c == '^':
			toks = append(toks, token{kind: tCARET})
			i++
		case c == '(':
			toks = append(toks, token{kind: tLPAREN})
			i++
		case c == ')':
			toks = append(toks, token{kind: tRPAREN})
			i++
		default:
			return nil, fmt.Errorf("unexpected character %q at position %d", c, i)
		}
	}
	toks = append(toks, token{kind: tEOF})
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
		switch t.kind {
		case tPLUS:
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v += rhs
		case tMINUS:
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v -= rhs
		default:
			return v, nil
		}
	}
}

func (p *parser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		t := p.peek()
		switch t.kind {
		case tSTAR:
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			v *= rhs
		case tSLASH:
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if rhs == 0 {
				return 0, errors.New("division by zero")
			}
			v /= rhs
		default:
			return v, nil
		}
	}
}

func (p *parser) parseFactor() (float64, error) {
	if p.peek().kind == tMINUS {
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
	if p.peek().kind == tCARET {
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
	t := p.peek()
	switch t.kind {
	case tNUM:
		p.next()
		return t.num, nil
	case tIDENT:
		p.next()
		val, ok := p.vars[t.text]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", t.text)
		}
		return val, nil
	case tLPAREN:
		p.next()
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.peek().kind != tRPAREN {
			return 0, errors.New("expected closing parenthesis")
		}
		p.next()
		return v, nil
	default:
		return 0, errors.New("unexpected token, expected number, identifier, or '('")
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
	if p.peek().kind != tEOF {
		return 0, fmt.Errorf("unexpected trailing input at token position %d", p.pos)
	}
	return v, nil
}
