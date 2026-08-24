package ledger

import "fmt"

type memLedger struct {
	balances map[string]int64
	history  map[string][]Entry
	known    map[string]bool
}

// NewLedger creates a new Ledger with the given starting balances.
func NewLedger(starting map[string]int64) Ledger {
	l := &memLedger{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
		known:    make(map[string]bool),
	}
	for acct, amt := range starting {
		l.balances[acct] = amt
		l.known[acct] = true
	}
	return l
}

func (l *memLedger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	bal := l.balances[e.Account]
	newBal := bal + e.Amount
	if newBal < 0 {
		return fmt.Errorf("ledger: record %+v: %w", e, ErrInsufficient)
	}
	l.balances[e.Account] = newBal
	l.known[e.Account] = true
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

func (l *memLedger) Balance(account string) (int64, error) {
	if !l.known[account] {
		return 0, fmt.Errorf("ledger: balance %q: %w", account, ErrUnknownAccount)
	}
	return l.balances[account], nil
}

func (l *memLedger) History(account string) ([]Entry, error) {
	if !l.known[account] {
		return nil, fmt.Errorf("ledger: history %q: %w", account, ErrUnknownAccount)
	}
	src := l.history[account]
	out := make([]Entry, len(src))
	copy(out, src)
	return out, nil
}
