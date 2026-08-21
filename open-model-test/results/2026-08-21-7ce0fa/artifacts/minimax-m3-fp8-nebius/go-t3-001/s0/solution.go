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
	p.next()
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.tok.kind != tokEOF {
		return 0, fmt.Errorf("unexpected token %q at position %d", p.tok.lit, p.pos)
	}
	return v, nil
}

type tokenKind int

const (
	tokEOF tokenKind = iota
	tokNumber
	tokIdent
	tokOp
	tokLParen
	tokRParen
)

type token struct {
	kind tokenKind
	lit  string
	val  float64
}

type parser struct {
	s    string
	pos  int
	tok  token
	vars map[string]float64
}

func (p *parser) next() {
	p.skipSpace()
	if p.pos >= len(p.s) {
		p.tok = token{kind: tokEOF}
		return
	}
	c := p.s[p.pos]
	switch {
	case c == '(':
		p.tok = token{kind: tokLParen, lit: "("}
		p.pos++
		return
	case c == ')':
		p.tok = token{kind: tokRParen, lit: ")"}
		p.pos++
		return
	case isIdentStart(c):
		start := p.pos
		p.pos++
		for p.pos < len(p.s) && isIdentPart(p.s[p.pos]) {
			p.pos++
		}
		p.tok = token{kind: tokIdent, lit: p.s[start:p.pos]}
		return
	case isDigit(c) || (c == '.' && p.pos+1 < len(p.s) && isDigit(p.s[p.pos+1])):
		start := p.pos
		p.pos++
		seenDot := c == '.'
		for p.pos < len(p.s) {
			c2 := p.s[p.pos]
			if isDigit(c2) {
				p.pos++
				continue
			}
			if c2 == '.' {
				if seenDot {
					p.tok = token{kind: tokNumber, lit: p.s[start:p.pos]}
					return
				}
				seenDot = true
				p.pos++
				continue
			}
			break
		}
		lit := p.s[start:p.pos]
		v, err := strconv.ParseFloat(lit, 64)
		if err != nil {
			p.tok = token{kind: tokNumber, lit: lit}
			return
		}
		p.tok = token{kind: tokNumber, lit: lit, val: v}
		return
	case c == '+' || c == '-' || c == '*' || c == '/' || c == '^':
		p.tok = token{kind: tokOp, lit: string(c)}
		p.pos++
		return
	default:
		p.tok = token{kind: tokOp, lit: string(c)}
		p.pos++
		return
	}
}

func (p *parser) skipSpace() {
	for p.pos < len(p.s) && unicode.IsSpace(rune(p.s[p.pos])) {
		p.pos++
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isIdentStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || isDigit(c)
}

func (p *parser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		switch p.tok.kind {
		case tokOp:
			switch p.tok.lit {
			case "+", "-":
				op := p.tok.lit
				p.next()
				r, err := p.parseTerm()
				if err != nil {
					return 0, err
				}
				if op == "+" {
					v += r
				} else {
					v -= r
				}
			default:
				return v, nil
			}
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
		if p.tok.kind != tokOp {
			return v, nil
		}
		switch p.tok.lit {
		case "*", "/":
			op := p.tok.lit
			p.next()
			r, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if op == "*" {
				v *= r
			} else {
				if r == 0 {
					return 0, fmt.Errorf("division by zero")
				}
				v /= r
			}
		default:
			return v, nil
		}
	}
}

func (p *parser) parseFactor() (float64, error) {
	if p.tok.kind == tokOp && p.tok.lit == "-" {
		p.next()
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	if p.tok.kind == tokOp && p.tok.lit == "+" {
		p.next()
		return p.parseFactor()
	}
	v, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	if p.tok.kind == tokOp && p.tok.lit == "^" {
		p.next()
		r, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		v = math.Pow(v, r)
	}
	return v, nil
}

func (p *parser) parseBase() (float64, error) {
	switch p.tok.kind {
	case tokNumber:
		v := p.tok.val
		p.next()
		return v, nil
	case tokIdent:
		name := p.tok.lit
		p.next()
		val, ok := p.vars[name]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", name)
		}
		return val, nil
	case tokLParen:
		p.next()
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.tok.kind != tokRParen {
			return 0, fmt.Errorf("unbalanced parenthesis")
		}
		p.next()
		return v, nil
	case tokEOF:
		return 0, fmt.Errorf("unexpected end of expression")
	default:
		return 0, fmt.Errorf("unexpected token %q", p.tok.lit)
	}
}
