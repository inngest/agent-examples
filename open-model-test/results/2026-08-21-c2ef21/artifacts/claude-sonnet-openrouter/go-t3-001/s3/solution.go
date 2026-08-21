package expr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode"
)

type tokKind int

const (
	tokNum tokKind = iota
	tokIdent
	tokPlus
	tokMinus
	tokStar
	tokSlash
	tokCaret
	tokLParen
	tokRParen
	tokEOF
)

type token struct {
	kind tokKind
	val  string
}

func tokenize(s string) ([]token, error) {
	var toks []token
	runes := []rune(s)
	i := 0
	n := len(runes)

	for i < n {
		c := runes[i]

		if unicode.IsSpace(c) {
			i++
			continue
		}

		switch c {
		case '+':
			toks = append(toks, token{tokPlus, "+"})
			i++
			continue
		case '-':
			toks = append(toks, token{tokMinus, "-"})
			i++
			continue
		case '*':
			toks = append(toks, token{tokStar, "*"})
			i++
			continue
		case '/':
			toks = append(toks, token{tokSlash, "/"})
			i++
			continue
		case '^':
			toks = append(toks, token{tokCaret, "^"})
			i++
			continue
		case '(':
			toks = append(toks, token{tokLParen, "("})
			i++
			continue
		case ')':
			toks = append(toks, token{tokRParen, ")"})
			i++
			continue
		}

		if unicode.IsDigit(c) {
			start := i
			for i < n && unicode.IsDigit(runes[i]) {
				i++
			}
			if i < n && runes[i] == '.' {
				i++
				if i >= n || !unicode.IsDigit(runes[i]) {
					return nil, errors.New("invalid number literal")
				}
				for i < n && unicode.IsDigit(runes[i]) {
					i++
				}
			}
			toks = append(toks, token{tokNum, string(runes[start:i])})
			continue
		}

		if unicode.IsLetter(c) {
			start := i
			i++
			for i < n && (unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i])) {
				i++
			}
			toks = append(toks, token{tokIdent, string(runes[start:i])})
			continue
		}

		return nil, fmt.Errorf("unexpected character: %q", c)
	}

	toks = append(toks, token{tokEOF, ""})
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
	val, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		t := p.peek()
		if t.kind == tokPlus {
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			val += rhs
		} else if t.kind == tokMinus {
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			val -= rhs
		} else {
			break
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
		if t.kind == tokStar {
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			val *= rhs
		} else if t.kind == tokSlash {
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if rhs == 0 {
				return 0, errors.New("division by zero")
			}
			val /= rhs
		} else {
			break
		}
	}
	return val, nil
}

func (p *parser) parseFactor() (float64, error) {
	t := p.peek()
	if t.kind == tokMinus {
		p.next()
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

	if p.peek().kind == tokCaret {
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
	case tokLParen:
		val, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.peek().kind != tokRParen {
			return 0, errors.New("expected closing parenthesis")
		}
		p.next()
		return val, nil
	default:
		return 0, fmt.Errorf("unexpected token: %q", t.val)
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := tokenize(s)
	if err != nil {
		return 0, err
	}

	if len(toks) == 1 && toks[0].kind == tokEOF {
		return 0, errors.New("empty expression")
	}

	if vars == nil {
		vars = map[string]float64{}
	}

	p := &parser{toks: toks, vars: vars}
	val, err := p.parseExpr()
	if err != nil {
		return 0, err
	}

	if p.peek().kind != tokEOF {
		return 0, fmt.Errorf("unexpected trailing token: %q", p.peek().val)
	}

	return val, nil
}
