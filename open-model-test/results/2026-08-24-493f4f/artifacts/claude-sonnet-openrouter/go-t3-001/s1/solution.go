package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode"
)

type tokenKind int

const (
	tokNum tokenKind = iota
	tokIdent
	tokOp
)

type token struct {
	kind tokenKind
	text string
	num  float64
}

// lex tokenizes the input string.
func lex(s string) ([]token, error) {
	var toks []token
	runes := []rune(s)
	i := 0
	n := len(runes)

	isDigit := func(r rune) bool { return r >= '0' && r <= '9' }
	isLetter := func(r rune) bool { return unicode.IsLetter(r) && r < 128 }

	for i < n {
		r := runes[i]
		if unicode.IsSpace(r) {
			i++
			continue
		}
		switch {
		case isDigit(r):
			start := i
			for i < n && isDigit(runes[i]) {
				i++
			}
			if i < n && runes[i] == '.' {
				i++
				if i >= n || !isDigit(runes[i]) {
					return nil, errors.New("invalid number literal")
				}
				for i < n && isDigit(runes[i]) {
					i++
				}
			}
			text := string(runes[start:i])
			val, err := strconv.ParseFloat(text, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid number literal: %s", text)
			}
			toks = append(toks, token{kind: tokNum, text: text, num: val})
		case isLetter(r):
			start := i
			i++
			for i < n && (isLetter(runes[i]) || isDigit(runes[i])) {
				i++
			}
			text := string(runes[start:i])
			toks = append(toks, token{kind: tokIdent, text: text})
		case r == '+' || r == '-' || r == '*' || r == '/' || r == '^' || r == '(' || r == ')':
			toks = append(toks, token{kind: tokOp, text: string(r)})
			i++
		default:
			return nil, fmt.Errorf("unexpected character: %q", r)
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
	if p.pos >= len(p.toks) {
		return nil
	}
	return &p.toks[p.pos]
}

func (p *parser) next() (token, error) {
	if p.pos >= len(p.toks) {
		return token{}, errors.New("unexpected end of input")
	}
	t := p.toks[p.pos]
	p.pos++
	return t, nil
}

func (p *parser) parseExpr() (float64, error) {
	val, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t := p.peek()
		if t == nil || t.kind != tokOp || (t.text != "+" && t.text != "-") {
			break
		}
		op := t.text
		p.pos++
		rhs, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if op == "+" {
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
		t := p.peek()
		if t == nil || t.kind != tokOp || (t.text != "*" && t.text != "/") {
			break
		}
		op := t.text
		p.pos++
		rhs, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if op == "*" {
			val *= rhs
		} else {
			if rhs == 0 {
				return 0, errors.New("division by zero")
			}
			val /= rhs
		}
	}
	return val, nil
}

func (p *parser) parseFactor() (float64, error) {
	t := p.peek()
	if t != nil && t.kind == tokOp && t.text == "-" {
		p.pos++
		val, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -val, nil
	}

	base, err := p.parseBase()
	if err != nil {
		return 0, err
	}

	t = p.peek()
	if t != nil && t.kind == tokOp && t.text == "^" {
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
	t, err := p.next()
	if err != nil {
		return 0, err
	}
	switch t.kind {
	case tokNum:
		return t.num, nil
	case tokIdent:
		v, ok := p.vars[t.text]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", t.text)
		}
		return v, nil
	case tokOp:
		if t.text == "(" {
			val, err := p.parseExpr()
			if err != nil {
				return 0, err
			}
			closeTok, err := p.next()
			if err != nil {
				return 0, errors.New("missing closing parenthesis")
			}
			if closeTok.kind != tokOp || closeTok.text != ")" {
				return 0, errors.New("expected closing parenthesis")
			}
			return val, nil
		}
		return 0, fmt.Errorf("unexpected token: %s", t.text)
	default:
		return 0, fmt.Errorf("unexpected token: %s", t.text)
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := lex(s)
	if err != nil {
		return 0, err
	}
	if len(toks) == 0 {
		return 0, errors.New("empty input")
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
		return 0, fmt.Errorf("trailing tokens starting at: %s", p.toks[p.pos].text)
	}
	return val, nil
}
