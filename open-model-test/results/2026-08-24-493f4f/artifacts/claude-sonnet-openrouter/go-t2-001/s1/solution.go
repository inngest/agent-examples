package ledger

import "fmt"

type memLedger struct {
	balances map[string]int64
	history  map[string][]Entry
	known    map[string]bool
}

// NewLedger creates a new Ledger seeded with starting balances.
func NewLedger(starting map[string]int64) Ledger {
	l := &memLedger{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
		known:    make(map[string]bool),
	}
	for acct, bal := range starting {
		l.balances[acct] = bal
		l.known[acct] = true
	}
	return l
}

func (l *memLedger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	newBal := l.balances[e.Account] + e.Amount
	if newBal < 0 {
		return fmt.Errorf("record %+v: %w", e, ErrInsufficient)
	}
	l.balances[e.Account] = newBal
	l.known[e.Account] = true
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

func (l *memLedger) Balance(account string) (int64, error) {
	if !l.known[account] {
		return 0, ErrUnknownAccount
	}
	return l.balances[account], nil
}

func (l *memLedger) History(account string) ([]Entry, error) {
	if !l.known[account] {
		return nil, ErrUnknownAccount
	}
	src := l.history[account]
	out := make([]Entry, len(src))
	copy(out, src)
	return out, nil
}
