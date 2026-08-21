package ledger

import "fmt"

type simpleLedger struct {
	balances map[string]int64
	known    map[string]bool
	history  map[string][]Entry
}

// NewLedger creates a new Ledger, seeded with the given starting balances.
func NewLedger(starting map[string]int64) Ledger {
	l := &simpleLedger{
		balances: make(map[string]int64),
		known:    make(map[string]bool),
		history:  make(map[string][]Entry),
	}
	for acct, bal := range starting {
		l.balances[acct] = bal
		l.known[acct] = true
	}
	return l
}

func (l *simpleLedger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	bal := l.balances[e.Account]
	newBal := bal + e.Amount
	if newBal < 0 {
		return fmt.Errorf("cannot withdraw %d from account %q with balance %d: %w", -e.Amount, e.Account, bal, ErrInsufficient)
	}
	l.balances[e.Account] = newBal
	l.known[e.Account] = true
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

func (l *simpleLedger) Balance(account string) (int64, error) {
	if !l.known[account] {
		return 0, fmt.Errorf("account %q: %w", account, ErrUnknownAccount)
	}
	return l.balances[account], nil
}

func (l *simpleLedger) History(account string) ([]Entry, error) {
	if !l.known[account] {
		return nil, fmt.Errorf("account %q: %w", account, ErrUnknownAccount)
	}
	src := l.history[account]
	out := make([]Entry, len(src))
	copy(out, src)
	return out, nil
}
