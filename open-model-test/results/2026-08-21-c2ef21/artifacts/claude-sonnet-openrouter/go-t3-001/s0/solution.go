package expr

import (
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
	tStar
	tSlash
	tCaret
	tLParen
	tRParen
	tEOF
)

type token struct {
	kind tokenKind
	val  string
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func tokenize(s string) ([]token, error) {
	var toks []token
	i, n := 0, len(s)
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
				i++
				start2 := i
				for i < n && isDigit(s[i]) {
					i++
				}
				if i == start2 {
					return nil, fmt.Errorf("invalid number literal near position %d", start)
				}
			}
			toks = append(toks, token{kind: tNum, val: s[start:i]})
		case isLetter(c):
			start := i
			i++
			for i < n && (isLetter(s[i]) || isDigit(s[i])) {
				i++
			}
			toks = append(toks, token{kind: tIdent, val: s[start:i]})
		case c == '+':
			toks = append(toks, token{kind: tPlus})
			i++
		case c == '-':
			toks = append(toks, token{kind: tMinus})
			i++
		case c == '*':
			toks = append(toks, token{kind: tStar})
			i++
		case c == '/':
			toks = append(toks, token{kind: tSlash})
			i++
		case c == '^':
			toks = append(toks, token{kind: tCaret})
			i++
		case c == '(':
			toks = append(toks, token{kind: tLParen})
			i++
		case c == ')':
			toks = append(toks, token{kind: tRParen})
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
		if t.kind == tPlus || t.kind == tMinus {
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			if t.kind == tPlus {
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
		if t.kind == tStar || t.kind == tSlash {
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if t.kind == tStar {
				v *= rhs
			} else {
				if rhs == 0 {
					return 0, fmt.Errorf("division by zero")
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
	if t.kind == tMinus {
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
	if p.peek().kind == tCaret {
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
	case tNum:
		v, err := strconv.ParseFloat(t.val, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid number %q", t.val)
		}
		return v, nil
	case tIdent:
		v, ok := p.vars[t.val]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", t.val)
		}
		return v, nil
	case tLParen:
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.peek().kind != tRParen {
			return 0, fmt.Errorf("expected ')'")
		}
		p.next()
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
	if len(toks) == 1 { // only EOF token => empty input
		return 0, fmt.Errorf("empty expression")
	}
	p := &parser{toks: toks, vars: vars}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.peek().kind != tEOF {
		return 0, fmt.Errorf("unexpected trailing tokens")
	}
	return v, nil
}
