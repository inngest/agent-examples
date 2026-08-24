package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

type tokenKind int

const (
	tNum tokenKind = iota
	tIdent
	tPlus
	tMinus
	tMul
	tDiv
	tPow
	tLParen
	tRParen
)

type token struct {
	kind tokenKind
	text string
	num  float64
}

func isAlpha(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isAlnum(c byte) bool {
	return isAlpha(c) || isDigit(c)
}

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
					return nil, fmt.Errorf("invalid number literal at position %d", start)
				}
				for i < n && isDigit(s[i]) {
					i++
				}
			}
			numStr := s[start:i]
			val, err := strconv.ParseFloat(numStr, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid number literal: %s", numStr)
			}
			toks = append(toks, token{kind: tNum, num: val})
		case isAlpha(c):
			start := i
			i++
			for i < n && isAlnum(s[i]) {
				i++
			}
			toks = append(toks, token{kind: tIdent, text: s[start:i]})
		case c == '+':
			toks = append(toks, token{kind: tPlus})
			i++
		case c == '-':
			toks = append(toks, token{kind: tMinus})
			i++
		case c == '*':
			toks = append(toks, token{kind: tMul})
			i++
		case c == '/':
			toks = append(toks, token{kind: tDiv})
			i++
		case c == '^':
			toks = append(toks, token{kind: tPow})
			i++
		case c == '(':
			toks = append(toks, token{kind: tLParen})
			i++
		case c == ')':
			toks = append(toks, token{kind: tRParen})
			i++
		default:
			return nil, fmt.Errorf("unexpected character: %q", c)
		}
	}
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
	vars map[string]float64
}

func (p *parser) peek() *token {
	if p.pos < len(p.toks) {
		return &p.toks[p.pos]
	}
	return nil
}

func (p *parser) match(k tokenKind) bool {
	if p.pos < len(p.toks) && p.toks[p.pos].kind == k {
		p.pos++
		return true
	}
	return false
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		if p.match(tPlus) {
			v2, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v += v2
		} else if p.match(tMinus) {
			v2, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v -= v2
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
		if p.match(tMul) {
			v2, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			v *= v2
		} else if p.match(tDiv) {
			v2, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if v2 == 0 {
				return 0, errors.New("division by zero")
			}
			v /= v2
		} else {
			break
		}
	}
	return v, nil
}

func (p *parser) parseFactor() (float64, error) {
	if p.match(tMinus) {
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
	if p.match(tPow) {
		v2, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(v, v2), nil
	}
	return v, nil
}

func (p *parser) parseBase() (float64, error) {
	tok := p.peek()
	if tok == nil {
		return 0, errors.New("unexpected end of input")
	}
	switch tok.kind {
	case tNum:
		p.pos++
		return tok.num, nil
	case tIdent:
		p.pos++
		val, ok := p.vars[tok.text]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", tok.text)
		}
		return val, nil
	case tLParen:
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if !p.match(tRParen) {
			return 0, errors.New("expected ')'")
		}
		return v, nil
	default:
		return 0, fmt.Errorf("unexpected token")
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := tokenize(s)
	if err != nil {
		return 0, err
	}
	if vars == nil {
		vars = map[string]float64{}
	}
	p := &parser{toks: toks, vars: vars}
	val, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.pos != len(p.toks) {
		return 0, errors.New("unexpected trailing tokens")
	}
	return val, nil
}
