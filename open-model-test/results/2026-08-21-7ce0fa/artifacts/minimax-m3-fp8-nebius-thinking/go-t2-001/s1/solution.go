package ledger

import (
	"fmt"
)

type ledger struct {
	balances map[string]int64
	history  map[string][]Entry
}

func NewLedger(starting map[string]int64) Ledger {
	l := &ledger{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
	}
	for account, balance := range starting {
		l.balances[account] = balance
	}
	return l
}

func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	current := l.balances[e.Account]
	newBalance := current + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q", ErrInsufficient, e.Account)
	}
	l.balances[e.Account] = newBalance
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

func (l *ledger) Balance(account string) (int64, error) {
	balance, ok := l.balances[account]
	if !ok {
		return 0, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	return balance, nil
}

func (l *ledger) History(account string) ([]Entry, error) {
	if _, ok := l.balances[account]; !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	hist := l.history[account]
	result := make([]Entry, len(hist))
	copy(result, hist)
	return result, nil
}
