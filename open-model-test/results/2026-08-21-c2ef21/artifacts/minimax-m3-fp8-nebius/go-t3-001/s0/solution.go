package expr

import (
	"fmt"
	"math"
	"strconv"
	"unicode"
)

type tokenKind int

const (
	tkNum tokenKind = iota
	tkIdent
	tkPlus
	tkMinus
	tkStar
	tkSlash
	tkCaret
	tkLParen
	tkRParen
	tkEOF
)

type token struct {
	kind tokenKind
	text string
	num  float64
	pos  int
}

type lexer struct {
	src string
	pos int
}

func (l *lexer) peek() (rune, bool) {
	if l.pos >= len(l.src) {
		return 0, false
	}
	r := rune(l.src[l.pos])
	if r > 127 {
		return 0, false
	}
	return r, true
}

func (l *lexer) skipSpace() {
	for {
		r, ok := l.peek()
		if !ok {
			return
		}
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			l.pos++
			continue
		}
		return
	}
}

func (l *lexer) next() (token, error) {
	l.skipSpace()
	start := l.pos
	r, ok := l.peek()
	if !ok {
		return token{kind: tkEOF, pos: start}, nil
	}
	switch r {
	case '+':
		l.pos++
		return token{kind: tkPlus, text: "+", pos: start}, nil
	case '-':
		l.pos++
		return token{kind: tkMinus, text: "-", pos: start}, nil
	case '*':
		l.pos++
		return token{kind: tkStar, text: "*", pos: start}, nil
	case '/':
		l.pos++
		return token{kind: tkSlash, text: "/", pos: start}, nil
	case '^':
		l.pos++
		return token{kind: tkCaret, text: "^", pos: start}, nil
	case '(':
		l.pos++
		return token{kind: tkLParen, text: "(", pos: start}, nil
	case ')':
		l.pos++
		return token{kind: tkRParen, text: ")", pos: start}, nil
	}
	if r == '.' {
		return token{}, fmt.Errorf("unexpected '.' at position %d", start)
	}
	if unicode.IsDigit(r) {
		return l.readNumber()
	}
	if isLetter(r) {
		return l.readIdent()
	}
	return token{}, fmt.Errorf("unexpected character %q at position %d", r, start)
}

func (l *lexer) readNumber() (token, error) {
	start := l.pos
	hasDot := false
	for {
		r, ok := l.peek()
		if !ok {
			break
		}
		if unicode.IsDigit(r) {
			l.pos++
			continue
		}
		if r == '.' && !hasDot {
			hasDot = true
			l.pos++
			continue
		}
		break
	}
	text := l.src[start:l.pos]
	if hasDot {
		last := len(text) - 1
		if last >= 0 && text[last] == '.' {
			return token{}, fmt.Errorf("invalid number %q at position %d", text, start)
		}
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return token{}, fmt.Errorf("invalid number %q at position %d", text, start)
	}
	return token{kind: tkNum, text: text, num: n, pos: start}, nil
}

func (l *lexer) readIdent() (token, error) {
	start := l.pos
	for {
		r, ok := l.peek()
		if !ok {
			break
		}
		if isLetter(r) || unicode.IsDigit(r) {
			l.pos++
			continue
		}
		break
	}
	return token{kind: tkIdent, text: l.src[start:l.pos], pos: start}, nil
}

func isLetter(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
}

type parser struct {
	lex  *lexer
	cur  token
	vars map[string]float64
}

func newParser(s string, vars map[string]float64) (*parser, error) {
	p := &parser{lex: &lexer{src: s}, vars: vars}
	tok, err := p.lex.next()
	if err != nil {
		return nil, err
	}
	p.cur = tok
	return p, nil
}

func (p *parser) advance() error {
	tok, err := p.lex.next()
	if err != nil {
		return err
	}
	p.cur = tok
	return nil
}

func (p *parser) expect(k tokenKind) (token, error) {
	if p.cur.kind != k {
		return p.cur, fmt.Errorf("unexpected token %q at position %d", p.cur.text, p.cur.pos)
	}
	t := p.cur
	err := p.advance()
	return t, err
}

func Eval(s string, vars map[string]float64) (float64, error) {
	p, err := newParser(s, vars)
	if err != nil {
		return 0, err
	}
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.cur.kind != tkEOF {
		return 0, fmt.Errorf("unexpected trailing token %q at position %d", p.cur.text, p.cur.pos)
	}
	return v, nil
}

func (p *parser) parseExpr() (float64, error) {
	left, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		switch p.cur.kind {
		case tkPlus, tkMinus:
			op := p.cur.kind
			if err := p.advance(); err != nil {
				return 0, err
			}
			right, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			if op == tkPlus {
				left = left + right
			} else {
				left = left - right
			}
		default:
			return left, nil
		}
	}
}

func (p *parser) parseTerm() (float64, error) {
	left, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		switch p.cur.kind {
		case tkStar, tkSlash:
			op := p.cur.kind
			if err := p.advance(); err != nil {
				return 0, err
			}
			right, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if op == tkStar {
				left = left * right
			} else {
				if right == 0 {
					return 0, fmt.Errorf("division by zero")
				}
				left = left / right
			}
		default:
			return left, nil
		}
	}
}

func (p *parser) parseFactor() (float64, error) {
	if p.cur.kind == tkMinus {
		if err := p.advance(); err != nil {
			return 0, err
		}
		v, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	if p.cur.kind == tkPlus {
		if err := p.advance(); err != nil {
			return 0, err
		}
		return p.parseFactor()
	}
	left, err := p.parseBase()
	if err != nil {
		return 0, err
	}
	if p.cur.kind == tkCaret {
		if err := p.advance(); err != nil {
			return 0, err
		}
		right, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		left = math.Pow(left, right)
	}
	return left, nil
}

func (p *parser) parseBase() (float64, error) {
	switch p.cur.kind {
	case tkNum:
		v := p.cur.num
		if err := p.advance(); err != nil {
			return 0, err
		}
		return v, nil
	case tkIdent:
		name := p.cur.text
		if err := p.advance(); err != nil {
			return 0, err
		}
		v, ok := p.vars[name]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", name)
		}
		return v, nil
	case tkLParen:
		if err := p.advance(); err != nil {
			return 0, err
		}
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.cur.kind != tkRParen {
			return 0, fmt.Errorf("expected ')' at position %d", p.cur.pos)
		}
		if err := p.advance(); err != nil {
			return 0, err
		}
		return v, nil
	}
	return 0, fmt.Errorf("unexpected token %q at position %d", p.cur.text, p.cur.pos)
}
