package expr

import (
	"fmt"
	"math"
	"strconv"
)

// token kinds:
// 'n' number, 'i' identifier, '+','-','*','/','^','(',')'
type token struct {
	kind byte
	text string
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isAlpha(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
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
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '+' || c == '-' || c == '*' || c == '/' || c == '^' || c == '(' || c == ')':
			toks = append(toks, token{kind: c})
			i++
		case isDigit(c):
			j := i
			for j < n && isDigit(s[j]) {
				j++
			}
			if j < n && s[j] == '.' {
				j++
				if !(j < n && isDigit(s[j])) {
					return nil, fmt.Errorf("invalid number literal near %d", i)
				}
				for j < n && isDigit(s[j]) {
					j++
				}
			}
			toks = append(toks, token{kind: 'n', text: s[i:j]})
			i = j
		case isAlpha(c):
			j := i
			for j < n && isAlnum(s[j]) {
				j++
			}
			toks = append(toks, token{kind: 'i', text: s[i:j]})
			i = j
		default:
			return nil, fmt.Errorf("unexpected character: %q", string(c))
		}
	}
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
	vars map[string]float64
}

func (p *parser) peek() (token, bool) {
	if p.pos < len(p.toks) {
		return p.toks[p.pos], true
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
	val, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t, ok := p.peek()
		if !ok || (t.kind != '+' && t.kind != '-') {
			break
		}
		p.next()
		rhs, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if t.kind == '+' {
			val += rhs
		} else {
			val -= rhs
		}
	}
	return val, nil
}

func (p *parser) parseTerm() (float64, error) {
	val, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		t, ok := p.peek()
		if !ok || (t.kind != '*' && t.kind != '/') {
			break
		}
		p.next()
		rhs, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if t.kind == '*' {
			val *= rhs
		} else {
			if rhs == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			val /= rhs
		}
	}
	return val, nil
}

func (p *parser) parseFactor() (float64, error) {
	if t, ok := p.peek(); ok && t.kind == '-' {
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
	if t, ok := p.peek(); ok && t.kind == '^' {
		p.next()
		rhs, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(v, rhs), nil
	}
	return v, nil
}

func (p *parser) parseBase() (float64, error) {
	t, ok := p.next()
	if !ok {
		return 0, fmt.Errorf("unexpected end of input")
	}
	switch t.kind {
	case 'n':
		val, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid number: %s", t.text)
		}
		return val, nil
	case 'i':
		if p.vars != nil {
			if val, ok := p.vars[t.text]; ok {
				return val, nil
			}
		}
		return 0, fmt.Errorf("unknown variable: %s", t.text)
	case '(':
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		ct, ok := p.next()
		if !ok || ct.kind != ')' {
			return 0, fmt.Errorf("expected closing parenthesis")
		}
		return v, nil
	default:
		return 0, fmt.Errorf("unexpected token: %q", string(t.kind))
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := tokenize(s)
	if err != nil {
		return 0, err
	}
	if len(toks) == 0 {
		return 0, fmt.Errorf("empty expression")
	}
	p := &parser{toks: toks, vars: vars}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.pos != len(p.toks) {
		return 0, fmt.Errorf("unexpected trailing tokens")
	}
	return v, nil
}
