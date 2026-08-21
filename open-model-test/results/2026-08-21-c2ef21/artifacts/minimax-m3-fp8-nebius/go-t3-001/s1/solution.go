package expr

import (
	"fmt"
	"math"
	"strconv"
	"unicode"
)

type lexer struct {
	s   string
	pos int
}

func (l *lexer) skipSpace() {
	for l.pos < len(l.s) && unicode.IsSpace(rune(l.s[l.pos])) {
		l.pos++
	}
}

func (l *lexer) peek() byte {
	if l.pos >= len(l.s) {
		return 0
	}
	return l.s[l.pos]
}

func (l *lexer) next() byte {
	if l.pos >= len(l.s) {
		return 0
	}
	b := l.s[l.pos]
	l.pos++
	return b
}

func (l *lexer) parseNumber() (float64, error) {
	start := l.pos
	hasDot := false
	for l.pos < len(l.s) {
		c := l.s[l.pos]
		if c == '.' {
			if hasDot {
				return 0, fmt.Errorf("invalid number: multiple decimal points")
			}
			hasDot = true
			l.pos++
		} else if c >= '0' && c <= '9' {
			l.pos++
		} else {
			break
		}
	}
	if l.pos == start {
		return 0, fmt.Errorf("expected number")
	}
	numStr := l.s[start:l.pos]
	if numStr == "." {
		return 0, fmt.Errorf("invalid number: lone decimal point")
	}
	return strconv.ParseFloat(numStr, 64)
}

func (l *lexer) parseIdent() (string, error) {
	start := l.pos
	if l.pos >= len(l.s) {
		return "", fmt.Errorf("expected identifier")
	}
	c := l.s[l.pos]
	if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_') {
		return "", fmt.Errorf("invalid identifier character: %c", c)
	}
	l.pos++
	for l.pos < len(l.s) {
		c := l.s[l.pos]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			l.pos++
		} else {
			break
		}
	}
	return l.s[start:l.pos], nil
}

func parseExpr(l *lexer, vars map[string]float64) (float64, error) {
	l.skipSpace()
	left, err := parseTerm(l, vars)
	if err != nil {
		return 0, err
	}
	for {
		l.skipSpace()
		op := l.peek()
		if op != '+' && op != '-' {
			return left, nil
		}
		l.next()
		l.skipSpace()
		right, err := parseTerm(l, vars)
		if err != nil {
			return 0, err
		}
		if op == '+' {
			left = left + right
		} else {
			left = left - right
		}
	}
}

func parseTerm(l *lexer, vars map[string]float64) (float64, error) {
	l.skipSpace()
	left, err := parseFactor(l, vars)
	if err != nil {
		return 0, err
	}
	for {
		l.skipSpace()
		op := l.peek()
		if op != '*' && op != '/' {
			return left, nil
		}
		l.next()
		l.skipSpace()
		right, err := parseFactor(l, vars)
		if err != nil {
			return 0, err
		}
		if op == '*' {
			left = left * right
		} else {
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			left = left / right
		}
	}
}

func parseFactor(l *lexer, vars map[string]float64) (float64, error) {
	l.skipSpace()
	if l.peek() == '-' {
		l.next()
		l.skipSpace()
		v, err := parseFactor(l, vars)
		if err != nil {
			return 0, err
		}
		return -v, nil
	}
	if l.peek() == '+' {
		l.next()
		l.skipSpace()
		return parseFactor(l, vars)
	}
	left, err := parseBase(l, vars)
	if err != nil {
		return 0, err
	}
	l.skipSpace()
	if l.peek() == '^' {
		l.next()
		l.skipSpace()
		right, err := parseFactor(l, vars)
		if err != nil {
			return 0, err
		}
		return math.Pow(left, right), nil
	}
	return left, nil
}

func parseBase(l *lexer, vars map[string]float64) (float64, error) {
	l.skipSpace()
	if l.pos >= len(l.s) {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := l.peek()
	if c == '(' {
		l.next()
		l.skipSpace()
		v, err := parseExpr(l, vars)
		if err != nil {
			return 0, err
		}
		l.skipSpace()
		if l.peek() != ')' {
			return 0, fmt.Errorf("unbalanced parentheses: expected ')'")
		}
		l.next()
		return v, nil
	}
	if c == '.' {
		return 0, fmt.Errorf("invalid number: lone decimal point")
	}
	if c >= '0' && c <= '9' {
		return l.parseNumber()
	}
	if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' {
		name, err := l.parseIdent()
		if err != nil {
			return 0, err
		}
		v, ok := vars[name]
		if !ok {
			return 0, fmt.Errorf("unknown variable: %s", name)
		}
		return v, nil
	}
	return 0, fmt.Errorf("unexpected character: %c", c)
}

// Eval parses and evaluates s against the given variables.
func Eval(s string, vars map[string]float64) (float64, error) {
	l := &lexer{s: s}
	l.skipSpace()
	if l.pos >= len(l.s) {
		return 0, fmt.Errorf("empty expression")
	}
	v, err := parseExpr(l, vars)
	if err != nil {
		return 0, err
	}
	l.skipSpace()
	if l.pos != len(l.s) {
		return 0, fmt.Errorf("trailing tokens after expression")
	}
	return v, nil
}
