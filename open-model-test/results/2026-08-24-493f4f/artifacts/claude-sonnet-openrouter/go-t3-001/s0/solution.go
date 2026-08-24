package expr

import (
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
	text string
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

		if c >= '0' && c <= '9' {
			start := i
			for i < n && runes[i] >= '0' && runes[i] <= '9' {
				i++
			}
			if i < n && runes[i] == '.' {
				// must have at least one digit after '.'
				if i+1 < n && runes[i+1] >= '0' && runes[i+1] <= '9' {
					i++
					for i < n && runes[i] >= '0' && runes[i] <= '9' {
						i++
					}
				} else {
					return nil, fmt.Errorf("invalid number literal near position %d", start)
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

		return nil, fmt.Errorf("unexpected character %q at position %d", c, i)
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
	if p.pos < len(p.toks)-1 {
		p.pos++
	}
	return t
}

func (p *parser) parseExpr() (float64, error) {
	val, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		tk := p.peek()
		if tk.kind == tokPlus || tk.kind == tokMinus {
			p.next()
			rhs, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			if tk.kind == tokPlus {
				val += rhs
			} else {
				val -= rhs
			}
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
		tk := p.peek()
		if tk.kind == tokStar || tk.kind == tokSlash {
			p.next()
			rhs, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if tk.kind == tokStar {
				val *= rhs
			} else {
				if rhs == 0 {
					return 0, fmt.Errorf("division by zero")
				}
				val /= rhs
			}
		} else {
			break
		}
	}
	return val, nil
}

func (p *parser) parseFactor() (float64, error) {
	tk := p.peek()
	if tk.kind == tokMinus {
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
	tk := p.peek()
	switch tk.kind {
	case tokNum:
		p.next()
		v, err := strconv.ParseFloat(tk.text, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid number %q: %v", tk.text, err)
		}
		return v, nil
	case tokIdent:
		p.next()
		v, ok := p.vars[tk.text]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", tk.text)
		}
		return v, nil
	case tokLParen:
		p.next()
		val, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.peek().kind != tokRParen {
			return 0, fmt.Errorf("expected ')'")
		}
		p.next()
		return val, nil
	default:
		return 0, fmt.Errorf("unexpected token %q", tk.text)
	}
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	toks, err := tokenize(s)
	if err != nil {
		return 0, err
	}
	if len(toks) == 1 && toks[0].kind == tokEOF {
		return 0, fmt.Errorf("empty expression")
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
		return 0, fmt.Errorf("unexpected trailing token %q", p.peek().text)
	}
	return val, nil
}
